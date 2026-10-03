import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prisma, finishTask, heartbeatTask } from "@race-calendar/database";
import type { CollectionTask, Prisma } from "@prisma/client";

const owner = "queue-priority-" + randomUUID();
const invoke = promisify(execFile);
describe.skipIf(!process.env.DATABASE_URL)("shared queue selection priority", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
  });
  afterEach(async () => {
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
  });
  async function task(source: string, kind: string, extra: Partial<Prisma.CollectionTaskUncheckedCreateInput> = {}) {
    const key = randomUUID();
    return prisma.collectionTask.create({
      data: { source, kind, ownerId: owner, idempotencyKey: key, requestHash: key, payload: {}, ...extra },
    });
  }
  async function claim(
    ids: string[],
    sources = ["ticketsports", "corridasbr", "maintenance", "openresults", "exports"],
  ) {
    const rows = await prisma.$queryRaw<CollectionTask[]>`
      SELECT * FROM claim_selected_task(${sources}::text[],${randomUUID()},${ids}::text[])`;
    return rows[0] ?? null;
  }
  it("selects a manual calendar request before a recent bulk stage in an earlier alphabetic source", async () => {
    const bulk = await task("corridasbr", "catalog-sync", { createdAt: new Date(Date.now() - 60000) });
    const manual = await task("ticketsports", "calendar");
    expect((await claim([bulk.id, manual.id]))?.id).toBe(manual.id);
    expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: bulk.id } })).toMatchObject({
      status: "queued",
      attempt: 0,
    });
  });
  it("selects an export before a recent result request and keeps source concurrency", async () => {
    const result = await task("openresults", "extract", { createdAt: new Date(Date.now() - 60000) });
    const exported = await task("exports", "export-selection");
    expect((await claim([result.id, exported.id]))?.id).toBe(exported.id);
    const another = await task("exports", "export");
    expect(await claim([another.id], ["exports"])).toBeNull();
    expect((await claim([result.id], ["openresults"]))?.id).toBe(result.id);
  });
  it("ages existing bulk work instead of allowing an indefinite stream of new requests to pass it", async () => {
    const aged = await task("maintenance", "catalog-reconcile", { createdAt: new Date(Date.now() - 16 * 60000) });
    const fresh = await task("ticketsports", "calendar");
    expect((await claim([aged.id, fresh.id]))?.id).toBe(aged.id);
    const moment = new Date("2030-01-01T12:00:00Z");
    const boundary = await prisma.$queryRaw<Array<{ before: number; aged: number }>>`
      SELECT task_queue_priority('catalog-sync',TIMESTAMPTZ '2030-01-01 11:45:00.001+00',${moment}) AS before,
        task_queue_priority('catalog-sync',TIMESTAMPTZ '2030-01-01 11:45:00+00',${moment}) AS aged`;
    expect(boundary[0]).toEqual({ before: 2, aged: 0 });
  });
  it("never promotes held, future, blocked or unselected tasks, even when they are older", async () => {
    const old = new Date(Date.now() - 3600000);
    const held = await task("exports", "export", {
      createdAt: old,
      executionHold: true,
      holdReason: "administrative_hold",
    });
    const future = await task("maintenance", "catalog-sync", {
      createdAt: old,
      availableAt: new Date(Date.now() + 3600000),
    });
    const excluded = await task("exports", "export", { createdAt: old });
    const blocked = await task("openresults", "extract", { createdAt: old });
    const chosen = await task("ticketsports", "calendar");
    const prior = await prisma.sourceRequestControl.findUnique({ where: { source: "openresults" } });
    try {
      await prisma.sourceRequestControl.upsert({
        where: { source: "openresults" },
        create: { source: "openresults", blockedAt: new Date() },
        update: { blockedAt: new Date() },
      });
      expect((await claim([held.id, future.id, blocked.id, chosen.id]))?.id).toBe(chosen.id);
      for (const row of [held, future, excluded, blocked])
        expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
          status: "queued",
          attempt: 0,
        });
      expect(await claim([])).toBeNull();
    } finally {
      if (prior)
        await prisma.sourceRequestControl.update({
          where: { source: "openresults" },
          data: { blockedAt: prior.blockedAt },
        });
      else await prisma.sourceRequestControl.delete({ where: { source: "openresults" } });
    }
  });
  it("competing TypeScript-family claims cannot run two tasks, regardless of source priority", async () => {
    const first = await task("ticketsports", "calendar");
    const second = await task("corridasbr", "calendar");
    const claims = await Promise.all([claim([first.id, second.id]), claim([first.id, second.id])]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const active = claims.find(Boolean)!;
    expect(await finishTask(active, "completed", {})).toBe(true);
    expect((await claim([first.id, second.id]))?.id).toBe(active.id === first.id ? second.id : first.id);
  });
  it("recovers selected leases across wanted sources before selection and fences the old token", async () => {
    const interrupted = await task("ticketsports", "calendar", { createdAt: new Date(Date.now() - 60000) });
    const stale = (await claim([interrupted.id]))!;
    await prisma.collectionTask.update({ where: { id: interrupted.id }, data: { leaseUntil: new Date(0) } });
    const bulk = await task("corridasbr", "catalog-sync");
    const recovered = (await claim([bulk.id, interrupted.id]))!;
    expect(recovered).toMatchObject({ id: interrupted.id, attempt: 2 });
    expect(recovered.leaseToken).not.toBe(stale.leaseToken);
    expect(await heartbeatTask(stale, { stage: "stale" })).toBe(false);
    expect(await finishTask(stale, "completed", {})).toBe(false);
    expect(await finishTask(recovered, "completed", {})).toBe(true);
  });
  it("the real Python claim client observes the same priority without consuming any source", async () => {
    const bulk = await task("openresults", "catalog-sync", { createdAt: new Date(Date.now() - 60000) });
    const exported = await task("exports", "export");
    const directory = await mkdtemp(join(tmpdir(), "race-priority-"));
    try {
      const selection = join(directory, "tasks.json");
      await writeFile(selection, JSON.stringify([bulk.id, exported.id]));
      const { stdout } = await invoke(
        process.env.TEST_PYTHON ?? "python",
        ["-c", "import json,worker; task=worker.claim_next_task(); print(json.dumps({'id':task['id']}))"],
        {
          cwd: resolve("apps/openresults-worker"),
          env: {
            ...process.env,
            WORKER_DATABASE_URL: process.env.DATABASE_URL!.split("?")[0],
            WORKER_TASK_SELECTION_FILE: selection,
          },
          timeout: 20000,
        },
      );
      expect(JSON.parse(stdout)).toEqual({ id: exported.id });
      expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: bulk.id } })).toMatchObject({
        status: "queued",
        attempt: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
