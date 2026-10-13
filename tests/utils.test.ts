import { describe, expect, it } from "vitest";
import {
  atLeastSemver,
  countryFromLocationText,
  generateEventFingerprint,
  normalizeDate,
  normalizeDistanceKm,
  normalizePrice,
  slugify,
  sliceText,
  CURATION_PIPELINE_VERSION,
} from "@race-calendar/utils";

describe("utils", () => {
  it("omits split surrogate pairs at excerpt boundaries and preserves complete Unicode", () => {
    expect(sliceText("ab🏃cd", 0, 3)).toBe("ab");
    expect(sliceText("ab🏃cd", 3, 6)).toBe("cd");
    expect(sliceText("ab🏃cd", 2, 4)).toBe("🏃");
    expect(sliceText("ação 🏃 São José")).toBe("ação 🏃 São José");
    expect(sliceText("🏃", 0, 1)).toBe("");
    expect(sliceText("🏃", 1)).toBe("");
    expect(CURATION_PIPELINE_VERSION).toBe("1.7.1");
  });
  it("requires explicit unambiguous country components rather than UFs or venue names", () => {
    for (const location of [null, "", "Garuva, SC", "Parque Brasil, Lisboa", "Avenida Brasil, Porto", "Brasil, Garuva, SC", "constructor"])
      expect(countryFromLocationText(location)).toEqual({ country: null, sourceText: null, conflicting: false });
    expect(countryFromLocationText("Garuva, SC, Brasil")).toEqual({ country: "BR", sourceText: "Brasil", conflicting: false });
    expect(countryFromLocationText("Porto, Portugal").country).toBe("PT");
    expect(countryFromLocationText("Garuva, SC, BR, Brasil").country).toBe("BR");
    expect(countryFromLocationText("Porto, Portugal, Brasil")).toEqual({ country: null, sourceText: null, conflicting: true });
  });
  it("generates slugs", () => {
    expect(slugify("Meia Maratona de Florianopolis 2026")).toBe("meia-maratona-de-florianopolis-2026");
  });

  it("normalizes Brazilian dates", () => {
    expect(normalizeDate("16/08/2026")).toBe("2026-08-16");
  });
  it("recognizes JSON-LD timestamps without changing their local calendar day", () => {
    expect(normalizeDate("2026-10-18T23:30:00-03:00")).toBe("2026-10-18");
    expect(normalizeDate("2026-10-18T07:00:00Z")).toBe("2026-10-18");
    expect(normalizeDate("2026-02-30T07:00:00-03:00")).toBeNull();
    expect(normalizeDate("2026-10-18Tomorrow")).toBeNull();
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
