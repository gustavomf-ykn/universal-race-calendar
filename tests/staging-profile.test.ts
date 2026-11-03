import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { runtimeProfile, assertRuntimeDestination, assertPilotTask, stagingPrismaUrl } from "../packages/utils/src/staging-profile.js";
const ref = "gpkodfsofwiroskdmeax";
const file = fileURLToPath(new URL("../config/staging-profiles.json", import.meta.url));
const uri = "postgresql://postgres." + ref + ":synthetic-password@aws-0.test.pooler.supabase.com:5432/postgres?sslmode=require";
const environment = { RUNFINDER_PROFILE: "local-staging", RUNFINDER_PROFILE_CONFIG: file,
  EXPECTED_SUPABASE_PROJECT_REF: ref, SUPABASE_URL: "https://" + ref + ".supabase.co",
  DATABASE_URL: uri, DIRECT_URL: uri, WORKER_DATABASE_URL: uri };
afterEach(() => vi.unstubAllEnvs());
describe("explicit new staging isolation", () => {
  it("supports native and container configuration without changing the legacy default", () => {
    expect(runtimeProfile({})).toBeNull();
    expect(runtimeProfile(environment)?.projectRef).toBe(ref);
    expect(() => assertRuntimeDestination(environment, ["DATABASE_URL", "DIRECT_URL", "WORKER_DATABASE_URL"])).not.toThrow();
  });
  it("rejects mixed projects, transaction poolers, duplicate SSL and Prisma options in Python", () => {
    for (const change of [
      { SUPABASE_URL: "https://sggrijhyblejlgimgzzc.supabase.co" },
      { DATABASE_URL: uri.replace(ref, "sggrijhyblejlgimgzzc") },
      { DATABASE_URL: uri.replace(":5432", ":6543") },
      { DATABASE_URL: uri + "&sslmode=disable" },
      { WORKER_DATABASE_URL: uri + "&schema=public" },
    ]) expect(() => assertRuntimeDestination({ ...environment, ...change }, ["DATABASE_URL", "WORKER_DATABASE_URL"])).toThrow("runtime_destination_rejected");
    expect(() => runtimeProfile({ ...environment, RUNFINDER_PROFILE: "unknown" })).toThrow("runtime_profile_invalid");
  });
  it("rejects an oversized intent before enqueue and accepts only the explicit pilot scope", () => {
    vi.stubEnv("RUNFINDER_PROFILE", "local-staging");
    vi.stubEnv("RUNFINDER_PROFILE_CONFIG", file);
    expect(() => assertPilotTask("calendar", { states: ["SC"], quantity: 5 })).not.toThrow();
    for (const [kind, payload] of [
      ["calendar", { states: ["SC"], quantity: 500 }],
      ["calendar", { states: ["SP"], quantity: 5 }],
      ["catalog-sync", { states: ["SC"], batchSize: 5, prefixLimit: 10000 }],
      ["discover", { limit: 5, maxPages: 10 }],
      ["catalog", { candidateLimit: 100 }],
    ] as const) expect(() => assertPilotTask(kind, payload)).toThrow("pilot_scope_exceeded");
  });
  it("bounds each Prisma process without changing Python, SSL, credentials or legacy configurations", () => {
    expect(stagingPrismaUrl({ DATABASE_URL: uri })).toBeUndefined();
    for (const suffix of ["", "&connection_limit=99", "&connection_limit=2"]) {
      const configured = stagingPrismaUrl({ ...environment, DATABASE_URL: uri + suffix })!;
      const target = new URL(configured);
      expect(target.searchParams.getAll("connection_limit")).toEqual(["2"]);
      expect(target.searchParams.get("pool_timeout")).toBe("15");
      expect(target.searchParams.get("sslmode")).toBe("require");
      expect(target.hostname).toBe(new URL(uri).hostname);
      expect(target.password).toBe(new URL(uri).password);
      expect(environment.WORKER_DATABASE_URL).toBe(uri);
    }
    expect(new URL(stagingPrismaUrl({ ...environment, DATABASE_URL: uri + "&connection_limit=1" })!).searchParams.get("connection_limit")).toBe("1");
    for (const suffix of ["&connection_limit=0", "&connection_limit=two", "&connection_limit=2&connection_limit=9"])
      expect(() => stagingPrismaUrl({ ...environment, DATABASE_URL: uri + suffix })).toThrow("runtime_pool_configuration_invalid");
    expect(() => stagingPrismaUrl({ ...environment, DATABASE_URL: uri.replace(ref, "sggrijhyblejlgimgzzc") })).toThrow("runtime_destination_rejected");
  });
});
