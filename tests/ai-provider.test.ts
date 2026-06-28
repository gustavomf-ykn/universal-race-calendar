import { describe, expect, it } from "vitest";
import { normalizeRaceEventExtractionPayload, OpenAICompatibleProvider, parseJsonObjectFromText } from "@race-calendar/ai";
import { raceEventExtractionSchema } from "@race-calendar/schemas";
import type { RawSourceExtraction } from "@race-calendar/schemas";

const raw: RawSourceExtraction = {
  sourceType: "ticketsports",
  sourceId: "src_test",
  sourceExternalId: "123",
  url: "https://example.test/evento",
  title: "Corrida IA",
  importantHtml: "",
  importantText: "Corrida IA. Data 01/09/2026. Sao Paulo, SP. Inscricoes em https://example.test/evento.",
  rawSourceData: {},
  extractedLinks: ["https://example.test/evento"],
  fetchedAt: "2026-06-26T00:00:00.000Z",
  contentHash: "1234567890abcdef",
  adapter: "ticketsports",
  adapterVersion: "1.0.0",
};

describe("OpenAI compatible provider", () => {
  it("extracts JSON from markdown fences", () => {
    expect(parseJsonObjectFromText('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("normalizes common AI shape drift before schema validation", () => {
    const payload = normalizeRaceEventExtractionPayload({
      name: "Corrida IA",
      date: "2026-09-01",
      city: "Sao Paulo",
      state: "SP",
      country: "BR",
      registrationUrl: "https://example.test/evento",
      images: "https://example.test/image.jpg",
      warnings: "missing_state",
      unstructuredNotes: "A IA encontrou dados incompletos no texto.",
      eventStatus: "scheduled",
      confidence: 0.72,
      fieldConfidences: {},
    });

    const parsed = raceEventExtractionSchema.parse(payload);

    expect(parsed.unstructuredNotes).toEqual(["A IA encontrou dados incompletos no texto."]);
    expect(parsed.warnings).toEqual(["missing_state"]);
    expect(parsed.images).toEqual(["https://example.test/image.jpg"]);
    expect(parsed.name.value).toBe("Corrida IA");
  });

  it("sends a chat-completions request and validates the response", async () => {
    const calls: unknown[] = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://ai.example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    name: { value: "Corrida IA", confidence: 0.9, sourceText: "Corrida IA" },
                    date: { value: "2026-09-01", confidence: 0.9, sourceText: "01/09/2026" },
                    city: { value: "Sao Paulo", confidence: 0.8, sourceText: "Sao Paulo, SP" },
                    state: { value: "SP", confidence: 0.8, sourceText: "Sao Paulo, SP" },
                    country: { value: "BR", confidence: 0.8, sourceText: "Brasil" },
                    registrationUrl: { value: "https://example.test/evento", confidence: 0.9, sourceText: "https://example.test/evento" },
                    lots: [{ name: "Lote atual", price: 100, currency: "BRL", status: "open", isCurrent: true, confidence: 0.8 }],
                    currentLot: { name: "Lote atual", price: 100, currency: "BRL", status: "open", isCurrent: true, confidence: 0.8 },
                    eventStatus: "scheduled",
                    confidence: 0.9,
                    fieldConfidences: { name: 0.9 },
                    warnings: [],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const extraction = await provider.extractRaceEvent({ raw, today: "2026-06-26" });

    expect(calls).toHaveLength(1);
    expect(extraction.name.value).toBe("Corrida IA");
    expect(extraction.currentLot?.isCurrent).toBe(true);
  });
});
