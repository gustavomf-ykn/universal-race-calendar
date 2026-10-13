import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workerIdleDelay, checkWorkerHealth, assertAwsStaging } from "@race-calendar/utils";
describe("container health and adaptive idle polling", () => {
  it("rejects a production/test DSN or non-SSL worker before AWS processes connect", () => {
    const ref = "sggrijhyblejlgimgzzc",
      env = {
        HOSTING_TARGET: "aws",
        SUPABASE_URL: `https://${ref}.supabase.co`,
        DATABASE_URL: `postgresql://postgres.${ref}:fixture-only@aws.example.pooler.supabase.com:5432/postgres?sslmode=require`,
      };
    expect(() => assertAwsStaging(env, ["DATABASE_URL"])).not.toThrow();
    for (const DATABASE_URL of [
      "postgresql://fixture-only@localhost/race_test",
      env.DATABASE_URL.replace(ref, "other"),
      env.DATABASE_URL.replace("require", "disable"),
    ])
      expect(() => assertAwsStaging({ ...env, DATABASE_URL }, ["DATABASE_URL"])).toThrow(
        "aws_staging_configuration_rejected",
      );
  });

  it("backs off idle queue polling and resets after work without exceeding 15 seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 100].map(workerIdleDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(workerIdleDelay(0)).toBe(1000);
  });
  it("requires a fresh own-process heartbeat but resource waiting remains a healthy process", () => {
    const directory = mkdtempSync(join(tmpdir(), "race-health-")),
      path = join(directory, "health.json");
    try {
      for (const state of ["available", "busy", "resource_wait"]) {
        writeFileSync(path, JSON.stringify({ state, updatedAt: 100000 }));
        expect(checkWorkerHealth(path, 120000)).toBe(true);
      }
      expect(checkWorkerHealth(path, 161000)).toBe(false);
      expect(checkWorkerHealth(path, 90000)).toBe(false);
      writeFileSync(path, JSON.stringify({ state: "stopped", updatedAt: 100000 }));
      expect(checkWorkerHealth(path, 120000)).toBe(false);
    } finally {
      rmSync(path);
      rmdirSync(directory);
    }
  });
});
