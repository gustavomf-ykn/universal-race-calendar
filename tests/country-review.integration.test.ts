import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "../apps/api/node_modules/jose/dist/webapi/index.js";
import { prisma } from "@race-calendar/database";
import { buildApp } from "../apps/api/src/app.js";

const prefix = "country-review-" + randomUUID();
describe.skipIf(!process.env.DATABASE_URL)("country confirmation through authenticated administration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>, server: Server, signingKey: any;
  let adminToken: string, userToken: string;
  const previousUrl = process.env.SUPABASE_URL;
  const ids: string[] = [];
  beforeAll(async () => {
    const uri = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(uri.hostname) || !uri.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    process.env.INTERNAL_API_KEY = "test-internal-key";
    const keys = await generateKeyPair("ES256");
    signingKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: prefix, alg: "ES256" };
    server = createServer((req, res) => {
      if (req.url !== "/auth/v1/.well-known/jwks.json") { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("isolated_auth_server_required");
    process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
    const token = (admin: boolean) => new SignJWT({ role: "authenticated", app_metadata: { role: admin ? "admin" : "user" } })
      .setProtectedHeader({ alg: "ES256", kid: prefix }).setSubject(prefix + (admin ? "admin" : "user"))
      .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`).setAudience("authenticated").setExpirationTime("5m").sign(signingKey);
    adminToken = await token(true);
    userToken = await token(false);
    app = await buildApp();
  });
  afterAll(async () => {
    await prisma.adminAudit.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.event.deleteMany({ where: { id: { in: ids } } });
    await app?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
  });
  async function edition(country: string | null) {
    const id = prefix + ids.length;
    ids.push(id);
    return prisma.event.create({ data: { id, slug: id, name: id, date: new Date("2040-10-10"),
      city: "Garuva", state: "SC", country, sourceType: "ticketsports", sourceExternalId: id,
      sourceUrl: "https://www.ticketsports.com.br/e/test-123", canonicalFingerprint: id,
      warnings: ["country_unconfirmed"], publishabilityReasons: ["country_unconfirmed"],
      publicationStatus: "pending_review", modality: "road" } });
  }
  const patch = (id: string, token: string | null, body: object) => app.inject({ method: "PATCH",
    url: `/v1/admin/catalog/events/${id}`, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: body });
  it("rejects anonymous and non-admin country corrections without creating audit records", async () => {
    const event = await edition(null), body = { country: "BR", reason: "País confirmado na fonte" };
    expect((await patch(event.id, null, body)).statusCode).toBe(401);
    expect((await patch(event.id, userToken, body)).statusCode).toBe(403);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).country).toBeNull();
    expect(await prisma.adminAudit.count({ where: { eventId: event.id } })).toBe(0);
  });
  it("keeps complete city/UF candidates administratively incomplete and prevents both publication paths", async () => {
    for (const country of [null, "PT"]) {
      const event = await edition(country);
      const response = await patch(event.id, adminToken, { publicationStatus: "published", reason: "Revisar edição" });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toBe("publication_requires_brazil_country");
      const legacy = await app.inject({ method: "POST", url: `/v1/admin/events/${event.id}/publish`,
        headers: { "x-api-key": "test-internal-key" } });
      expect(legacy.statusCode, legacy.body).toBe(409);
      expect(legacy.json().error).toBe("publication_requires_brazil_country");
      if (country === null) {
        const list = await app.inject({ url: `/v1/admin/catalog/events?q=${event.id}&incomplete=true`,
          headers: { authorization: `Bearer ${adminToken}` } });
        expect(list.statusCode, list.body).toBe(200);
        expect(list.json().pagination.total).toBe(1);
      }
    }
  });
  it("allows an admin to confirm country and records the unknown value before the correction", async () => {
    const event = await edition(null);
    expect((await patch(event.id, adminToken, { country: "Brasil", reason: "Confirmado" })).statusCode).toBe(400);
    expect((await patch(event.id, adminToken, { country: "BR" })).statusCode).toBe(400);
    const result = await patch(event.id, adminToken, { country: "BR", publicationStatus: "published",
      reason: "País e localização confirmados na página da edição" });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().event).toMatchObject({ country: "BR", publicationStatus: "published", administrativeReview: true });
    expect(result.json().event.warnings).not.toContain("country_unconfirmed");
    expect(result.json().event.publishabilityReasons).not.toContain("country_unconfirmed");
    const audit = await prisma.adminAudit.findFirstOrThrow({ where: { eventId: event.id } });
    expect(audit.actorId).toBe("user:" + prefix + "admin");
    expect(audit.details).toMatchObject({ before: { country: null }, changes: { country: "BR", publicationStatus: "published" } });
    const erase = await patch(event.id, adminToken, { country: null, reason: "Remover país não comprovado" });
    expect(erase.statusCode).toBe(409);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).country).toBe("BR");
    const hide = await patch(event.id, adminToken, { country: null, publicationStatus: "hidden", reason: "Remover país não comprovado" });
    expect(hide.statusCode, hide.body).toBe(200);
    expect(hide.json().event).toMatchObject({ country: null, publicationStatus: "hidden" });
  });
  it("requires confirmed modality on both publication paths and includes unknown candidates in review", async () => {
    const event = await edition("BR");
    await prisma.event.update({ where: { id: event.id }, data: { modality: "unknown",
      warnings: ["modality_unconfirmed"], publishabilityReasons: ["modality_unconfirmed"] } });
    const list = await app.inject({ url: `/v1/admin/catalog/events?q=${event.id}&incomplete=true`,
      headers: { authorization: `Bearer ${adminToken}` } });
    expect(list.json().pagination.total).toBe(1);
    const request = { publicationStatus: "published", reason: "Revisar edição" };
    expect((await patch(event.id, adminToken, request)).json().error).toBe("publication_requires_confirmed_modality");
    const legacy = await app.inject({ method: "POST", url: `/v1/admin/events/${event.id}/publish`,
      headers: { "x-api-key": "test-internal-key" } });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().error).toBe("publication_requires_confirmed_modality");
    expect((await patch(event.id, userToken, { modality: "trail", reason: "Confirmar trilha" })).statusCode).toBe(403);
    expect((await patch(event.id, adminToken, { modality: "asphalt", reason: "Confirmar rua" })).statusCode).toBe(400);
    expect((await patch(event.id, adminToken, { modality: "trail" })).statusCode).toBe(400);
    expect(await prisma.adminAudit.count({ where: { eventId: event.id } })).toBe(0);
  });
  it("audits confirmation, prevents erasing published modality and preserves country review together", async () => {
    const event = await edition(null);
    await prisma.event.update({ where: { id: event.id }, data: { modality: "unknown",
      warnings: ["country_unconfirmed", "country_evidence_mismatch", "modality_unconfirmed", "modality_evidence_mismatch"],
      publishabilityReasons: ["country_unconfirmed", "modality_unconfirmed"] } });
    const result = await patch(event.id, adminToken, { country: "BR", modality: "trail", publicationStatus: "published",
      reason: "País e modalidade conferidos na fonte" });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().event).toMatchObject({ country: "BR", modality: "trail", warnings: [], publishabilityReasons: [] });
    expect((await prisma.adminAudit.findFirstOrThrow({ where: { eventId: event.id } })).details)
      .toMatchObject({ before: { country: null, modality: "unknown" }, changes: { country: "BR", modality: "trail" } });
    expect((await patch(event.id, adminToken, { modality: "unknown", reason: "Remover dado não comprovado" })).statusCode).toBe(409);
    const hide = await patch(event.id, adminToken, { modality: "unknown", publicationStatus: "hidden", reason: "Remover dado não comprovado" });
    expect(hide.statusCode, hide.body).toBe(200);
    expect(hide.json().event).toMatchObject({ modality: "unknown", publicationStatus: "hidden" });
    expect(hide.json().event.warnings).toContain("modality_unconfirmed");
  });
});
