import { describe, expect, it } from "vitest";
import {
  atLeastSemver,
  generateEventFingerprint,
  normalizeDate,
  normalizeDistanceKm,
  normalizePrice,
  slugify,
} from "@race-calendar/utils";

describe("utils", () => {
  it("generates slugs", () => {
    expect(slugify("Meia Maratona de Florianopolis 2026")).toBe("meia-maratona-de-florianopolis-2026");
  });

  it("normalizes Brazilian dates", () => {
    expect(normalizeDate("16/08/2026")).toBe("2026-08-16");
  });

  it("normalizes BRL prices", () => {
    expect(normalizePrice("R$ 120,50")).toBe(120.5);
    expect(normalizePrice("149.90")).toBe(149.9);
    expect(normalizePrice("R$ 1.499,90")).toBe(1499.9);
    expect(normalizePrice("BRL 1,499.90")).toBe(1499.9);
  });

  it("normalizes distances", () => {
    expect(normalizeDistanceKm("21,1 km")).toBe(21.1);
  });

  it("generates canonical fingerprints", () => {
    expect(
      generateEventFingerprint({
        name: "Meia Maratona Florianopolis",
        date: "2026-08-16",
        city: "Florianopolis",
        state: "SC",
        country: "BR",
      }),
    ).toBe("meia-maratona-florianopolis|2026-08-16|florianopolis|sc|br");
  });

  it("keeps curation versions from being downgraded by stale envs", () => {
    expect(atLeastSemver("1.0.0", "1.2.0")).toBe("1.2.0");
    expect(atLeastSemver("1.3.0", "1.2.0")).toBe("1.3.0");
    expect(atLeastSemver(undefined, "1.2.0")).toBe("1.2.0");
  });
});
