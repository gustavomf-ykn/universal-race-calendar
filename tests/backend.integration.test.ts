import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import * as jose from "../apps/api/node_modules/jose/dist/webapi/index.js";
import { buildApp } from "../apps/api/src/app.js";
import { claimTask, enqueueTask, finishTask, heartbeatTask, prisma } from "@race-calendar/database";
import { importTicketSportsEvents } from "@race-calendar/curation";
import { SourceAdapterRegistry, TicketSportsAdapter } from "@race-calendar/sources";

const admin = { "x-api-key": "test-internal-key" };
function assertIsolated() {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
    throw new Error("Tests require an isolated local database ending in _test");
}
function fixture(mode: string, source: string, id: string) {
  return new Promise<void>((res, rej) => {
    const child = spawn(process.env.TEST_PYTHON ?? "python", ["-m", "tests.fixture_task", mode, source, id], {
      cwd: resolve("apps/openresults-worker"),
      env: { ...process.env, WORKER_DATABASE_URL: process.env.DATABASE_URL!.split("?")[0]! },
    });
    let errors = "";
    child.stderr.on("data", (data) => {
      errors += String(data);
    });
    child.on("error", rej);
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(errors))));
  });
}
describe.skipIf(!process.env.DATABASE_URL)("unified backend with PostgreSQL and Python fixtures", () => {
  let app: Awaited<ReturnType<typeof buildApp>>, server: Server, eventId: string, matchId: string, exportId: string;
  let clientKey: string, keyId: string;
  const objects = new Map<string, Buffer>();
  let signingKey: any, jwk: unknown;
  beforeAll(async () => {
    assertIsolated();
    process.env.INTERNAL_API_KEY = "test-internal-key";
    const keys = await jose.generateKeyPair("ES256");
    signingKey = keys.privateKey;
    jwk = { ...(await jose.exportJWK(keys.publicKey)), kid: "fixture", alg: "ES256" };
    await prisma.exportArtifact.deleteMany();
    await prisma.raceResult.deleteMany();
    await prisma.raceDiscipline.deleteMany();
    await prisma.resultSet.deleteMany();
    await prisma.sourceMatch.deleteMany();
    await prisma.collectionTask.deleteMany();
    await prisma.apiCredential.deleteMany();
    await prisma.curationJob.deleteMany();
    await prisma.extractionJob.deleteMany();
    await prisma.rawSourceExtraction.deleteMany();
    await prisma.event.deleteMany();
    await prisma.source.deleteMany();
    await prisma.importRun.deleteMany();
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const path = req.url!;
      if (path.startsWith("/storage/v1/")) {
        if (req.headers.apikey !== "sb_secret_fixture" || req.headers.authorization) {
          res.statusCode = 401;
          res.end("{}");
          return;
        }
      }
      if (path === "/auth/v1/.well-known/jwks.json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
      } else if (req.method === "POST" && path.startsWith("/storage/v1/object/sign/")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ signedURL: "/object/sign/race-exports/test?token=fixture" }));
      } else if (req.method === "POST" && path === "/storage/v1/object/list/race-exports") {
        const prefix = JSON.parse(Buffer.concat(chunks).toString()).prefix;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            [...objects.keys()]
              .filter((key) => key.startsWith(`/storage/v1/object/race-exports/${prefix}`))
              .map((key) => ({ name: key.split("/").at(-1) })),
          ),
        );
      } else if (req.method === "POST") {
        objects.set(path, Buffer.concat(chunks));
        res.end("{}");
      } else if (req.method === "DELETE") {
        for (const p of JSON.parse(Buffer.concat(chunks).toString()).prefixes)
          objects.delete(`/storage/v1/object/race-exports/${p}`);
        res.end("{}");
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_fixture";
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    server?.close();
    await prisma.exportArtifact.deleteMany();
    await prisma.resultSet.deleteMany();
    await prisma.sourceMatch.deleteMany();
    await prisma.collectionTask.deleteMany();
    await prisma.apiCredential.deleteMany();
    await prisma.$disconnect();
  });
  it("discovers a calendar event through the existing TicketSports adapter", async () => {
    const detail = JSON.parse(readFileSync("tests/fixtures/ticketsports-simple.json", "utf8"));
    detail.eventId = "integrated-fixture";
    detail.uri = "https://www.ticketsports.com.br/e/integrated-fixture";
    const adapter = new TicketSportsAdapter({ getJson: async () => detail, getText: async () => "" });
    const registry = new SourceAdapterRegistry({ adapters: [adapter] });
    // Exercise the same importer used by the TS executor without a real collection.
    const result = await importTicketSportsEvents({
      quantity: 1,
      concurrency: 1,
      delayMs: 0,
      force: true,
      discoverEvents: async () => [
        {
          sourceType: "ticketsports",
          adapter: "ticketsports",
          externalId: "integrated-fixture",
          name: detail.title,
          url: detail.uri,
          country: "BR",
          state: "SC",
          city: "Florianopolis",
          metadata: { listItem: detail },
        },
      ],
      registry,
    });
    expect(result.failedCount).toBe(0);
    expect(result.publishedEvents).toBe(1);
    const event = await prisma.event.findFirstOrThrow({
      where: { name: "Meia Maratona de Florianopolis", publicationStatus: "published" },
    });
    eventId = event.id;
    expect((await app.inject({ method: "GET", url: `/v1/events/${eventId}` })).statusCode).toBe(200);
  });
  it("rejects unauthenticated collection and inspects a source in a separate Python process", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/v1/collections", payload: { source: "ticketsports" } })).statusCode,
    ).toBe(401);
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/source-matches",
      headers: { ...admin, "idempotency-key": "inspect-fixture" },
      payload: { url: "https://openresults.run/evento/fixture/" },
    });
    expect(response.statusCode).toBe(202);
    await fixture("inspect", "openresults", response.json().id);
    const matches = await app.inject({ method: "GET", url: "/v1/admin/source-matches", headers: admin });
    matchId = matches.json().data[0].id;
    expect(matches.json().data[0].status).toBe("pending");
  });
  it("refuses a different annual edition and resolves the matching edition", async () => {
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const other = await prisma.event.upsert({
      where: { slug: "fixture-next-year" },
      update: {},
      create: {
        name: event.name,
        slug: "fixture-next-year",
        date: new Date("2027-08-16"),
        canonicalFingerprint: "fixture-next-year",
        warnings: [],
        publishabilityReasons: [],
      },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/v1/admin/source-matches/${matchId}/resolve`,
      headers: admin,
      payload: { eventId: other.id },
    });
    expect(denied.statusCode).toBe(409);
    const allowed = await app.inject({
      method: "POST",
      url: `/v1/admin/source-matches/${matchId}/resolve`,
      headers: admin,
      payload: { eventId },
    });
    expect(allowed.statusCode).toBe(200);
    expect(await prisma.eventSourceReference.count({ where: { eventId, sourceType: "openresults" } })).toBe(1);
  });
  it("deduplicates API requests and safely repeats published extraction", async () => {
    const submit = (key: string) =>
      app.inject({
        method: "POST",
        url: "/v1/collections",
        headers: { ...admin, "idempotency-key": key },
        payload: { source: "openresults", eventId },
      });
    const first = await submit("extract-fixture");
    expect(first.statusCode).toBe(202);
    expect((await submit("extract-fixture")).json().id).toBe(first.json().id);
    await fixture("extract", "openresults", first.json().id);
    const second = await submit("extract-fixture-again");
    await fixture("extract", "openresults", second.json().id);
    expect(await prisma.raceResult.count({ where: { resultSet: { eventId } } })).toBe(1);
    expect(
      (await app.inject({ method: "GET", url: `/v1/tasks/${second.json().id}`, headers: admin })).json().status,
    ).toBe("completed");
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/collections",
      headers: { ...admin, "idempotency-key": "extract-fixture" },
      payload: { source: "ticketsports" },
    });
    expect(conflict.statusCode).toBe(409);
  });
  it("preserves the last valid result after failures and incomplete extraction", async () => {
    const previous = await prisma.resultSet.findFirstOrThrow({ where: { eventId } });
    for (const mode of ["fail", "partial"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/collections",
        headers: { ...admin, "idempotency-key": mode },
        payload: { source: "openresults", eventId },
      });
      await fixture(mode, "openresults", response.json().id);
      const task = await prisma.collectionTask.findUniqueOrThrow({ where: { id: response.json().id } });
      expect(task.status).toBe(mode === "fail" ? "queued" : "partial");
      if (task.status === "queued")
        await prisma.collectionTask.update({ where: { id: task.id }, data: { status: "cancelled" } });
      expect((await prisma.resultSet.findUniqueOrThrow({ where: { id: previous.id } })).contentHash).toBe(
        previous.contentHash,
      );
    }
  });
  it("recovers after a real Python executor is terminated during extraction", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/collections",
      headers: { ...admin, "idempotency-key": "killed-worker" },
      payload: { source: "openresults", eventId },
    });
    const id = response.json().id;
    const child = spawn(process.env.TEST_PYTHON ?? "python", ["-m", "tests.fixture_task", "pause", "openresults", id], {
      cwd: resolve("apps/openresults-worker"),
      env: { ...process.env, WORKER_DATABASE_URL: process.env.DATABASE_URL!.split("?")[0]! },
    });
    try {
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error("executor did not claim")), 10000);
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("fixture_claimed")) {
            clearTimeout(timer);
            done();
          }
        });
        child.once("error", fail);
      });
      const stopped = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGKILL");
      await stopped;
      expect((await prisma.collectionTask.findUniqueOrThrow({ where: { id } })).status).toBe("running");
      // Advance only the lease in the isolated database instead of waiting 90 s.
      await prisma.collectionTask.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
      await fixture("extract", "openresults", id);
      expect(await prisma.collectionTask.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "completed",
        attempt: 2,
      });
      expect(await prisma.raceResult.count({ where: { resultSet: { eventId } } })).toBe(1);
    } finally {
      child.kill("SIGKILL");
    }
  });
  it("migrates a synthetic SQLite copy twice without duplicating permanent results", async () => {
    await new Promise<void>((done, fail) => {
      const child = spawn(process.env.TEST_PYTHON ?? "python", ["-m", "tests.fixture_migration", eventId], {
        cwd: resolve("apps/openresults-worker"),
        env: { ...process.env, WORKER_DATABASE_URL: process.env.DATABASE_URL!.split("?")[0]! },
      });
      let errors = "";
      child.stderr.on("data", (data) => {
        errors += String(data);
      });
      child.once("error", fail);
      child.once("exit", (code) => (code === 0 ? done() : fail(new Error(errors))));
    });
    expect(await prisma.resultSet.count({ where: { eventId } })).toBe(1);
    expect(await prisma.raceResult.count({ where: { resultSet: { eventId } } })).toBe(1);
  });
  it("enforces scoped, hashed and revocable client keys with shared rate limits", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: admin,
      payload: { name: "fixture", scopes: ["results:read", "exports:write", "tasks:read"], limitPerHour: 20 },
    });
    expect(created.statusCode).toBe(201);
    clientKey = created.json().key;
    keyId = created.json().id;
    expect((await prisma.apiCredential.findUniqueOrThrow({ where: { id: keyId } })).keyHash).not.toBe(clientKey);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/events/${eventId}/results`,
          headers: { "x-client-key": clientKey },
        })
      ).json().pagination.total,
    ).toBe(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/collections",
          headers: { "x-client-key": clientKey },
          payload: { source: "ticketsports" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/events/${eventId}/results`,
          headers: { authorization: "Bearer invalid" },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("exports XLSX to isolated fixture Storage, then survives API restart", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/events/${eventId}/exports`,
      headers: { "x-client-key": clientKey, "idempotency-key": "export-fixture" },
    });
    expect(response.statusCode).toBe(202);
    exportId = response.json().id;
    await fixture("export", "exports", response.json().taskId);
    expect([...objects.values()][0]?.subarray(0, 2).toString()).toBe("PK");
    await app.close();
    await prisma.$disconnect();
    app = await buildApp();
    const result = await app.inject({
      method: "GET",
      url: `/v1/events/${eventId}/results`,
      headers: { "x-client-key": clientKey },
    });
    expect(result.json().data[0].name).toBe("Fixture Runner");
    const exported = await app.inject({
      method: "GET",
      url: `/v1/exports/${exportId}`,
      headers: { "x-client-key": clientKey },
    });
    expect(exported.json().downloadUrl).toContain("token=fixture");
  });
  it("expires an export and deletes operational history without deleting results", async () => {
    const artifact = await prisma.exportArtifact.update({
      where: { id: exportId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.collectionTask.delete({ where: { id: artifact.taskId } });
    await fixture("cleanup", "exports", artifact.taskId);
    expect(objects.size).toBe(0);
    const expired = await app.inject({
      method: "GET",
      url: `/v1/exports/${exportId}`,
      headers: { "x-client-key": clientKey },
    });
    expect(expired.json()).toMatchObject({ status: "expired", downloadUrl: null });
    expect(await prisma.raceResult.count({ where: { resultSet: { eventId } } })).toBe(1);
    await app.inject({ method: "DELETE", url: `/v1/admin/api-keys/${keyId}`, headers: admin });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/events/${eventId}/results`,
          headers: { "x-client-key": clientKey },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("acquires atomically, recovers abandoned work and rejects a stale lease", async () => {
    await prisma.collectionTask.deleteMany();
    const task = await enqueueTask("fixture", "lease-test", "ticketsports", "calendar", {});
    const claims = await Promise.all([claimTask(["ticketsports"]), claimTask(["ticketsports"])]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await prisma.collectionTask.update({ where: { id: task.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    const recovered = await claimTask(["ticketsports"]);
    expect(recovered?.attempt).toBe(2);
    expect(await heartbeatTask(old, {})).toBe(false);
    expect(await finishTask(old, "completed", {})).toBe(false);
    expect(await finishTask(recovered!, "completed", {})).toBe(true);
  });
  it("verifies Supabase-style JWT signatures, audience, expiry and server-controlled role", async () => {
    const token = (claims: Record<string, unknown>, audience = "authenticated", expiry = "5m") =>
      new jose.SignJWT({ role: "authenticated", ...claims })
        .setProtectedHeader({ alg: "ES256", kid: "fixture" })
        .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
        .setAudience(audience)
        .setSubject("fixture-user")
        .setExpirationTime(expiry)
        .sign(signingKey);
    const request = (jwt: string) =>
      app.inject({ method: "GET", url: "/v1/admin/source-matches", headers: { authorization: `Bearer ${jwt}` } });
    expect((await request(await token({ app_metadata: { role: "admin" } }))).statusCode).toBe(200);
    expect((await request(await token({ user_metadata: { role: "admin" } }))).statusCode).toBe(403);
    expect((await request(await token({ app_metadata: { role: "admin" } }, "other"))).statusCode).toBe(401);
    expect((await request(await token({ app_metadata: { role: "admin" } }, "authenticated", "-1m"))).statusCode).toBe(
      401,
    );
  });
  it("enforces a shared hourly limit and isolates task ownership", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: admin,
      payload: { name: "limited", scopes: ["tasks:read"], limitPerHour: 1 },
    });
    const headers = { "x-client-key": created.json().key };
    const task = await enqueueTask("different-owner", "owned-task", "openresults", "inspect", {});
    expect((await app.inject({ method: "GET", url: `/v1/tasks/${task.id}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/tasks", headers })).statusCode).toBe(429);
  });
  it("revokes explicit Supabase API grants on queue functions and migration history", async () => {
    await fixture("privileges", "maintenance", "unused");
  });
  it("keeps backend tables protected by RLS even with SELECT privileges", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ relrowsecurity: boolean }>
    >`SELECT relrowsecurity FROM pg_class WHERE relname IN ('RaceResult','CollectionTask','ApiCredential','RawSourceExtraction')`;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    await prisma.$executeRawUnsafe(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='test_public_reader') THEN CREATE ROLE test_public_reader; END IF; END $$",
    );
    await prisma.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO test_public_reader");
    await prisma.$executeRawUnsafe('GRANT SELECT ON "RaceResult","CollectionTask" TO test_public_reader');
    const data = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE test_public_reader");
      return tx.$queryRaw<unknown[]>`SELECT * FROM "RaceResult"`;
    });
    expect(data).toHaveLength(0);
  });
});
