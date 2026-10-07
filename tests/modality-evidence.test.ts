import { describe, expect, it } from "vitest";
import { modalityFromSourceText } from "@race-calendar/utils";
import { normalizeRaceEventExtraction, evaluatePublishability, shouldPersistCanonicalEvent } from "@race-calendar/curation";
import { raceEventExtractionSchema, rawSourceExtractionSchema } from "@race-calendar/schemas";
import { MockAIProvider } from "@race-calendar/ai";

const raw = (title: string, importantText: string) => rawSourceExtractionSchema.parse({
  sourceType: "ticketsports", sourceId: "modality-evidence", sourceExternalId: "123456",
  url: "https://www.ticketsports.com.br/e/prova-123456", title, importantText,
  // Controlled country evidence: these tests isolate modality, not inferred location.
  rawSourceData: { realDate: "2026-10-10", address: "Campinas, SP, Brasil" },
  fetchedAt: "2026-10-02T12:00:00.000Z", contentHash: "modality-evidence-test-hash", adapter: "ticketsports", adapterVersion: "1.0.0",
});
const extraction = raceEventExtractionSchema.parse({
  name: { value: "Corrida", confidence: 0.99 }, date: { value: "2026-10-10", confidence: 0.99 },
  city: { value: "Campinas", confidence: 0.99 }, state: { value: "SP", confidence: 0.99 },
  country: { value: "BR", confidence: 0.99, sourceText: "Brasil" }, modality: "road", confidence: 0.99,
  description: { value: "Corrida de rua inventada pelo modelo", confidence: 0.99 },
  distances: [{ label: "5 km", distanceKm: 5, modality: "road", sourceText: "5 km" }],
});

describe("modality evidence", () => {
  it.each([
    ["Meia Maratona", "Percursos 5 km e 21 km"],
    ["Circuito Run", "Largada na Rua das Flores, asfalto novo no estacionamento"],
    ["Corrida de Verão", "Acesse Trilha do Líder e veja as trilhas do nosso menu"],
    ["Corrida", "Não é corrida de rua; inscrições abertas"],
    ["Corrida", "Outras provas: corrida de rua"],
    ["Corrida", "Caminhada opcional para acompanhantes e espaço kids"],
  ])("preserves unknown rather than inventing road: %s", (title, text) => {
    expect(modalityFromSourceText(title, text)).toEqual({ modality: "unknown", evidence: [] });
    const normalized = normalizeRaceEventExtraction(extraction, raw(title, text));
    expect(normalized.modality).toBe("unknown");
    expect(normalized.distances[0]?.modality).toBe("unknown");
    expect(normalized.warnings).toEqual(expect.arrayContaining(["modality_unconfirmed", "modality_evidence_mismatch"]));
    expect(evaluatePublishability(normalized)).toMatchObject({ canPublish: false, publicationStatus: "pending_review" });
    expect(shouldPersistCanonicalEvent(normalized)).toBe(true);
  });
  it.each([
    ["Corrida da Cidade", "Corrida de rua com 5 km", "road", "Corrida de rua"],
    ["Corrida da Serra", "CORRIDA DE MONTANHA", "trail", "CORRIDA DE MONTANHA"],
    ["Mountain Do", "Percursos com trilhas, praias e dunas", "trail", "Percursos com trilhas"],
    ["Trail do Sol", "Inscrições abertas", "trail", "Trail"],
    ["Evento", "Modalidade: Rua", "road", "Modalidade: Rua"],
    ["Evento", "🏃 Águas. Corrida de rua", "road", "Corrida de rua"],
  ])("accepts explicit evidence with original quote: %s", (title, text, modality, quote) => {
    const observed = modalityFromSourceText(title, text);
    expect(observed.modality).toBe(modality);
    expect(observed.evidence).toContainEqual({ modality, sourceText: quote });
    const normalized = normalizeRaceEventExtraction(extraction, raw(title, text));
    expect(normalized.modality).toBe(modality);
    expect(normalized.distances[0]?.modality).toBe(modality);
    expect(evaluatePublishability(normalized).canPublish).toBe(true);
  });
  it("keeps both surfaces for review and validates distance quotes against the actual source", () => {
    const source = raw("Desafio", "Corrida de rua 5 km. Trail running 10 km.");
    const normalized = normalizeRaceEventExtraction({ ...extraction, distances: [
      { ...extraction.distances[0]!, sourceText: "Corrida de rua 5 km" },
      { ...extraction.distances[0]!, label: "10 km", distanceKm: 10, sourceText: "Trail running 10 km" },
      { ...extraction.distances[0]!, label: "21 km", sourceText: "Corrida de rua 21 km" },
      { ...extraction.distances[0]!, sourceText: "5 km" },
      { ...extraction.distances[0]!, sourceText: "Trail running 10 km" },
    ] }, source);
    expect(normalized.modality).toBe("mixed");
    expect(normalized.distances.map(item => item.modality)).toEqual(["road", "trail", "unknown", "unknown", "unknown"]);
    expect(evaluatePublishability(normalized).reasons).toContain("modality_requires_review");
  });
  it("does not infer road in the mock provider and retains kids/walk for review", async () => {
    const result = await new MockAIProvider().extractRaceEvent({ raw: raw("Maratona", "Rua das Flores") });
    expect(result.modality).toBe("unknown");
    for (const [title, modality] of [["Corrida Kids", "kids"], ["Caminhada da Cidade", "walk"]]) {
      const normalized = normalizeRaceEventExtraction(extraction, raw(title!, "Inscrições abertas"));
      expect(normalized.modality).toBe(modality);
      expect(evaluatePublishability(normalized).reasons).toContain("modality_requires_review");
      expect(shouldPersistCanonicalEvent(normalized)).toBe(true);
    }
  });
  it("recomputes modality warnings from observed text rather than trusting provider warnings", () => {
    const normalized = normalizeRaceEventExtraction({ ...extraction, warnings: ["modality_unconfirmed", "multiple_modalities", "missing_date"] },
      raw("Corrida", "Corrida de rua"));
    expect(normalized.modality).toBe("road");
    expect(normalized.warnings).toEqual([]);
  });
});
