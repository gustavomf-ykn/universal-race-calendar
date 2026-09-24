import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, setTaskLease } from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";
import { syncCatalog } from "../apps/worker/src/catalog.js";

const enabled = Boolean(process.env.DATABASE_URL);
const prefix = "ops-test-" + randomUUID();
const headers = { "x-api-key": "test-internal-key" };
describe.skipIf(!enabled)("panel operations on isolated database", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    process.env.INTERNAL_API_KEY = headers["x-api-key"];
    app = await buildApp();
  });
  afterAll(async () => {
    if (!app) return;
    const tasks = await prisma.collectionTask.findMany({ where: { idempotencyKey: { startsWith: prefix } } });
    await prisma.exportArtifact.deleteMany({ where: { taskId: { in: tasks.map((t) => t.id) } } });
    await prisma.collectionTask.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
    await prisma.catalogSync.deleteMany({
      where: { id: { in: tasks.map((t) => (t.payload as { syncId?: string }).syncId ?? "none") } },
    });
    const events = await prisma.event.findMany({
      where: { OR: [{ id: { startsWith: prefix } }, { sourceExternalId: { startsWith: prefix } }] },
    });
    await prisma.adminAudit.deleteMany({ where: { eventId: { in: events.map((e) => e.id) } } });
    await prisma.event.deleteMany({ where: { id: { in: events.map((e) => e.id) } } });
    await prisma.source.deleteMany({ where: { externalId: { startsWith: prefix } } });
    await app.close();
  });
  it("checkpoints candidates, rejects unauthenticated administration and preserves independent editions", async () => {
    expect((await app.inject({ url: "/v1/admin/catalog/events" })).statusCode).toBe(401);
    const payload = { source: "ticketsports", states: ["SC"], batchSize: 1, snapshotLimit: 5 };
    const create = () =>
      app.inject({
        url: "/v1/admin/syncs",
        method: "POST",
        headers: { ...headers, "idempotency-key": prefix },
        payload,
      });
    const first = await create();
    expect(first.statusCode, first.body).toBe(202);
    const body = first.json();
    expect((await create()).json().id).toBe(body.id);
    const token = randomUUID();
    const task = await prisma.collectionTask.update({
      where: { id: body.id },
      data: { status: "running", leaseToken: token, leaseUntil: new Date(Date.now() + 60000) },
    });
    setTaskLease(task);
    const rows = [1, 2].map((n) => ({
      externalId: prefix + n,
      name: "Mesmo nome",
      url: "https://www.ticketsports.com.br/e/test-" + n,
      city: "Teste",
      state: "SC",
      date: `202${n}-01-01`,
    }));
    expect(await syncCatalog(task.payload as Record<string, unknown>, async () => rows)).toMatchObject({
      created: 1,
      processed: 1,
    });
    expect(
      await syncCatalog(task.payload as Record<string, unknown>, async () => {
        throw Error("must_reuse_snapshot");
      }),
    ).toMatchObject({ created: 1, processed: 1 });
    expect(await prisma.event.count({ where: { sourceExternalId: { startsWith: prefix } } })).toBe(2);
    const events = await prisma.event.findMany({ where: { sourceExternalId: { startsWith: prefix } } });
    expect(events.every((e) => e.publicationStatus === "pending_review")).toBe(true);
    const invalid = await app.inject({
      url: `/v1/admin/catalog/events/${events[0]!.id}`,
      method: "PATCH",
      headers,
      payload: { publicationStatus: "published", date: null, reason: "test review" },
    });
    expect(invalid.statusCode).toBe(409);
    const reviewed = await app.inject({
      url: `/v1/admin/catalog/events/${events[0]!.id}`,
      method: "PATCH",
      headers,
      payload: { publicationStatus: "hidden", reason: "test review" },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(await prisma.adminAudit.count({ where: { eventId: events[0]!.id } })).toBe(1);
    await prisma.collectionTask.update({ where: { id: body.id }, data: { status: "completed" } });
    const sync = await prisma.catalogSync.findUniqueOrThrow({ where: { id: body.syncId } });
    expect(sync.status).toBe("limited");
    expect(sync.coverage).toBe("bounded_snapshot");
  });
  it("exports all matching pages atomically and history is scoped to owner", async () => {
    await prisma.event.createMany({
      data: Array.from({ length: 21 }, (_, n) => ({
        id: prefix + "export" + n,
        slug: prefix + "export" + n,
        name: prefix + "export",
        canonicalFingerprint: prefix + n,
        warnings: [],
        publishabilityReasons: [],
      })),
    });
    const payload = { kind: "catalog-full", filter: { q: prefix + "export" }, layout: "consolidated" };
    const create = () =>
      app.inject({
        url: "/v1/exports",
        method: "POST",
        headers: { ...headers, "idempotency-key": prefix + "export" },
        payload,
      });
    const response = await create();
    expect(response.statusCode, response.body).toBe(202);
    const artifact = await prisma.exportArtifact.findUniqueOrThrow({ where: { id: response.json().id } });
    expect((artifact.selection as { eventIds: string[] }).eventIds).toHaveLength(21);
    expect((await create()).json().id).toBe(artifact.id);
    const conflict = await app.inject({
      url: "/v1/exports",
      method: "POST",
      headers: { ...headers, "idempotency-key": prefix + "export" },
      payload: { ...payload, kind: "catalog-simple" },
    });
    expect(conflict.statusCode).toBe(409);
    expect((await app.inject({ url: "/v1/exports", headers })).statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/exports" })).statusCode).toBe(401);
  });
});
