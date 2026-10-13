import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "../apps/api/node_modules/jose/dist/webapi/index.js";
import { buildApp } from "../apps/api/src/app.js";
import {
  prisma,
  coordinateCatalogCampaigns,
  coordinateCatalogSyncs,
  coordinateCatalogReconciliations,
  startCatalogReconciliation,
  enqueueTask,
} from "@race-calendar/database";
const subject = randomUUID(),
  owner = "user:" + subject;
describe.skipIf(!process.env.DATABASE_URL)("manual three-source campaign on isolated PostgreSQL", () => {
  let app: Awaited<ReturnType<typeof buildApp>>, server: Server, admin: string, member: string;
  const prior = new Map<string, string | undefined>();
  beforeAll(async () => {
    const uri = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(uri.hostname) || !uri.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    for (const n of ["SUPABASE_URL", "WORKER_MODE", "EXPECTED_SUPABASE_PROJECT_REF", "WORKER_TASK_SELECTION_FILE"])
      prior.set(n, process.env[n]);
    process.env.WORKER_MODE = "continuous";
    delete process.env.WORKER_TASK_SELECTION_FILE;
    delete process.env.EXPECTED_SUPABASE_PROJECT_REF;
    const keys = await generateKeyPair("ES256"),
      jwk = { ...(await exportJWK(keys.publicKey)), kid: subject, alg: "ES256" };
    server = createServer((_q, r) =>
      r.setHeader("content-type", "application/json").end(JSON.stringify({ keys: [jwk] })),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
    process.env.SUPABASE_URL = base;
    const token = (role: string) =>
      new SignJWT({ role: "authenticated", app_metadata: { role } })
        .setProtectedHeader({ alg: "ES256", kid: subject })
        .setSubject(subject)
        .setIssuer(base + "/auth/v1")
        .setAudience("authenticated")
        .setExpirationTime("1h")
        .sign(keys.privateKey);
    admin = await token("admin");
    member = await token("user");
    app = await buildApp();
  });
  afterEach(async () => {
    const recs = (await prisma.catalogReconciliation.findMany({ where: { ownerId: owner }, select: { id: true } })).map(
      (r) => r.id,
    );
    await prisma.catalogReconciliationDecision.deleteMany({ where: { runId: { in: recs } } });
    await prisma.catalogReconciliation.deleteMany({ where: { id: { in: recs } } });
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.catalogSync.deleteMany({ where: { ownerId: owner } });
    await prisma.catalogCampaign.deleteMany({ where: { ownerId: owner } });
    await prisma.adminAudit.deleteMany({ where: { actorId: owner } });
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server.close(() => r()));
    for (const [n, v] of prior) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
  const path = "/v1/admin/catalog/campaigns";
  const request = (url: string, payload: unknown = {}, key = randomUUID(), token = admin) =>
    app.inject({ method: "POST", url, headers: { authorization: "Bearer " + token, "idempotency-key": key }, payload });
  async function start() {
    const r = await request(path, { reason: "Synthetic campaign" });
    expect(r.statusCode).toBe(202);
    return r.json();
  }
  it("requires JWT admin for every control and readiness fails closed without expected identity", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/version" })).json().features).toEqual({
      catalogCampaigns: true,
    });
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: path, headers: { authorization: "Bearer " + member } })).statusCode,
    ).toBe(403);
    expect((await request(path, { reason: "Denied test" }, randomUUID(), member)).statusCode).toBe(403);
    for (const action of ["pause", "resume", "cancel"])
      expect(
        (await request(path + "/missing/" + action, { reason: "Denied test" }, randomUUID(), member)).statusCode,
      ).toBe(403);
    process.env.EXPECTED_SUPABASE_PROJECT_REF = "sggrijhyblejlgimgzzc";
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ error: "backend_not_ready" });
    delete process.env.EXPECTED_SUPABASE_PROJECT_REF;
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });
  it("atomically creates three national cycles, no date/modality restriction, and replays concurrent/lost responses", async () => {
    const key = randomUUID(),
      payload = { reason: "Synthetic initial load" };
    const responses = await Promise.all(Array.from({ length: 4 }, () => request(path, payload, key)));
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202, 202, 202]);
    expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
    const run = responses[0]!.json();
    expect(Object.keys(run.sourceSyncs).sort()).toEqual(["corridasbr", "openresults", "ticketsports"]);
    expect(run.options).toMatchObject({ batchSize: 25, autoContinue: true, discoveryMode: "national" });
    expect(run.options.states).toHaveLength(27);
    expect(run.options.from).toBeUndefined();
    expect(run.options.modality).toBeUndefined();
    expect(await prisma.collectionTask.count({ where: { ownerId: owner } })).toBe(3);
    expect(await prisma.catalogSync.count({ where: { ownerId: owner, countsAvailable: true } })).toBe(3);
    expect((await request(path, { reason: "Changed intent" }, key)).json().error).toBe("idempotency_conflict");
    expect((await request(path, payload)).json().error).toBe("campaign_active");
    const read = await app.inject({
      method: "GET",
      url: path + "?limit=1",
      headers: { authorization: "Bearer " + admin },
    });
    expect(read.json().pagination.total).toBe(1);
    expect(read.json().active.id).toBe(run.id);
  });
  it("pauses existing and newly generated enrichment; only its own holds are released, unrelated work stays protected", async () => {
    const run = await start(),
      syncId = run.sourceSyncs.ticketsports;
    const held = await enqueueTask(owner, randomUUID(), "ticketsports", "check-source", {
      syncId,
      sourceId: "fixture-held",
    });
    await prisma.collectionTask.update({
      where: { id: held.id },
      data: { executionHold: true, holdReason: "manual_protection" },
    });
    const outside = await enqueueTask(owner, randomUUID(), "ticketsports", "calendar", { quantity: 120 });
    await prisma.collectionTask.update({ where: { id: outside.id }, data: { executionHold: true } });
    const key = randomUUID();
    expect((await request(path + "/" + run.id + "/pause", { reason: "Pause test" }, key)).statusCode).toBe(200);
    const inserted = await enqueueTask(owner, randomUUID(), "ticketsports", "check-source", {
      syncId,
      sourceId: "fixture-new",
    });
    expect(inserted).toMatchObject({ executionHold: true, holdReason: "catalog_campaign_paused" });
    expect((await request(path + "/" + run.id + "/pause", { reason: "Pause test" }, key)).statusCode).toBe(200);
    expect((await request(path + "/" + run.id + "/resume", { reason: "Resume test" })).statusCode).toBe(200);
    expect(await prisma.collectionTask.findUnique({ where: { id: inserted.id } })).toMatchObject({
      executionHold: false,
    });
    expect(await prisma.collectionTask.findUnique({ where: { id: held.id } })).toMatchObject({
      executionHold: true,
      holdReason: "manual_protection",
    });
    expect(await prisma.collectionTask.findUnique({ where: { id: outside.id } })).toMatchObject({
      executionHold: true,
    });
  });
  it("serializes checkpoint continuations against campaign pause without deadlocks or runnable successors", async () => {
    const run = await start();
    await prisma.collectionTask.updateMany({ where: { ownerId: owner }, data: { status: "completed" } });
    await prisma.catalogSync.updateMany({ where: { ownerId: owner }, data: { cursor: 1 } });
    const [continuation, paused] = await Promise.all([
      coordinateCatalogSyncs(),
      request(path + "/" + run.id + "/pause", { reason: "Concurrent checkpoint pause" }),
    ]);
    expect(continuation).toBeGreaterThanOrEqual(0);
    expect(paused.statusCode).toBe(200);
    expect(
      await prisma.collectionTask.count({ where: { ownerId: owner, status: "queued", executionHold: false } }),
    ).toBe(0);
  });
  it("serializes reconciliation continuation against campaign pause and preserves its checkpoint", async () => {
    const run = await start();
    await prisma.catalogSync.updateMany({ where: { ownerId: owner }, data: { status: "completed" } });
    await prisma.collectionTask.updateMany({ where: { ownerId: owner }, data: { status: "completed" } });
    await coordinateCatalogCampaigns();
    const current = await prisma.catalogCampaign.findUniqueOrThrow({ where: { id: run.id } });
    await prisma.catalogReconciliation.update({
      where: { id: current.reconciliationId! },
      data: { sequence: 1, status: "ready", nextAttemptAt: new Date(0) },
    });
    await prisma.collectionTask.updateMany({
      where: { ownerId: owner, kind: "catalog-reconcile" },
      data: { status: "completed" },
    });
    const [continuation, paused] = await Promise.all([
      coordinateCatalogReconciliations(),
      request(path + "/" + run.id + "/pause", { reason: "Concurrent reconciliation pause" }),
    ]);
    expect(continuation).toBeGreaterThanOrEqual(0);
    expect(paused.statusCode).toBe(200);
    expect(
      await prisma.collectionTask.count({ where: { ownerId: owner, status: "queued", executionHold: false } }),
    ).toBe(0);
    expect(await prisma.catalogReconciliation.findUnique({ where: { id: current.reconciliationId! } })).toMatchObject({
      sequence: 1,
    });
  });
  it("cancel refuses active leases then cancels only campaign pendings, retaining editions/history and retry protection", async () => {
    const run = await start(),
      task = await prisma.collectionTask.findFirstOrThrow({ where: { ownerId: owner } });
    await prisma.collectionTask.update({
      where: { id: task.id },
      data: { status: "running", leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60000) },
    });
    expect((await request(path + "/" + run.id + "/cancel", { reason: "Cancel test" })).json().error).toBe(
      "campaign_in_use",
    );
    expect(await prisma.catalogCampaign.findUnique({ where: { id: run.id } })).toMatchObject({ status: "discovery" });
    await prisma.collectionTask.update({
      where: { id: task.id },
      data: { status: "queued", leaseToken: null, leaseUntil: null },
    });
    const outside = await enqueueTask(owner, randomUUID(), "openresults", "extract", { eventId: "fixture-outside" });
    const key = randomUUID(),
      cancel = await request(path + "/" + run.id + "/cancel", { reason: "Cancel test" }, key);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
    expect((await request(path + "/" + run.id + "/cancel", { reason: "Cancel test" }, key)).json()).toEqual(
      cancel.json(),
    );
    expect(await prisma.collectionTask.count({ where: { ownerId: owner, status: "cancelled" } })).toBe(3);
    expect(await prisma.collectionTask.findUnique({ where: { id: outside.id } })).toMatchObject({ status: "queued" });
  });
  it("one blocked source never cancels or holds the other sources; resume keeps completed checkpoints", async () => {
    const run = await start();
    await prisma.catalogSync.update({ where: { id: run.sourceSyncs.ticketsports }, data: { status: "blocked" } });
    expect(await coordinateCatalogCampaigns()).toMatchObject({ observed: 1 });
    const row = await prisma.catalogCampaign.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("blocked");
    for (const source of ["corridasbr", "openresults"])
      expect(await prisma.collectionTask.findFirst({ where: { ownerId: owner, source } })).toMatchObject({
        status: "queued",
        executionHold: false,
      });
    await prisma.catalogSync.update({
      where: { id: run.sourceSyncs.corridasbr },
      data: { status: "completed", processed: 25, createdCount: 20, existingCount: 5 },
    });
    expect((await request(path + "/" + run.id + "/resume", { reason: "Resume partial work" })).statusCode).toBe(200);
    expect(await prisma.catalogSync.findUnique({ where: { id: run.sourceSyncs.corridasbr } })).toMatchObject({
      status: "completed",
      processed: 25,
    });
  });
  it("resumes a failed discovery from compatible checkpoint and retains the failed task instead of duplicating completed steps", async () => {
    const run = await start(),
      task = await prisma.collectionTask.findFirstOrThrow({ where: { ownerId: owner, source: "ticketsports" } });
    await prisma.collectionTask.update({
      where: { id: task.id },
      data: { status: "failed", errorCode: "collection_failed" },
    });
    await prisma.catalogSync.update({
      where: { id: run.sourceSyncs.ticketsports },
      data: { status: "blocked", cursor: 0 },
    });
    const resumed = await request(path + "/" + run.id + "/resume", { reason: "Resume checkpoint" });
    expect(resumed.statusCode).toBe(200);
    const successor = await prisma.collectionTask.findFirstOrThrow({
      where: { ownerId: owner, source: "ticketsports", status: "queued" },
    });
    expect(successor.payload).toMatchObject({
      retryOf: task.id,
      retryMode: "resume",
      syncId: run.sourceSyncs.ticketsports,
    });
    expect(await prisma.collectionTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: "failed",
      errorCode: "collection_failed",
    });
  });
  it("retries only failed metadata in a partial campaign, preserving completed discovery and reconciliation history", async () => {
    const run = await start(),
      syncId = run.sourceSyncs.ticketsports;
    await prisma.catalogSync.updateMany({
      where: { ownerId: owner },
      data: { status: "completed", processed: 25, createdCount: 10, existingCount: 15 },
    });
    await prisma.collectionTask.updateMany({ where: { ownerId: owner }, data: { status: "completed" } });
    const failed = await enqueueTask(owner, randomUUID(), "ticketsports", "check-source", {
      syncId,
      sourceId: "fixture-failed",
    });
    const completed = await enqueueTask(owner, randomUUID(), "ticketsports", "check-source", {
      syncId,
      sourceId: "fixture-completed",
    });
    await prisma.collectionTask.update({
      where: { id: failed.id },
      data: { status: "failed", errorCode: "collection_failed" },
    });
    await prisma.collectionTask.update({ where: { id: completed.id }, data: { status: "completed" } });
    await prisma.catalogCampaign.update({ where: { id: run.id }, data: { status: "partial", finishedAt: new Date() } });
    const key = randomUUID(),
      payload = { reason: "Retry failed metadata" };
    expect((await request(path + "/" + run.id + "/resume", payload, key)).statusCode).toBe(200);
    expect((await request(path + "/" + run.id + "/resume", payload, key)).statusCode).toBe(200);
    const queued = await prisma.collectionTask.findMany({ where: { ownerId: owner, status: "queued" } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ retryOf: failed.id, retryMode: "restart", syncId });
    expect(await prisma.catalogSync.findUnique({ where: { id: syncId } })).toMatchObject({
      status: "completed",
      processed: 25,
      createdCount: 10,
      existingCount: 15,
    });
    expect(await prisma.collectionTask.findUnique({ where: { id: completed.id } })).toMatchObject({
      status: "completed",
    });
    expect(await prisma.collectionTask.findUnique({ where: { id: failed.id } })).toMatchObject({ status: "failed" });
  });
  it("refuses incompatible checkpoints and refuses a blind repeat of limited discovery", async () => {
    const run = await start(),
      syncId = run.sourceSyncs.ticketsports;
    await request(path + "/" + run.id + "/pause", { reason: "Pause incompatible fixture" });
    await prisma.catalogSync.update({ where: { id: syncId }, data: { snapshot: { nationalVersion: 1 } } });
    expect(
      (await request(path + "/" + run.id + "/resume", { reason: "Check incompatible fixture" })).json().error,
    ).toBe("catalog_checkpoint_incompatible");
    expect(await prisma.catalogCampaign.findUnique({ where: { id: run.id } })).toMatchObject({
      status: "paused",
      pauseRequested: true,
    });
    await prisma.catalogCampaign.update({ where: { id: run.id }, data: { status: "partial", pauseRequested: false } });
    await prisma.catalogSync.update({ where: { id: syncId }, data: { status: "limited" } });
    expect((await request(path + "/" + run.id + "/resume", { reason: "Do not repeat blind" })).json().error).toBe(
      "campaign_limited_new_scope_required",
    );
  });
  it("persists coordination conflicts as visible blocking instead of silently claiming discovery is still progressing", async () => {
    const run = await start();
    await prisma.catalogSync.updateMany({ where: { ownerId: owner }, data: { status: "completed" } });
    await prisma.collectionTask.updateMany({ where: { ownerId: owner }, data: { status: "completed" } });
    const manual = await startCatalogReconciliation(owner, randomUUID(), "Existing manual reconciliation");
    expect(await coordinateCatalogCampaigns()).toMatchObject({ observed: 1 });
    expect(await prisma.catalogCampaign.findUnique({ where: { id: run.id } })).toMatchObject({
      status: "blocked",
      summary: { reason: "catalog_reconciliation_active" },
    });
    expect(await prisma.collectionTask.findUnique({ where: { id: manual.taskId } })).toMatchObject({
      status: "queued",
    });
  });
  it("does not acknowledge completion before the reconciliation worker finishes its task; counters remain explicit", async () => {
    const run = await start();
    await prisma.catalogSync.updateMany({
      where: { ownerId: owner },
      data: { status: "completed", processed: 3, createdCount: 1, existingCount: 2 },
    });
    await prisma.collectionTask.updateMany({ where: { ownerId: owner }, data: { status: "completed" } });
    await coordinateCatalogCampaigns();
    const pending = await prisma.catalogCampaign.findUniqueOrThrow({ where: { id: run.id } });
    expect(pending.status).toBe("reconciliation");
    expect(pending.reconciliationId).toBeTruthy();
    await prisma.catalogReconciliation.update({
      where: { id: pending.reconciliationId! },
      data: { status: "completed", finishedAt: new Date() },
    });
    await coordinateCatalogCampaigns();
    expect((await prisma.catalogCampaign.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("reconciliation");
    await prisma.collectionTask.updateMany({
      where: { ownerId: owner, kind: "catalog-reconcile" },
      data: { status: "completed" },
    });
    await coordinateCatalogCampaigns();
    const ended = await prisma.catalogCampaign.findUniqueOrThrow({ where: { id: run.id } });
    expect(ended.status).toBe("completed");
    expect(ended.finishedAt).toBeTruthy();
    expect(ended.summary).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ new: 1, existing: 2, processed: 3 })]),
    });
  });
});
