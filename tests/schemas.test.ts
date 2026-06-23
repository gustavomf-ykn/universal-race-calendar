import { describe, expect, it } from "vitest";
import { raceEventExtractionSchema } from "@race-calendar/schemas";

describe("RaceEventExtraction schema", () => {
  it("validates the minimum AI extraction shape", () => {
    const parsed = raceEventExtractionSchema.parse({
      name: { value: "Corrida Teste", confidence: 0.9, sourceText: "Corrida Teste" },
      date: { value: "2026-08-16", confidence: 0.9, sourceText: "16/08/2026" },
      city: { value: "Florianopolis", confidence: 0.8, sourceText: "Florianopolis, SC" },
      state: { value: "SC", confidence: 0.8, sourceText: "Florianopolis, SC" },
      country: { value: "BR", confidence: 0.8, sourceText: "Brasil" },
      registrationUrl: { value: "https://example.test", confidence: 0.9, sourceText: "https://example.test" },
      confidence: 0.9,
    });
    expect(parsed.eventStatus).toBe("unknown");
  });
});
