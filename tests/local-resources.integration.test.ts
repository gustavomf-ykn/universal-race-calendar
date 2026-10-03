import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  prisma,
  deferLocalResourceTask,
  LocalResourceDeferred,
  heartbeatTask,
  finishTask,
  workerPresence,
  listWorkers,
} from "@race-calendar/database";
import { assessLocalResources } from "../packages/utils/src/local-resources.js";
import { buildApp } from "../apps/api/src/app.js";

const owner = "local-resource-" + randomUUID();
const invoke = promisify(execFile);
const snapshot = assessLocalResources({ memoryAvailableBytes: 0, tempFreeBytes: 2147483648, rssBytes: 134217728 });
describe.skipIf(!process.env.DATABASE_URL)("durable local resource protection", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    process.env.INTERNAL_API_KEY = "test-internal-key";
  });
  afterEach(async () => {
    const tasks = await prisma.collectionTask.findMany({ where: { ownerId: owner }, select: { id: true } });
    await prisma.adminAudit.deleteMany({ where: { taskId: { in: tasks.map((t) => t.id) } } });
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.resultSet.deleteMany({ where: { eventId: owner } });
    await prisma.event.deleteMany({ where: { id: owner } });
    await prisma.$executeRaw`DELETE FROM "WorkerPresence" WHERE version=${owner} OR id=${owner}`;
  });
  async function task(running = true, source = "openresults") {
    const key = randomUUID();
    return prisma.collectionTask.create({
      data: {
        ownerId: owner,
        source,
        kind: source === "maintenance" ? "curate-event" : "extract",
        idempotencyKey: key,
        requestHash: key,
        payload: {},
        status: running ? "running" : "queued",
        attempt: running ? 1 : 0,
        leaseToken: running ? randomUUID() : null,
        leaseUntil: running ? new Date(Date.now() + 90000) : null,
        progress: { checkpoint: { page: 7 }, processed: 10 },
      },
    });
  }
  it("keeps resource deferral inaccessible to public and Supabase client roles", async () => {
    const grants = await prisma.$queryRaw<Array<{ publicExecute: boolean; clientExecute: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p,
          LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid='defer_local_resource_task(text,text,jsonb,text)'::regprocedure
          AND a.grantee=0 AND a.privilege_type='EXECUTE'
      ) AS "publicExecute",
      EXISTS (
        SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated')
          AND has_function_privilege(r.oid,'defer_local_resource_task(text,text,jsonb,text)','EXECUTE')
      ) AS "clientExecute"`;
    expect(grants).toEqual([{ publicExecute: false, clientExecute: false }]);
  });
  it("retains persisted checkpoint counters and valid results without spending an attempt; old token cannot overwrite", async () => {
    await prisma.event.create({
      data: {
        id: owner,
        name: "Prova sintética",
        slug: owner,
        canonicalFingerprint: owner,
        warnings: [],
        publishabilityReasons: [],
      },
    });
    const results = await prisma.resultSet.create({
      data: {
        eventId: owner,
        source: "openresults",
        externalId: owner,
        sourceUrl: "https://openresults.run/evento/synthetic/",
        contentHash: "synthetic",
        count: 1,
        results: { create: { recordKey: "row", name: "Participante sintético", modality: "5 km", time: "00:25:00" } },
      },
      include: { results: true },
    });
    const current = await task();
    expect(await deferLocalResourceTask(current, { stage: "starting" }, new LocalResourceDeferred(snapshot))).toBe(
      true,
    );
    const held = await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } });
    expect(held).toMatchObject({
      status: "queued",
      attempt: 0,
      executionHold: true,
      holdReason: "local_resource_wait",
      errorCode: "local_memory_limit",
      leaseToken: null,
    });
    expect(held.progress).toMatchObject({
      checkpoint: { page: 7 },
      processed: 10,
      stage: "local_resource_wait",
      localResources: snapshot,
    });
    expect(await deferLocalResourceTask(current, { processed: 999 }, new LocalResourceDeferred(snapshot))).toBe(false);
    expect(await heartbeatTask(current, { processed: 999 })).toBe(false);
    expect(await finishTask(current, "completed", {})).toBe(false);
    expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } })).toEqual(held);
    expect(await prisma.resultSet.findUniqueOrThrow({ where: { id: results.id }, include: { results: true } })).toEqual(
      results,
    );
  });
  it("does not retain or change an expired lease and rejects unknown resource reasons", async () => {
    const current = await task();
    await prisma.collectionTask.update({ where: { id: current.id }, data: { leaseUntil: new Date(0) } });
    const before = await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } });
    expect(await deferLocalResourceTask(current, {}, new LocalResourceDeferred(snapshot))).toBe(false);
    expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } })).toEqual(before);
    await expect(
      prisma.$queryRaw`SELECT defer_local_resource_task(${current.id},${current.leaseToken},'{}'::jsonb,'untrusted')`,
    ).rejects.toThrow("local_resource_control_invalid");
  });
  it("requires admin to release a retained request, audits the prior reason and returns sanitized executor availability", async () => {
    const current = await task();
    await deferLocalResourceTask(current, {}, new LocalResourceDeferred(snapshot));
    await workerPresence(owner, "resource_wait", null, snapshot);
    expect((await listWorkers()).find((w) => w.id === owner)).toMatchObject({
      state: "resource_wait",
      resources: snapshot,
    });
    const app = await buildApp();
    try {
      const request = {
        method: "POST" as const,
        url: `/v1/tasks/${current.id}/hold`,
        payload: { hold: false, reason: "Recursos locais revisados" },
      };
      expect((await app.inject(request)).statusCode).toBe(401);
      expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: current.id } })).executionHold).toBe(true);
      const released = await app.inject({ ...request, headers: { "x-api-key": "test-internal-key" } });
      expect(released.statusCode).toBe(200);
      expect(released.json()).toMatchObject({ status: "queued", executionHold: false, errorCode: null, attempt: 0 });
      expect(released.json().progress).toMatchObject({ checkpoint: { page: 7 }, processed: 10 });
      expect(
        await prisma.adminAudit.findFirstOrThrow({ where: { taskId: current.id, action: "release_task" } }),
      ).toMatchObject({
        details: { previousHoldReason: "local_resource_wait", previousErrorCode: "local_memory_limit" },
      });
      const response = await app.inject({ url: "/v1/executors", headers: { "x-api-key": "test-internal-key" } });
      const worker = response.json().data.find((row: { id: string }) => row.id === owner);
      expect(worker).toMatchObject({ state: "resource_wait", resourceReason: "local_memory_limit" });
      expect(worker).not.toHaveProperty("resources");
      expect(worker).not.toHaveProperty("activeTaskId");
    } finally {
      await app.close();
    }
  });
  it.each(["typescript", "python"])(
    "real %s executor waits without acquiring and can stop normally under resource pressure",
    async (runtime) => {
      const queued = await task(false, runtime === "typescript" ? "maintenance" : "openresults");
      const directory = await mkdtemp(join(tmpdir(), "race-resources-"));
      const stop = join(directory, "stop"),
        report = join(directory, "report.json"),
        selection = join(directory, "tasks.json");
      await writeFile(selection, JSON.stringify([queued.id]));
      const env = {
        ...process.env,
        WORKER_DATABASE_URL: process.env.DATABASE_URL!.split("?")[0],
        WORKER_MODE: "continuous",
        WORKER_CODE_VERSION: owner,
        WORKER_STOP_FILE: stop,
        WORKER_REPORT_PATH: report,
        WORKER_TASK_SELECTION_FILE: selection,
        WORKER_MIN_FREE_MEMORY_MB: "1048576",
        WORKER_MIN_FREE_TEMP_MB: "1048576",
      };
      delete env.SUPABASE_URL;
      delete env.SUPABASE_SECRET_KEY;
      delete env.SUPABASE_SERVICE_ROLE_KEY;
      const executable = runtime === "typescript" ? process.execPath : (process.env.TEST_PYTHON ?? "python");
      const args =
        runtime === "typescript" ? [resolve("apps/worker/dist/apps/worker/src/queue.js")] : ["-u", "-m", "worker"];
      const child = invoke(executable, args, {
        cwd: runtime === "typescript" ? process.cwd() : resolve("apps/openresults-worker"),
        env,
        timeout: 25000,
      });
      // Attach a rejection observer immediately; the terminal outcome is awaited below.
      void child.catch(() => {});
      let reportData: { claimed: number } | undefined;
      try {
        let row: { state: string } | undefined;
        for (let index = 0; index < 50; index++) {
          const rows = await prisma.$queryRaw<
            Array<{ state: string }>
          >`SELECT state FROM "WorkerPresence" WHERE version=${owner} AND runtime=${runtime}`;
          row = rows[0];
          if (row?.state === "resource_wait") break;
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(row?.state).toBe("resource_wait");
      } finally {
        await writeFile(stop, "stop");
        try {
          await child;
          reportData = JSON.parse(await readFile(report, "utf8"));
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      expect(reportData?.claimed).toBe(0);
      expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: queued.id } })).toEqual(queued);
      const rows = await prisma.$queryRaw<
        Array<{ state: string }>
      >`SELECT state FROM "WorkerPresence" WHERE version=${owner} AND runtime=${runtime}`;
      expect(rows[0]?.state).toBe("stopped");
    },
  );
});
