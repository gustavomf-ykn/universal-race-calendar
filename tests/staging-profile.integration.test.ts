import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { buildApp } from "../apps/api/src/app.js";
import { prisma } from "@race-calendar/database";
describe.skipIf(!process.env.DATABASE_URL)("pilot scope enforced before enqueue", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "postgres"].includes(target.hostname) || !target.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
    vi.stubEnv("RUNFINDER_PROFILE", "local-staging");
    vi.stubEnv("RUNFINDER_PROFILE_CONFIG", fileURLToPath(new URL("../config/staging-profiles.json", import.meta.url)));
    vi.stubEnv("SUPABASE_URL", "https://gpkodfsofwiroskdmeax.supabase.co");
    vi.stubEnv("INTERNAL_API_KEY", "synthetic-profile-key");
    app = await buildApp();
  });
  afterAll(async () => { await app?.close(); await prisma.$disconnect(); vi.unstubAllEnvs(); });
  it("advertises the exact new project and pilot scope without exposing secrets", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/version" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.supabaseProjectRef).toBe("gpkodfsofwiroskdmeax");
    expect(body.environmentProfile.catalogPilot.states).toEqual(["SC"]);
    expect(response.body).not.toContain("synthetic-profile-key");
  });
  it("rejects administrative requests without credentials and rejects broad scope without creating tasks", async () => {
    const before = await prisma.collectionTask.count();
    const headers = { "x-api-key": "synthetic-profile-key", "idempotency-key": "profile-rejection" };
    const noAuth = await app.inject({ method: "POST", url: "/v1/collections", payload: { source: "ticketsports" } });
    expect(noAuth.statusCode).toBe(401);
    const broad = await app.inject({ method: "POST", url: "/v1/admin/catalog/campaigns", headers,
      payload: { reason: "Controlled pilot", states: ["SC"], batchSize: 25, prefixLimit: 10000 } });
    expect(broad.statusCode).toBe(409);
    expect(broad.json().error).toBe("pilot_scope_exceeded");
    for (const payload of [{ source: "ticketsports", quantity: 6 }, { source: "corridasbr", quantity: 5, states: ["SP"] }]) {
      const r = await app.inject({ method: "POST", url: "/v1/collections", headers, payload });
      expect([400, 409]).toContain(r.statusCode);
    }
    const weekly = await app.inject({ method: "POST", url: "/v1/admin/catalog/weekly/configure", headers,
      payload: { enabled: true, expectedRevision: 0, reason: "Controlled pilot" } });
    expect(weekly.statusCode).toBe(409);
    expect(weekly.json().error).toBe("pilot_schedule_disabled");
    expect(await prisma.collectionTask.count()).toBe(before);
  });
});
