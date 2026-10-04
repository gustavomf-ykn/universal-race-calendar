import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { generateKeyPair, exportJWK, SignJWT } from "../apps/api/node_modules/jose/dist/webapi/index.js";
import {
  prisma,
  weeklyDefaults,
  configureWeeklyCatalog,
  coordinateWeeklyCatalog,
  readWeeklyCatalog,
  cancelWeeklyOccurrence,
  enqueueTask,
  controlCatalogSync,
  processCatalogReconciliation,
  finishTask,
  controlCatalogReconciliation,
  startCatalogReconciliation,
} from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";
import type { CatalogWeeklySchedule, CollectionTask } from "@prisma/client";

const subject = randomUUID(),
  owner = `user:${subject}`;
const enabled = { ...weeklyDefaults, enabled: true, expectedRevision: 0, reason: "Agenda em banco sintético" };
const startAt = new Date("2030-01-01T12:00:00Z"),
  dueAt = new Date("2030-01-07T11:00:00Z");
describe.skipIf(!process.env.DATABASE_URL)("durable weekly three-source catalog orchestration", () => {
  let base: CatalogWeeklySchedule, server: Server, adminToken: string, userToken: string;
  const environment = new Map<string, string | undefined>();
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    base = await prisma.catalogWeeklySchedule.findUniqueOrThrow({ where: { id: 1 } });
    if (base.enabled || (await prisma.catalogWeeklyOccurrence.count())) throw Error("fresh_weekly_fixture_required");
    for (const name of [
      "WORKER_MODE",
      "WORKER_MIN_FREE_TEMP_MB",
      "WORKER_MIN_FREE_MEMORY_MB",
      "WORKER_TASK_SELECTION_FILE",
      "SUPABASE_URL",
    ])
      environment.set(name, process.env[name]);
    const keys = await generateKeyPair("ES256"),
      jwk = { ...(await exportJWK(keys.publicKey)), kid: "weekly-fixture", alg: "ES256" };
    server = createServer((req, res) => {
      if (req.url !== "/auth/v1/.well-known/jwks.json") {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
    const token = (admin: boolean) =>
      new SignJWT({ role: "authenticated", app_metadata: { role: admin ? "admin" : "user" } })
        .setProtectedHeader({ alg: "ES256", kid: "weekly-fixture" })
        .setSubject(subject)
        .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
        .setAudience("authenticated")
        .setExpirationTime("10m")
        .sign(keys.privateKey);
    adminToken = await token(true);
    userToken = await token(false);
  });
  beforeEach(() => {
    process.env.WORKER_MODE = "continuous";
    // Local SQL fixtures use a valid small reserve; no source/browser requests.
    process.env.WORKER_MIN_FREE_TEMP_MB = "128";
    process.env.WORKER_MIN_FREE_MEMORY_MB = "128";
    delete process.env.WORKER_TASK_SELECTION_FILE;
  });
  afterEach(async () => {
    const runs = await prisma.catalogReconciliation.findMany({ where: { ownerId: owner }, select: { id: true } });
    await prisma.catalogReconciliationDecision.deleteMany({ where: { runId: { in: runs.map((r) => r.id) } } });
    await prisma.catalogWeeklyOccurrence.deleteMany({ where: { ownerId: owner } });
    await prisma.catalogReconciliation.deleteMany({ where: { ownerId: owner } });
    await prisma.adminAudit.deleteMany({ where: { actorId: owner } });
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.catalogSync.deleteMany({ where: { ownerId: owner } });
    const { id, ...original } = base;
    await prisma.catalogWeeklySchedule.update({ where: { id }, data: original });
  });
  afterAll(async () => {
    for (const [name, value] of environment)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });
  async function start(now = dueAt) {
    await configureWeeklyCatalog(owner, randomUUID(), enabled, startAt);
    const result = await coordinateWeeklyCatalog(now);
    expect(result.created).toBe(1);
    return prisma.catalogWeeklyOccurrence.findUniqueOrThrow({ where: { id: result.occurrenceId! } });
  }
  async function finishDiscovery(run: { sourceSyncs: unknown }, limited = false) {
    const ids = Object.values(run.sourceSyncs as Record<string, string>);
    await prisma.catalogSync.updateMany({
      where: { id: { in: ids } },
      data: {
        status: limited ? "limited" : "completed",
        coverage: limited ? "prefix_limit_reached" : "source_end_verified",
      },
    });
    await prisma.collectionTask.updateMany({
      where: { ownerId: owner, kind: "catalog-sync" },
      data: { status: "completed", finishedAt: new Date() },
    });
  }
  async function finishReconciliation(id: string) {
    const current = await prisma.catalogWeeklyOccurrence.findUniqueOrThrow({ where: { id } });
    const task = await prisma.collectionTask.findFirstOrThrow({
      where: {
        ownerId: owner,
        kind: "catalog-reconcile",
        payload: { path: ["runId"], equals: current.reconciliationId! },
      },
      orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    });
    const rows = await prisma.$queryRaw<
      CollectionTask[]
    >`SELECT * FROM claim_selected_task(${["maintenance"]}::text[],${randomUUID()},${[task.id]}::text[])`;
    const claimed = rows[0];
    expect(claimed?.id).toBe(task.id);
    // Execute the real reconciliation algorithm against the disposable empty catalog.
    const result = await processCatalogReconciliation(claimed as CollectionTask);
    expect(await finishTask(claimed!, "completed", result)).toBe(true);
  }
  it("is disabled by default and never creates work without explicit configuration", async () => {
    expect((await readWeeklyCatalog()).schedule.enabled).toBe(false);
    expect(await coordinateWeeklyCatalog(dueAt)).toEqual({ created: 0, reason: null });
    expect(await prisma.collectionTask.count({ where: { ownerId: owner } })).toBe(0);
    const flags = await prisma.$queryRaw<
      Array<{ table: string; rls: boolean }>
    >`SELECT relname AS table,relrowsecurity AS rls
      FROM pg_class WHERE relname IN ('CatalogWeeklySchedule','CatalogWeeklyOccurrence') ORDER BY relname`;
    expect(flags).toHaveLength(2);
    expect(flags.every((r) => r.rls)).toBe(true);
    const access = await prisma.$queryRaw<
      Array<{ allowed: boolean }>
    >`SELECT has_table_privilege(r.oid,'"CatalogWeeklySchedule"','SELECT') OR
      has_table_privilege(r.oid,'"CatalogWeeklyOccurrence"','SELECT') AS allowed FROM pg_roles r WHERE rolname IN ('anon','authenticated')`;
    expect(access.every((r) => !r.allowed)).toBe(true);
  });
  it("configures with revision checks and replays the immutable response after a lost response", async () => {
    const key = randomUUID();
    const first = await configureWeeklyCatalog(owner, key, enabled, startAt);
    expect(await configureWeeklyCatalog(owner, key, enabled, new Date("2030-02-01"))).toEqual(first);
    expect((await readWeeklyCatalog()).schedule.revision).toBe(1);
    await expect(configureWeeklyCatalog(owner, key, { ...enabled, minute: 1 }, startAt)).rejects.toThrow(
      "idempotency_conflict",
    );
    await expect(configureWeeklyCatalog(owner, randomUUID(), enabled, startAt)).rejects.toThrow(
      "weekly_revision_conflict",
    );
    expect(await prisma.adminAudit.count({ where: { actorId: owner, action: "weekly-configure" } })).toBe(1);
  });
  it("hides configured schedules and occurrence history from a reader even with SELECT grants", async () => {
    await start();
    expect(await prisma.catalogWeeklyOccurrence.count({ where: { ownerId: owner } })).toBe(1);
    await prisma.$executeRawUnsafe(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='test_catalog_weekly_reader') THEN CREATE ROLE test_catalog_weekly_reader; END IF; END $$",
    );
    await prisma.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO test_catalog_weekly_reader");
    await prisma.$executeRawUnsafe(
      'GRANT SELECT ON "CatalogWeeklySchedule","CatalogWeeklyOccurrence" TO test_catalog_weekly_reader',
    );
    const visible = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE test_catalog_weekly_reader");
      return {
        schedule: await tx.$queryRaw<unknown[]>`SELECT id FROM "CatalogWeeklySchedule"`,
        history: await tx.$queryRaw<unknown[]>`SELECT id FROM "CatalogWeeklyOccurrence"`,
      };
    });
    expect(visible).toEqual({ schedule: [], history: [] });
  });
  it("separate coordinator processes resume the persisted occurrence without duplicating or consuming unrelated jobs", async () => {
    await configureWeeklyCatalog(owner, randomUUID(), enabled, startAt);
    const protectedTask = await enqueueTask(owner, randomUUID(), "ticketsports", "calendar", { quantity: 500 });
    const code =
      'import {prisma,coordinateWeeklyCatalog} from "@race-calendar/database"; const result=await coordinateWeeklyCatalog(new Date("2030-01-07T11:00:00Z")); console.log(JSON.stringify(result)); await prisma.$disconnect();';
    const once = () =>
      new Promise<{ created: number; reason: string | null }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 20000,
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.once("error", reject);
        child.once("exit", (status) => {
          if (status !== 0) {
            reject(Error("synthetic_coordinator_process_failed"));
            return;
          }
          try {
            resolve(JSON.parse(output.trim()));
          } catch {
            reject(Error("synthetic_coordinator_report_invalid"));
          }
        });
      });
    expect((await once()).created).toBe(1);
    expect((await once()).created).toBe(0);
    expect(await prisma.catalogWeeklyOccurrence.count({ where: { ownerId: owner } })).toBe(1);
    expect(await prisma.collectionTask.count({ where: { ownerId: owner, kind: "catalog-sync" } })).toBe(3);
    expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id: protectedTask.id } })).toMatchObject({
      status: "queued",
      attempt: 0,
      payload: { quantity: 500 },
    });
  });
  it("concurrent coordinators create exactly one occurrence and three discovery tasks", async () => {
    await configureWeeklyCatalog(owner, randomUUID(), enabled, startAt);
    expect(await coordinateWeeklyCatalog(new Date(dueAt.getTime() - 1))).toEqual({ created: 0, reason: null });
    const results = await Promise.all([
      coordinateWeeklyCatalog(dueAt),
      coordinateWeeklyCatalog(dueAt),
      coordinateWeeklyCatalog(dueAt),
    ]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(1);
    expect(await prisma.catalogWeeklyOccurrence.count({ where: { ownerId: owner } })).toBe(1);
    const tasks = await prisma.collectionTask.findMany({ where: { ownerId: owner } });
    expect(tasks.map((t) => t.source).sort()).toEqual(["corridasbr", "openresults", "ticketsports"]);
    expect(tasks.every((t) => t.status === "queued" && t.attempt === 0 && t.kind === "catalog-sync")).toBe(true);
    const next = (await readWeeklyCatalog()).schedule;
    expect(next.nextLocalDate).toBe("2030-01-14");
    expect(next.overdue).toBe(false);
    await coordinateWeeklyCatalog(new Date("2030-02-04T11:00:00Z"));
    expect(await prisma.collectionTask.count({ where: { ownerId: owner } })).toBe(3);
  });
  it("consolidates offline weeks and leaves no work for selective or batch runs", async () => {
    await configureWeeklyCatalog(owner, randomUUID(), enabled, startAt);
    process.env.WORKER_TASK_SELECTION_FILE = "does-not-need-to-exist";
    expect((await coordinateWeeklyCatalog(dueAt)).reason).toBe("weekly_execution_mode_disabled");
    delete process.env.WORKER_TASK_SELECTION_FILE;
    process.env.WORKER_MODE = "batch";
    expect((await coordinateWeeklyCatalog(dueAt)).reason).toBe("weekly_execution_mode_disabled");
    process.env.WORKER_MODE = "continuous";
    const result = await coordinateWeeklyCatalog(new Date("2030-02-04T11:00:00Z"));
    const run = await prisma.catalogWeeklyOccurrence.findUniqueOrThrow({ where: { id: result.occurrenceId! } });
    expect(run).toMatchObject({ localDate: "2030-02-04", firstDueLocalDate: "2030-01-07", coalescedWeeks: 4 });
    expect(run.options).toMatchObject({ historical: true, autoContinue: true, discoveryMode: "national" });
    expect(run.options).not.toHaveProperty("from");
    expect(await prisma.collectionTask.count({ where: { ownerId: owner } })).toBe(3);
  });
  it("refuses new occurrences under real local pressure or unavailable database capacity", async () => {
    await configureWeeklyCatalog(owner, randomUUID(), enabled, startAt);
    process.env.WORKER_MIN_FREE_TEMP_MB = "1048576";
    expect((await coordinateWeeklyCatalog(dueAt)).reason).toBe("local_disk_limit");
    process.env.WORKER_MIN_FREE_TEMP_MB = "128";
    const original = await prisma.catalogCapacity.findUniqueOrThrow({ where: { id: 1 } });
    try {
      await prisma.catalogCapacity.update({ where: { id: 1 }, data: { confirmedAt: null } });
      expect((await coordinateWeeklyCatalog(dueAt)).reason).toBe("capacity_unconfigured");
      expect((await readWeeklyCatalog()).schedule.waitReason).toBe("capacity_unconfigured");
    } finally {
      const { id, ...data } = original;
      await prisma.catalogCapacity.update({ where: { id }, data });
    }
    expect(await prisma.catalogWeeklyOccurrence.count()).toBe(0);
  });
  it("an offline interval starting on a historical week preserves the missed historical sweep", async () => {
    await configureWeeklyCatalog(owner, randomUUID(), enabled, new Date("2030-01-08T12:00:00Z"));
    const result = await coordinateWeeklyCatalog(new Date("2030-01-21T11:00:00Z"));
    const run = await prisma.catalogWeeklyOccurrence.findUniqueOrThrow({ where: { id: result.occurrenceId! } });
    expect(run).toMatchObject({ firstDueLocalDate: "2030-01-14", localDate: "2030-01-21", coalescedWeeks: 1 });
    expect(run.options).toMatchObject({ historical: true });
    expect(run.options).not.toHaveProperty("from");
  });
  it("weekly and manual reconciliation starters share one lock order and never create competing scans", async () => {
    const run = await start();
    await finishDiscovery(run);
    const results = await Promise.allSettled([
      coordinateWeeklyCatalog(dueAt),
      startCatalogReconciliation(owner, randomUUID(), "Varredura manual concorrente"),
    ]);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason.message).toBe("catalog_reconciliation_active");
    expect(await prisma.catalogReconciliation.count({ where: { ownerId: owner } })).toBe(1);
    expect(await prisma.collectionTask.count({ where: { ownerId: owner, kind: "catalog-reconcile" } })).toBe(1);
  });
  it("waits for an equivalent national cycle instead of creating a second one", async () => {
    await configureWeeklyCatalog(owner, randomUUID(), enabled, startAt);
    await prisma.catalogSync.create({
      data: { ownerId: owner, source: "ticketsports", options: { discoveryMode: "national" } },
    });
    expect((await coordinateWeeklyCatalog(dueAt)).reason).toBe("weekly_scope_in_use");
    expect(await prisma.catalogWeeklyOccurrence.count()).toBe(0);
  });
  it("does not call discovery complete an update: waits for metadata, respects holds and reconciles once", async () => {
    const run = await start();
    await finishDiscovery(run);
    const syncId = (run.sourceSyncs as Record<string, string>).openresults;
    const meta = await enqueueTask(owner, randomUUID(), "openresults", "inspect", {
      syncId,
      url: "https://openresults.run/evento/synthetic/",
    });
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).active?.status).toBe("enrichment");
    expect(await prisma.catalogReconciliation.count({ where: { ownerId: owner } })).toBe(0);
    await prisma.collectionTask.update({
      where: { id: meta.id },
      data: { executionHold: true, holdReason: "local_resource_wait" },
    });
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).active?.status).toBe("blocked");
    await prisma.collectionTask.update({
      where: { id: meta.id },
      data: { status: "completed", executionHold: false, finishedAt: new Date() },
    });
    await Promise.all([coordinateWeeklyCatalog(dueAt), coordinateWeeklyCatalog(dueAt)]);
    expect(await prisma.catalogReconciliation.count({ where: { ownerId: owner } })).toBe(1);
    expect((await readWeeklyCatalog()).active?.status).toBe("reconciliation");
    expect((await readWeeklyCatalog()).schedule.lastSuccessAt).toBeNull();
  });
  it("a successful retry supersedes its failed metadata attempt without deleting history", async () => {
    const run = await start();
    await finishDiscovery(run);
    const syncId = (run.sourceSyncs as Record<string, string>).openresults;
    const old = await enqueueTask(owner, randomUUID(), "openresults", "inspect", {
      syncId,
      url: "https://openresults.run/evento/synthetic/",
    });
    await prisma.collectionTask.update({ where: { id: old.id }, data: { status: "failed" } });
    const next = await enqueueTask(owner, randomUUID(), "openresults", "inspect", {
      syncId,
      url: "https://openresults.run/evento/synthetic/",
      retryOf: old.id,
    });
    await prisma.collectionTask.update({ where: { id: next.id }, data: { status: "completed" } });
    await coordinateWeeklyCatalog(dueAt);
    await finishReconciliation(run.id);
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).data[0]?.status).toBe("completed");
    expect((await readWeeklyCatalog()).data[0]?.summary).toMatchObject({ tasks: { failed: 0 } });
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("failed");
  });
  it("checkpoint recovery replaces the failed reconciliation attempt without deleting its history", async () => {
    const run = await start();
    await finishDiscovery(run);
    await coordinateWeeklyCatalog(dueAt);
    const current = await prisma.catalogWeeklyOccurrence.findUniqueOrThrow({ where: { id: run.id } });
    const first = await prisma.collectionTask.findFirstOrThrow({
      where: { ownerId: owner, kind: "catalog-reconcile" },
    });
    await prisma.collectionTask.update({ where: { id: first.id }, data: { status: "failed", finishedAt: new Date() } });
    await prisma.catalogReconciliation.update({
      where: { id: current.reconciliationId! },
      data: { status: "blocked" },
    });
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).active?.status).toBe("blocked");
    await controlCatalogReconciliation(owner, randomUUID(), current.reconciliationId!, "resume");
    await finishReconciliation(run.id);
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).data[0]?.status).toBe("completed");
    expect((await readWeeklyCatalog()).schedule.lastSuccessAt).not.toBeNull();
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("failed");
  });
  it("limited discovery stays partial after reconciliation and never claims coverage or fresh results", async () => {
    const run = await start();
    await finishDiscovery(run, true);
    await coordinateWeeklyCatalog(dueAt);
    await finishReconciliation(run.id);
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).data[0]).toMatchObject({
      status: "partial",
      coverageVerified: false,
      resultsCollected: false,
    });
    expect((await readWeeklyCatalog()).schedule.lastSuccessAt).toBeNull();
  });
  it("disabling prevents new occurrences without abandoning the existing cycle", async () => {
    const run = await start();
    await configureWeeklyCatalog(owner, randomUUID(), { ...enabled, enabled: false, expectedRevision: 1 }, startAt);
    await finishDiscovery(run);
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).active?.status).toBe("reconciliation");
    await finishReconciliation(run.id);
    await coordinateWeeklyCatalog(dueAt);
    await coordinateWeeklyCatalog(new Date("2030-03-04T11:00:00Z"));
    expect((await readWeeklyCatalog()).schedule.enabled).toBe(false);
    expect(await prisma.catalogWeeklyOccurrence.count()).toBe(1);
  });
  it("waits for the executor acknowledgement even when the reconciliation receipt is terminal", async () => {
    const run = await start();
    await finishDiscovery(run);
    await coordinateWeeklyCatalog(dueAt);
    const current = await prisma.catalogWeeklyOccurrence.findUniqueOrThrow({ where: { id: run.id } });
    await prisma.catalogReconciliation.update({
      where: { id: current.reconciliationId! },
      data: { status: "completed", finishedAt: new Date() },
    });
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).active?.status).toBe("reconciliation");
    expect((await readWeeklyCatalog()).schedule.lastSuccessAt).toBeNull();
    await prisma.collectionTask.updateMany({
      where: { ownerId: owner, kind: "catalog-reconcile" },
      data: { executionHold: true },
    });
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).active?.status).toBe("blocked");
    await prisma.collectionTask.updateMany({
      where: { ownerId: owner, kind: "catalog-reconcile" },
      data: { status: "failed", executionHold: false },
    });
    await coordinateWeeklyCatalog(dueAt);
    expect((await readWeeklyCatalog()).data[0]?.status).toBe("partial");
    expect((await readWeeklyCatalog()).schedule.lastSuccessAt).toBeNull();
  });
  it("cancels only pending tasks from its occurrence, preserves unrelated requests and refuses running work", async () => {
    const run = await start(),
      tasks = await prisma.collectionTask.findMany({ where: { ownerId: owner } });
    const unrelated = await enqueueTask(owner, randomUUID(), "exports", "export", { unrelated: true });
    await prisma.collectionTask.update({
      where: { id: tasks[0]!.id },
      data: { status: "running", leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 90000) },
    });
    await expect(cancelWeeklyOccurrence(owner, randomUUID(), run.id, "Cancelar teste")).rejects.toThrow(
      "weekly_occurrence_in_use",
    );
    await prisma.collectionTask.update({
      where: { id: tasks[0]!.id },
      data: { status: "queued", leaseToken: null, leaseUntil: null },
    });
    const key = randomUUID(),
      first = await cancelWeeklyOccurrence(owner, key, run.id, "Cancelar teste");
    expect(await cancelWeeklyOccurrence(owner, key, run.id, "Cancelar teste")).toEqual(first);
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe("queued");
    expect(await prisma.collectionTask.count({ where: { ownerId: owner, status: "cancelled" } })).toBe(3);
    await expect(
      controlCatalogSync((run.sourceSyncs as Record<string, string>).ticketsports!, owner, "resume", randomUUID()),
    ).rejects.toThrow("weekly_occurrence_cancelled");
  });
  it("gates real routes by JWT admin, preserves a lost configuration response, and exposes no owner or internal key", async () => {
    const app = await buildApp(),
      path = "/v1/admin/catalog/weekly";
    try {
      expect((await app.inject({ url: path })).statusCode).toBe(401);
      expect((await app.inject({ url: path, headers: { authorization: `Bearer ${userToken}` } })).statusCode).toBe(403);
      const request = {
        method: "POST" as const,
        url: `${path}/configure`,
        payload: { ...enabled, enabled: false },
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(200);
      const replay = await app.inject(request);
      expect(replay.json()).toEqual(first.json());
      const response = await app.inject({ url: path, headers: { authorization: `Bearer ${adminToken}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json().schedule.enabled).toBe(false);
      expect(response.json().schedule).not.toHaveProperty("ownerId");
      expect(response.body).not.toContain("test-internal-key");
      expect(
        (
          await app.inject({
            ...request,
            payload: { ...request.payload, expectedRevision: 0 },
            headers: { ...request.headers, "idempotency-key": randomUUID() },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("JWT cancellation preserves replay history and prevents new retries of a cancelled cycle's metadata", async () => {
    const run = await start(),
      syncId = (run.sourceSyncs as Record<string, string>).openresults;
    // Discovery can already be completed while metadata still needs work.
    // Preserve its successful receipt, but cancellation must also fence retries.
    await finishDiscovery(run);
    const metadata = await enqueueTask(owner, randomUUID(), "openresults", "inspect", {
      syncId,
      url: "https://openresults.run/evento/synthetic/",
    });
    await prisma.collectionTask.update({
      where: { id: metadata.id },
      data: { status: "failed", errorCode: "source_access_blocked" },
    });
    const app = await buildApp();
    try {
      const request = {
        method: "POST" as const,
        url: `/v1/admin/catalog/weekly/occurrences/${run.id}/cancel`,
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
        payload: { reason: "Cancelar ciclo sintético" },
      };
      expect(
        (await app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${userToken}` } }))
          .statusCode,
      ).toBe(403);
      const first = await app.inject(request);
      expect(first.statusCode).toBe(200);
      expect((await app.inject(request)).json()).toEqual(first.json());
      const retry = await app.inject({
        method: "POST",
        url: `/v1/tasks/${metadata.id}/retry`,
        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": randomUUID() },
        payload: { mode: "restart" },
      });
      expect(retry.statusCode).toBe(409);
      expect(retry.json().error).toBe("weekly_occurrence_cancelled");
      expect(await prisma.collectionTask.count({ where: { ownerId: owner, kind: "inspect" } })).toBe(1);
      expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: metadata.id } })).status).toBe("failed");
      expect((await prisma.catalogSync.findUniqueOrThrow({ where: { id: syncId } })).status).toBe("completed");
      await expect(controlCatalogSync(syncId, owner, "resume", randomUUID())).rejects.toThrow(
        "weekly_occurrence_cancelled",
      );
    } finally {
      await app.close();
    }
  });
});
