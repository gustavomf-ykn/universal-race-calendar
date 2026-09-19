import { describe, it, expect } from "vitest";
import { validateStagingEnvironment } from "../scripts/staging-preflight.mjs";
const ref = "abcdefghijklmnopqrst";
const valid = () => ({
  STAGING_PROJECT_REF: ref,
  STAGING_PROJECT_NAME: "race-platform-staging",
  SUPABASE_URL: `https://${ref}.supabase.co`,
  DATABASE_URL: `postgresql://postgres:p@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
  DIRECT_URL: `postgresql://postgres.${ref}:p@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require`,
  WORKER_DATABASE_URL: `postgresql://postgres:p@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
  SUPABASE_SECRET_KEY: "sb_secret_fixture",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  INTERNAL_API_KEY: "x".repeat(32),
});
describe("staging identity guard", () => {
  it("accepts consistent direct/session connections to the identified staging project", () =>
    expect(validateStagingEnvironment(valid(), ref).configuration).toBe("valid"));
  it("rejects a different project, transaction pooler, missing SSL, and Prisma parameters in psycopg URI", () => {
    for (const patch of [
      { SUPABASE_URL: "https://different.supabase.co" },
      { STAGING_PROJECT_NAME: "production" },
      { DIRECT_URL: valid().DIRECT_URL.replace(":5432", ":6543") },
      { WORKER_DATABASE_URL: valid().WORKER_DATABASE_URL + "&schema=public" },
      { DATABASE_URL: valid().DATABASE_URL.replace("?sslmode=require", "") },
    ])
      expect(() => validateStagingEnvironment({ ...valid(), ...patch }, ref)).toThrow("staging_configuration_rejected");
  });
  it("never includes a rejected credential in its error", () => {
    expect(() => validateStagingEnvironment({ ...valid(), DATABASE_URL: "private-password" }, ref)).toThrow(
      /^staging_configuration_rejected$/,
    );
  });
});
