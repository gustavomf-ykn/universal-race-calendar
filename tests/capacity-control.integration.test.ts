import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prisma,
  assertCapacity,
  CapacityDeferred,
  deferCapacityTask,
  controlCapacity,
  setTaskLease,
  assertTaskLease,
  readCapacity,
} from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";

const owner = "capacity-test-" + randomUUID();
const allocation = {
  databaseBudgetBytes: "1000000000000",
  storageBudgetBytes: "1000000000000",
  databaseHeadroomBytes: "16777216",
  storageHeadroomBytes: "1048576",
  allocationConfirmed: true as const,
  reason: "isolated synthetic allocation",
};
describe.skipIf(!process.env.DATABASE_URL)("shared capacity barrier in disposable PostgreSQL", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = "test-internal-key";
    app = await buildApp();
  });
  beforeEach(async () => {
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.adminAudit.deleteMany({ where: { actorId: owner } });
    await prisma.$executeRaw`UPDATE "CatalogCapacity" SET "confirmedAt"=now(),"databaseBudgetBytes"=1000000000000,"storageBudgetBytes"=1000000000000 WHERE id=1`;
    await prisma.$executeRaw`DELETE FROM storage.objects WHERE id LIKE ${owner + "%"}`;
    await prisma.capacityReservation.deleteMany({ where: { task: { ownerId: owner } } });
  });
  afterAll(async () => {
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.adminAudit.deleteMany({ where: { actorId: owner } });
    await prisma.$executeRaw`DELETE FROM storage.objects WHERE id LIKE ${owner + "%"}`;
    await prisma.$executeRaw`UPDATE "CatalogCapacity" SET "confirmedAt"=now(),"databaseBudgetBytes"=1000000000000,"storageBudgetBytes"=1000000000000 WHERE id=1`;
    await app?.close();
  });
  const task = (suffix: string) =>
    prisma.collectionTask.create({
      data: {
        ownerId: owner,
        source: "openresults",
        kind: "inspect",
        idempotencyKey: suffix,
        requestHash: suffix,
        payload: {},
        status: "running",
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 90000),
        attempt: 1,
        progress: { checkpoint: { page: 7 }, processed: 10 },
      },
    });
  it("retains checkpoints without spending an attempt when allocation is missing, and rejects stale executors", async () => {
    const current = await task("unconfigured");
    await prisma.$executeRaw`UPDATE "CatalogCapacity" SET "confirmedAt"=NULL WHERE id=1`;
    await expect(assertCapacity()).rejects.toMatchObject({ reason: "capacity_unconfigured" });
    expect(await deferCapacityTask(current, { stage: "starting" }, new CapacityDeferred("capacity_unconfigured"))).toBe(
      true,
    );
    const held = await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } });
    expect(held).toMatchObject({
      status: "queued",
      attempt: 0,
      executionHold: true,
      holdReason: "capacity_wait",
      leaseToken: null,
    });
    expect(held.progress).toMatchObject({
      checkpoint: { page: 7 },
      processed: 10,
      capacityResource: "database",
      stage: "capacity_wait",
    });
    expect(await deferCapacityTask(current, { processed: 999 }, new CapacityDeferred("capacity_database_limit"))).toBe(
      false,
    );
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } })).progress).toEqual(
      held.progress,
    );
  });
  it("rejects a growing fenced transaction before modifying its existing data", async () => {
    const current = await task("rollback");
    setTaskLease(current);
    await expect(
      prisma.$transaction(async (tx) => {
        await assertTaskLease(tx, 1000000000000);
        await tx.collectionTask.update({ where: { id: current.id }, data: { progress: { overwritten: true } } });
      }),
    ).rejects.toMatchObject({ reason: "capacity_database_limit" });
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } })).progress).toMatchObject({
      checkpoint: { page: 7 },
    });
    await prisma.collectionTask.update({ where: { id: current.id }, data: { leaseToken: "replacement" } });
    await expect(prisma.$transaction((tx) => assertTaskLease(tx))).rejects.toThrow("lease_lost");
  });
  it("the real selective TypeScript executor holds work before discovery when allocation is missing", async () => {
    const current = await task("typescript-process");
    await prisma.collectionTask.update({
      where: { id: current.id },
      data: {
        source: "ticketsports",
        kind: "catalog-sync",
        status: "queued",
        leaseToken: null,
        leaseUntil: null,
        attempt: 0,
      },
    });
    await prisma.$executeRaw`UPDATE "CatalogCapacity" SET "confirmedAt"=NULL WHERE id=1`;
    const folder = mkdtempSync(join(tmpdir(), "race-capacity-worker-"));
    const selection = join(folder, "selection.json");
    writeFileSync(selection, JSON.stringify([current.id]));
    try {
      const output = execFileSync(process.execPath, ["apps/worker/dist/apps/worker/src/queue.js"], {
        windowsHide: true,
        timeout: 25000,
        encoding: "utf8",
        env: {
          ...process.env,
          WORKER_MODE: "batch",
          WORKER_MAX_TASKS: "1",
          WORKER_MAX_SECONDS: "20",
          WORKER_TASK_SELECTION_FILE: selection,
          WORKER_STOP_FILE: "",
          WORKER_REPORT_PATH: "",
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
          SUPABASE_SERVICE_ROLE_KEY: "",
        },
      });
      expect(output).toContain(`Calendar task ${current.id}: queued.`);
      expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({
        status: "queued",
        executionHold: true,
        attempt: 0,
        errorCode: "capacity_unconfigured",
        progress: { stage: "capacity_wait", checkpoint: { page: 7 } },
      });
    } finally {
      unlinkSync(selection);
      rmdirSync(folder);
    }
  });
  it("serializes competing uploads and retains a reservation until publication or expiry", async () => {
    const first = await task("upload-a"),
      second = await task("upload-b");
    await prisma.$executeRaw`UPDATE "CatalogCapacity" SET "storageBudgetBytes"=1048727 WHERE id=1`;
    const reserve = (current: typeof first) =>
      prisma.$queryRaw<
        Array<{ decision: string }>
      >`SELECT check_catalog_capacity('storage',100,${current.id},${current.leaseToken}) AS decision`;
    expect(
      (await Promise.all([reserve(first), reserve(second)]))
        .flat()
        .map((row) => row.decision)
        .sort(),
    ).toEqual(["allowed", "capacity_storage_limit"]);
    const reservation = await prisma.capacityReservation.findFirstOrThrow({ where: { task: { ownerId: owner } } });
    expect(reservation.bytes).toBe(100n);
    expect(await readCapacity()).toMatchObject({ reservedStorageBytes: "100" });
    const reserved = reservation.taskId === first.id ? first : second;
    expect((await reserve(reserved))[0].decision).toBe("allowed"); // same lease is not charged twice
    await prisma.capacityReservation.update({
      where: { taskId_leaseToken: { taskId: reservation.taskId, leaseToken: reservation.leaseToken } },
      data: { expiresAt: new Date(0) },
    });
    expect((await reserve(reservation.taskId === first.id ? second : first))[0].decision).toBe("allowed");
  });
  it("treats unmeasurable Storage as unknown without blocking database-only work", async () => {
    await prisma.$executeRaw`INSERT INTO storage.objects(id,metadata) VALUES(${owner},'{}'::jsonb)`;
    expect(
      (await prisma.$queryRaw<Array<{ decision: string }>>`SELECT check_catalog_capacity('storage') AS decision`)[0]
        .decision,
    ).toBe("capacity_measurement_unavailable");
    const snapshot = await prisma.catalogCapacity.findUniqueOrThrow({ where: { id: 1 } });
    expect(snapshot.storageBytes).toBeNull();
    expect(snapshot.storageMeasuredAt).toBeNull();
    await expect(assertCapacity()).resolves.toBeUndefined();
  });
  it("requires explicit resume, preserves other holds, and old replay cannot release newly held work", async () => {
    const waiting = await task("resume"),
      protectedTask = await task("protected");
    await deferCapacityTask(waiting, {}, new CapacityDeferred("capacity_database_limit"));
    await prisma.collectionTask.update({
      where: { id: protectedTask.id },
      data: {
        status: "queued",
        executionHold: true,
        holdReason: "protected_prior_request",
        leaseToken: null,
        leaseUntil: null,
      },
    });
    await controlCapacity(owner, "configure", "configure", allocation);
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: waiting.id } })).executionHold).toBe(true);
    const result = await controlCapacity(owner, "resume", "resume", {
      reason: "capacity checked",
      resource: "database",
    });
    expect(result).toMatchObject({ released: 1 });
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: protectedTask.id } })).executionHold).toBe(
      true,
    );
    await prisma.collectionTask.update({
      where: { id: waiting.id },
      data: { executionHold: true, holdReason: "capacity_wait" },
    });
    expect(
      await controlCapacity(owner, "resume", "resume", { reason: "capacity checked", resource: "database" }),
    ).toEqual(result);
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: waiting.id } })).executionHold).toBe(true);
    await expect(
      controlCapacity(owner, "resume", "resume", { reason: "other payload", resource: "storage" }),
    ).rejects.toThrow("idempotency_conflict");
  });
  it("protects administrative routes and validates allocations without trusting provider quota", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/admin/capacity" })).statusCode).toBe(401);
    const headers = { "x-api-key": "test-internal-key", "idempotency-key": owner };
    const response = await app.inject({ method: "GET", url: "/v1/admin/capacity", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().providerQuotaVerified).toBe(false);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/admin/capacity/configure",
      headers,
      payload: { ...allocation, allocationConfirmed: false },
    });
    expect(invalid.statusCode).toBe(400);
    const low = await app.inject({
      method: "POST",
      url: "/v1/admin/capacity/configure",
      headers,
      payload: { ...allocation, databaseHeadroomBytes: "1" },
    });
    expect(low.statusCode).toBe(409);
  });
});
