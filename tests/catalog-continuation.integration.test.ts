import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, catalogCheckpoint, coordinateCatalogSyncs, controlCatalogSync } from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";

const enabled = Boolean(process.env.DATABASE_URL);
const owner = "continuation-test-" + randomUUID();
describe.skipIf(!enabled)("restart-safe catalog coordination on isolated PostgreSQL", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
  });
  afterAll(async () => {
    await prisma.adminAudit.deleteMany({ where: { actorId: owner } });
    await prisma.collectionTask.deleteMany({ where: { ownerId: owner } });
    await prisma.catalogSync.deleteMany({ where: { ownerId: owner } });
  });
  async function fixture(name: string, source = "openresults", autoContinue = true) {
    const sync = await prisma.catalogSync.create({ data: { id: owner + name, ownerId: owner,
      source, options: { autoContinue, states: ["SC"], batchSize: 5 }, snapshot: [] } });
    const task = await prisma.collectionTask.create({ data: { ownerId: owner, source, kind: "catalog-sync",
      status: "completed", idempotencyKey: name, requestHash: name,
      payload: { syncId: sync.id, checkpointHash: catalogCheckpoint(sync) } } });
    return { sync, task };
  }
  it("queues exactly one successor after a persisted step despite concurrent coordinators and a restart", async () => {
    const { sync } = await fixture("success");
    await prisma.catalogSync.update({ where: { id: sync.id }, data: { cursor: 5 } });
    await Promise.all([coordinateCatalogSyncs(), coordinateCatalogSyncs()]);
    await coordinateCatalogSyncs();
    const next = await prisma.collectionTask.findMany({ where: { ownerId: owner,
      payload: { path: ["syncId"], equals: sync.id }, status: "queued" } });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ source: "openresults", kind: "catalog-sync", executionHold: false });
    expect(next[0]!.payload).toHaveProperty("checkpointHash");
  });
  it("does not claim completion or loop when a successful task did not advance its checkpoint", async () => {
    const { sync } = await fixture("stalled");
    await coordinateCatalogSyncs();
    expect(await prisma.catalogSync.findUnique({ where: { id: sync.id } })).toMatchObject({
      status: "limited", coverage: "catalog_checkpoint_not_advancing" });
  });
  it("preserves protected and manually stepped requests", async () => {
    const held = await fixture("held", "ticketsports");
    await prisma.collectionTask.update({ where: { id: held.task.id }, data: {
      status: "queued", executionHold: true, holdReason: "preexisting_protected_request" } });
    const manual = await fixture("manual", "corridasbr", false);
    await prisma.catalogSync.update({ where: { id: manual.sync.id }, data: { cursor: 2 } });
    await coordinateCatalogSyncs();
    expect(await prisma.collectionTask.count({ where: { ownerId: owner,
      payload: { path: ["syncId"], equals: manual.sync.id } } })).toBe(1);
    expect(await prisma.collectionTask.findUnique({ where: { id: held.task.id } })).toMatchObject({
      status: "queued", executionHold: true, attempt: 0 });
  });
  it("pauses on final failure; explicit resume preserves the failed task and checkpoint", async () => {
    const { sync, task } = await fixture("failed");
    await prisma.collectionTask.update({ where: { id: task.id }, data: {
      status: "failed", errorCode: "source_access_blocked" } });
    await prisma.catalogSync.update({ where: { id: sync.id }, data: { cursor: 7 } });
    await coordinateCatalogSyncs();
    expect(await prisma.catalogSync.findUnique({ where: { id: sync.id } })).toMatchObject({
      status: "blocked", coverage: "source_access_blocked", cursor: 7 });
    await controlCatalogSync(sync.id, owner, "resume", "resume-failed");
    await controlCatalogSync(sync.id, owner, "resume", "resume-failed");
    expect(await prisma.collectionTask.count({ where: { ownerId: owner,
      payload: { path: ["syncId"], equals: sync.id } } })).toBe(2);
    expect(await prisma.collectionTask.findUnique({ where: { id: task.id } })).toMatchObject({ status: "failed" });
    expect(await prisma.catalogSync.findUnique({ where: { id: sync.id } })).toMatchObject({ status: "ready", cursor: 7 });
  });
  it("pause holds only unprotected successors; resume never releases a preexisting hold", async () => {
    const { sync, task } = await fixture("pause");
    await prisma.collectionTask.update({ where: { id: task.id }, data: { status: "queued" } });
    await controlCatalogSync(sync.id, owner, "pause", "pause-request");
    expect(await prisma.collectionTask.findUnique({ where: { id: task.id } })).toMatchObject({
      executionHold: true, holdReason: "catalog_sync_paused" });
    await controlCatalogSync(sync.id, owner, "resume", "resume-request");
    expect(await prisma.collectionTask.findUnique({ where: { id: task.id } })).toMatchObject({ executionHold: false });
    const protectedRequest = await fixture("protected-pause", "ticketsports");
    await prisma.collectionTask.update({ where: { id: protectedRequest.task.id }, data: {
      status: "queued", executionHold: true, holdReason: "preexisting_protected_request" } });
    await controlCatalogSync(protectedRequest.sync.id, owner, "pause", "pause-protected");
    await controlCatalogSync(protectedRequest.sync.id, owner, "resume", "resume-protected");
    expect(await prisma.collectionTask.findUnique({ where: { id: protectedRequest.task.id } })).toMatchObject({
      executionHold: true, holdReason: "preexisting_protected_request" });
  });
  it("pause lets a running step finish, then creates no successor", async () => {
    const { sync, task } = await fixture("running-pause");
    await prisma.collectionTask.update({ where: { id: task.id }, data: { status: "running" } });
    const pausing = await controlCatalogSync(sync.id, owner, "pause", "pause-running");
    expect(pausing.status).toBe("ready");
    await prisma.catalogSync.update({ where: { id: sync.id }, data: { cursor: 3 } });
    await prisma.collectionTask.update({ where: { id: task.id }, data: { status: "completed" } });
    await coordinateCatalogSyncs();
    expect(await prisma.catalogSync.findUnique({ where: { id: sync.id } })).toMatchObject({ status: "paused", cursor: 3 });
  });
  it("replays a continuation after its checkpoint changed without another task and requires admin", async () => {
    const { sync } = await fixture("api-replay", "corridasbr", false);
    const app = await buildApp();
    const headers = { "x-api-key": "test-internal-key", "idempotency-key": "continue-" + sync.id };
    process.env.INTERNAL_API_KEY = headers["x-api-key"];
    const url = `/v1/admin/syncs/${sync.id}/continue`;
    expect((await app.inject({ url, method: "POST" })).statusCode).toBe(401);
    const first = await app.inject({ url, method: "POST", headers });
    expect(first.statusCode, first.body).toBe(202);
    await prisma.collectionTask.update({ where: { id: first.json().id }, data: { status: "completed" } });
    await prisma.catalogSync.update({ where: { id: sync.id }, data: { cursor: 9 } });
    const replay = await app.inject({ url, method: "POST", headers });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json().id).toBe(first.json().id);
    // The API's principal owns this task, unlike the fixture's owner.
    await prisma.collectionTask.delete({ where: { id: first.json().id } });
    await app.close();
  });
});
