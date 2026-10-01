import { describe, expect, it } from "vitest";
import { publicCatalogSync } from "@race-calendar/database";

describe("public catalog evidence", () => {
  it("exposes source-wide denominators separately from filtered candidates and strips raw checkpoints", () => {
    const sync = {
      id: "sync", source: "openresults", snapshot: {
        rows: [{ name: "not public", url: "not public" }], seenURLs: ["not public"],
        receipts: [{ state: "BR", status: "completed", reason: "native_end_confirmed",
          requested: 2, rawCount: 5, unique: 4, scope: "source_catalog", advertisedTotal: 4,
          duplicates: 1, outOfScope: 1, unknownCountry: 2, privateValue: "never expose" }],
      }, options: { states: ["SC"] }, status: "completed", discovered: 3, processed: 3,
    } as unknown as Parameters<typeof publicCatalogSync>[0];
    const result = publicCatalogSync(sync, null);
    expect(result.receipts).toEqual([{ state: "BR", status: "completed", reason: "native_end_confirmed",
      requested: 2, rawCount: 5, unique: 4, scope: "source_catalog", advertisedTotal: 4,
      duplicates: 1, outOfScope: 1, unknownCountry: 2 }]);
    expect(result.discovered).toBe(3);
    expect(JSON.stringify(result)).not.toContain("not public");
    expect(JSON.stringify(result)).not.toContain("never expose");
    sync.snapshot = { receipts: [{ ...result.receipts[0], advertisedTotal: null, duplicates: -1,
      unknownCountry: "secret", outOfScope: 2.5 }] };
    expect(publicCatalogSync(sync, null).receipts[0]).toEqual({
      state: "BR", status: "completed", reason: "native_end_confirmed",
      requested: 2, rawCount: 5, unique: 4, scope: "source_catalog", advertisedTotal: null,
    });
  });
});
