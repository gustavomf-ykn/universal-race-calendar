import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "../apps/api/node_modules/jose/dist/webapi/index.js";
import { prisma } from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";

const prefix = "result-retry-test-" + randomUUID();
describe.skipIf(!process.env.DATABASE_URL)("authenticated result checkpoint retries in disposable PostgreSQL", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let authServer: Server;
  let signingKey: any;
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  const ids: string[] = [];
  beforeAll(async () => {
    const uri = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(uri.hostname) || !uri.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    process.env.INTERNAL_API_KEY = "test-internal-key";
    const keys = await generateKeyPair("ES256");
    signingKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: prefix, alg: "ES256" };
    authServer = createServer((req, res) => {
      if (req.url !== "/auth/v1/.well-known/jwks.json") {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    const address = authServer.address();
    if (!address || typeof address === "string") throw Error("isolated_auth_server_required");
    process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
    app = await buildApp();
  });
  afterAll(async () => {
    const tasks = await prisma.collectionTask.findMany({
      where: { OR: [{ ownerId: prefix }, { idempotencyKey: { startsWith: prefix } }] },
    });
    await prisma.resultCheckpoint.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.adminAudit.deleteMany({
      where: { OR: [{ taskId: { in: tasks.map((t) => t.id) } }, { eventId: { in: ids } }] },
    });
    await prisma.collectionTask.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
    await prisma.event.deleteMany({ where: { id: { in: ids } } });
    await prisma.source.deleteMany({ where: { id: { in: ids } } });
    await app?.close();
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
  });
  async function fixture(suffix: string) {
    const id = prefix + suffix;
    ids.push(id);
    const url = `https://openresults.run/evento/${id}/`;
    await prisma.source.create({
      data: { id, name: "Fixture", url, type: "official_page", adapter: "openresults", externalId: id },
    });
    await prisma.event.create({
      data: {
        id,
        slug: id,
        name: "Fixture",
        date: new Date("2026-01-01"),
        city: "Teste",
        state: "SC",
        country: "BR",
        canonicalFingerprint: id,
        warnings: [],
        publishabilityReasons: [],
      },
    });
    await prisma.eventSourceReference.create({
      data: { eventId: id, sourceId: id, sourceType: "openresults", sourceExternalId: id, url },
    });
    const task = await prisma.collectionTask.create({
      data: {
        id,
        ownerId: prefix,
        idempotencyKey: id,
        requestHash: id,
        kind: "extract",
        source: "openresults",
        status: "failed",
        payload: { eventId: id, externalId: id, url },
      },
    });
    await prisma.resultCheckpoint.create({
      data: {
        rootTaskId: id,
        activeTaskId: id,
        eventId: id,
        externalId: id,
        sourceUrl: url,
        parserVersion: 2,
        pageSize: 1000,
        manifestHash: "fixture",
        manifest: {
          privateFixture: "not-in-response",
          metadata: {
            name: "Fixture",
            event_date: "2026-01-01",
            city: "Teste",
            state: "SC",
            country: "BR",
            event_id: id,
            source_url: url,
          },
        },
        groups: { create: [{ modalityValue: "5k", gender: "F", pageCount: 2, recordCount: 3, nextOffset: 3 }] },
      },
    });
    return task;
  }
  const retry = (id: string, key: string, mode = "resume") =>
    app.inject({
      method: "POST",
      url: `/v1/tasks/${id}/retry`,
      headers: { "x-api-key": "test-internal-key", "idempotency-key": prefix + key },
      payload: { mode },
    });

  it("publishes safe counters only and rejects administration without authentication", async () => {
    const old = await fixture("summary");
    const noAuth = await app.inject({
      method: "POST",
      url: `/v1/tasks/${old.id}/retry`,
      headers: { "idempotency-key": "fixture" },
      payload: { mode: "resume" },
    });
    expect(noAuth.statusCode).toBe(401);
    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${old.id}`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().checkpoint).toMatchObject({ available: true, pages: 2, records: 3, completedGroups: 0 });
    expect(response.body).not.toContain("privateFixture");
    expect(response.body).not.toContain("not-in-response");
  });
  it("lost response and concurrent clicks create one retry; another key cannot take the active checkpoint", async () => {
    const old = await fixture("resume");
    const [first, replay] = await Promise.all([retry(old.id, "resume-1"), retry(old.id, "resume-1")]);
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(first.json().id).toBe(replay.json().id);
    const child = await prisma.collectionTask.findUniqueOrThrow({ where: { id: first.json().id } });
    expect(child.payload).toMatchObject({ checkpointOf: old.id, retryOf: old.id, retryMode: "resume" });
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("failed");
    expect((await retry(old.id, "resume-2")).json()).toEqual({ error: "result_checkpoint_in_use" });
    expect(await prisma.adminAudit.count({ where: { taskId: child.id, action: "retry_task" } })).toBe(1);
    await prisma.collectionTask.update({ where: { id: child.id }, data: { status: "completed" } });
    await prisma.resultCheckpoint.update({ where: { rootTaskId: old.id }, data: { status: "published" } });
    expect((await retry(old.id, "resume-1")).json().id).toBe(child.id);
    const changed = await retry(old.id, "resume-1", "restart");
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("idempotency_conflict");
  });
  it("intentional restart of a failed resumed task creates a fresh extraction, with no old checkpoint pointer", async () => {
    const old = await fixture("restart");
    const resumed = await retry(old.id, "restart-parent");
    const childId = resumed.json().id;
    await prisma.collectionTask.update({ where: { id: childId }, data: { status: "failed" } });
    const fresh = await retry(childId, "restart-fresh", "restart");
    expect(fresh.statusCode).toBe(202);
    const payload = (await prisma.collectionTask.findUniqueOrThrow({ where: { id: fresh.json().id } })).payload as any;
    expect(payload.retryMode).toBe("restart");
    expect(payload.retryOf).toBe(childId);
    expect(payload).not.toHaveProperty("checkpointOf");
    expect((await retry(childId, "restart-fresh", "restart")).json().id).toBe(fresh.json().id);
  });
  it("refuses expired or incompatible checkpoints instead of silently restarting", async () => {
    const expired = await fixture("expired");
    await prisma.resultCheckpoint.update({ where: { rootTaskId: expired.id }, data: { expiresAt: new Date(0) } });
    expect((await retry(expired.id, "expired")).json().error).toBe("result_checkpoint_expired");
    const incompatible = await fixture("incompatible");
    await prisma.resultCheckpoint.update({ where: { rootTaskId: incompatible.id }, data: { parserVersion: 1 } });
    expect((await retry(incompatible.id, "incompatible")).json().error).toBe("result_checkpoint_incompatible");
    expect(
      (await prisma.resultCheckpoint.findUniqueOrThrow({ where: { rootTaskId: incompatible.id } })).parserVersion,
    ).toBe(1);
    expect(
      await prisma.collectionTask.count({ where: { payload: { path: ["retryOf"], equals: incompatible.id } } }),
    ).toBe(0);
    const reassociated = await fixture("association");
    await prisma.eventSourceReference.updateMany({
      where: { eventId: reassociated.id },
      data: { url: "https://openresults.run/evento/changed/" },
    });
    expect((await retry(reassociated.id, "association")).json().error).toBe("association_changed");
  });
  it.each([
    ["city", "Outra cidade", "edition_location_conflict"],
    ["state", "PR", "edition_location_conflict"],
    ["country", "PT", "edition_location_conflict"],
    ["country", "não reconhecido", "edition_location_unconfirmed"],
    ["event_date", null, "edition_date_unconfirmed"],
    ["event_date", "2027-01-01", "edition_date_mismatch"],
    ["source_url", "https://openresults.run/evento/another/", "association_changed"],
    ["event_id", "another", "source_identity_mismatch"],
  ])("refuses resume with changed %s evidence before enqueueing a task", async (field, value, reason) => {
    const old = await fixture(`evidence-${field}-${reason}`);
    const root = await prisma.resultCheckpoint.findUniqueOrThrow({ where: { rootTaskId: old.id } });
    const manifest = root.manifest as any;
    manifest.metadata[field!] = value;
    await prisma.resultCheckpoint.update({ where: { rootTaskId: old.id }, data: { manifest } });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${old.id}`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(response.json().checkpoint).toMatchObject({ available: false, reason, pages: 2, records: 3 });
    expect(response.body).not.toContain("privateFixture");
    const rejected = await retry(old.id, `evidence-${field}-${reason}`);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: reason });
    expect(await prisma.collectionTask.count({ where: { payload: { path: ["retryOf"], equals: old.id } } })).toBe(0);
    expect((await prisma.resultCheckpoint.findUniqueOrThrow({ where: { rootTaskId: old.id } })).status).toBe(
      root.status,
    );
  });
  it("rechecks current location and respects reviewed overrides without accepting a changed date", async () => {
    const old = await fixture("current-location");
    await prisma.event.update({ where: { id: old.id }, data: { city: "Cidade revisada" } });
    expect((await retry(old.id, "unreviewed-location")).json()).toEqual({ error: "edition_location_conflict" });
    await prisma.adminAudit.create({
      data: {
        actorId: prefix,
        action: "review_event",
        eventId: old.id,
        details: { changes: { city: "Cidade revisada", date: "2026-01-01" } },
      },
    });
    const summary = await app.inject({
      method: "GET",
      url: `/v1/tasks/${old.id}`,
      headers: { "x-api-key": "test-internal-key" },
    });
    expect(summary.json().checkpoint).toMatchObject({ available: true });
    await prisma.event.update({ where: { id: old.id }, data: { date: new Date("2027-01-01") } });
    expect((await retry(old.id, "reviewed-date-conflict")).json()).toEqual({ error: "edition_date_mismatch" });
    expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("failed");
  });
  it("keeps a known country when the compatible pinned snapshot has no country", async () => {
    const old = await fixture("partial-country");
    const root = await prisma.resultCheckpoint.findUniqueOrThrow({ where: { rootTaskId: old.id } });
    const manifest = root.manifest as any;
    manifest.metadata.country = "";
    await prisma.resultCheckpoint.update({ where: { rootTaskId: old.id }, data: { manifest } });
    expect((await retry(old.id, "partial-country")).statusCode).toBe(202);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: old.id } })).country).toBe("BR");
  });
  it("requires signed JWT admin metadata for result resume, never frontend-controlled user metadata", async () => {
    const old = await fixture("jwt");
    const token = (claims: Record<string, unknown>) =>
      new SignJWT({ role: "authenticated", ...claims })
        .setProtectedHeader({ alg: "ES256", kid: prefix })
        .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
        .setAudience("authenticated")
        .setSubject(prefix)
        .setExpirationTime("5m")
        .sign(signingKey);
    const request = (jwt: string) =>
      app.inject({
        method: "POST",
        url: `/v1/tasks/${old.id}/retry`,
        headers: { authorization: `Bearer ${jwt}`, "idempotency-key": prefix + "jwt-retry" },
        payload: { mode: "resume" },
      });
    expect((await request(await token({ user_metadata: { role: "admin" } }))).statusCode).toBe(403);
    expect((await request(await token({ app_metadata: { role: "admin" } }))).statusCode).toBe(202);
  });
});
