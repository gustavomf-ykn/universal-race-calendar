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

  it("accepts lots/currentLot and keeps prices compatibility", () => {
    const parsed = raceEventExtractionSchema.parse({
      name: { value: "Corrida Com Lotes", confidence: 0.9, sourceText: "Corrida Com Lotes" },
      date: { value: "2026-09-01", confidence: 0.9, sourceText: "01/09/2026" },
      city: { value: "Sao Paulo", confidence: 0.8, sourceText: "Sao Paulo, SP" },
      state: { value: "SP", confidence: 0.8, sourceText: "Sao Paulo, SP" },
      country: { value: "BR", confidence: 0.8, sourceText: "Brasil" },
      registrationUrl: { value: "https://example.test", confidence: 0.9, sourceText: "https://example.test" },
      lots: [
        {
          name: "Lote atual",
          price: 120,
          currency: "BRL",
          status: "open",
          isCurrent: true,
          sourceText: "Lote atual R$ 120,00",
          confidence: 0.85,
        },
      ],
      currentLot: {
        name: "Lote atual",
        price: 120,
        currency: "BRL",
        status: "open",
        isCurrent: true,
        sourceText: "Lote atual R$ 120,00",
        confidence: 0.85,
      },
      fieldConfidences: { currentLot: 0.85 },
      unstructuredNotes: ["Preco extraido de texto do lote atual."],
      confidence: 0.9,
    });
    expect(parsed.currentLot?.isCurrent).toBe(true);
    expect(parsed.lots[0]?.price).toBe(120);
    expect(parsed.prices).toEqual([]);
  });
});
