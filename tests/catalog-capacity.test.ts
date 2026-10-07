import { describe, expect, it } from "vitest";
import { inspectCatalogCapacity, validateCapacityDestination } from "../scripts/catalog-capacity.mjs";

describe("read-only capacity inventory", () => {
  it("rejects production/ambiguous destinations without exposing credentials", () => {
    const env = { DATABASE_URL: "postgresql://user:do-not-print@db.other.supabase.co/postgres?sslmode=require",
      SUPABASE_URL: "https://sggrijhyblejlgimgzzc.supabase.co" };
    expect(() => validateCapacityDestination("race-platform-staging", env)).toThrow("staging_identity_required");
    expect(() => validateCapacityDestination("local-test", env)).toThrow("isolated_database_required");
    validateCapacityDestination("local-test", { DATABASE_URL: "postgresql://postgres:test@localhost/race_test" });
    validateCapacityDestination("race-platform-staging", { ...env,
      DATABASE_URL: "postgresql://postgres.sggrijhyblejlgimgzzc:test@aws-0-sa-east-1.pooler.supabase.com/postgres?sslmode=require" });
  });
  it("never treats missing Storage, RLS visibility or provider errors as zero capacity usage", async () => {
    for (const state of ["absent", "hidden", "size_missing", "failed", "complete"]) {
      const statements: string[] = [];
      const tx = {
        $executeRaw: async (parts: TemplateStringsArray) => { statements.push(parts.join("")); },
        $queryRaw: async (parts: TemplateStringsArray) => {
          const sql = parts.join("");
          if (state === "failed") throw Error("credential-and-private-host");
          if (sql.includes("to_regclass")) return [{ present: state !== "absent" }];
          if (sql.includes("has_table_privilege")) return [{ complete: state !== "hidden" }];
          if (sql.includes("metadata")) return [{ objects: 1, unknown: state === "size_missing" ? 1 : 0, bytes: "1024" }];
          if (sql.includes("pg_class")) return [{ table: "Event", bytes: "4096" }];
          return [{ bytes: "65536" }];
        },
      };
      const report = await inspectCatalogCapacity({ $transaction: async (run: (client: typeof tx) => unknown) => run(tx) });
      expect(statements.some(sql => sql.includes("READ ONLY"))).toBe(true);
      expect(report.loadAuthorized).toBe(false);
      expect(report.limitsVerified).toBe(false);
      expect(JSON.stringify(report)).not.toContain("credential-and-private-host");
      if (state === "complete") expect(report.storage.value).toEqual({ bytes: "1024", objects: 1 });
      else expect(report.storage.value).toBeNull();
    }
  });
});
