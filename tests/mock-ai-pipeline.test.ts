import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockAIProvider } from "@race-calendar/ai";
import {
  curateSourceExtraction,
  curateTicketSportsSourceExtraction,
  evaluatePublishability,
  applyRaceEventExtraction,
  normalizeRaceEventExtraction,
  shouldPersistCanonicalEvent,
} from "@race-calendar/curation";
import type { RaceEventExtraction, RawSourceExtraction } from "@race-calendar/schemas";
import { MockSourceAdapter, TicketSportsAdapter } from "@race-calendar/sources";

const ticketsportsFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-simple.json", "utf-8")) as Record<
  string,
  unknown
>;

describe("mock AI pipeline", () => {
  it("runs raw source extraction through curation and normalization", async () => {
    const adapter = new MockSourceAdapter();
    const raw = await adapter.fetchAndExtract({
      sourceId: "src_test",
      url: "mock://corrida-floripa",
      metadata: {
        title: "Meia Maratona de Florianopolis",
        importantText:
          "Meia Maratona de Florianopolis. Data 16/08/2026. Florianopolis, SC, Brasil. Distancias 5 km e 21 km. Inscricoes em https://example.test/inscricao.",
      },
    });
    const result = await curateSourceExtraction(raw, new MockAIProvider());
    expect(result.normalizedEvent.name).toBe("Meia Maratona de Florianopolis");
    expect(result.normalizedEvent.date).toBe("2026-08-16");
    expect(result.normalizedEvent.publicationStatus).toBe("published");
    expect(result.normalizedEvent.registrationUrl).toBe("https://example.test/inscricao");
    expect(result.normalizedEvent.distances.map((distance) => distance.label)).toContain("21 km");
  });

  it("marks incomplete low-confidence events for review", () => {
    const publishability = evaluatePublishability({
      name: "Corrida sem data",
      date: null,
      city: "Florianopolis",
      state: "SC",
      country: "BR",
      locationName: null,
      registrationUrl: null,
      officialUrl: "https://example.test",
      confidence: 0.5,
      warnings: ["missing_date"],
    });
    expect(publishability.publicationStatus).toBe("pending_review");
    expect(publishability.reasons).toContain("missing_date");
    expect(publishability.reasons).toContain("low_confidence");
  });

  it("does not keep missing_state warning for clear international locations", () => {
    const extraction: RaceEventExtraction = {
      name: { value: "Maratona do Porto", confidence: 0.9, sourceText: "Maratona do Porto" },
      date: { value: "2026-11-08", confidence: 0.9, sourceText: "2026-11-08 08:00" },
      city: { value: "Porto", confidence: 0.85, sourceText: "Porto, Portugal" },
      state: { value: null, confidence: 0, sourceText: null },
      country: { value: "PT", confidence: 0.85, sourceText: "Portugal" },
      locationName: { value: "Porto", confidence: 0.75, sourceText: "Porto" },
      registrationUrl: {
        value: "https://www.ticketsports.com.br/e/Maratona-do-Porto-85488",
        confidence: 0.9,
        sourceText: "https://www.ticketsports.com.br/e/Maratona-do-Porto-85488",
      },
      officialUrl: {
        value: "https://www.ticketsports.com.br/e/Maratona-do-Porto-85488",
        confidence: 0.7,
        sourceText: "TicketSports",
      },
      latitude: null,
      longitude: null,
      modality: "road",
      distances: [],
      prices: [],
      lots: [],
      currentLot: null,
      kits: [],
      schedule: [],
      rules: [],
      kitPickup: null,
      images: [],
      eventStatus: "scheduled",
      confidence: 0,
      fieldConfidences: {},
      unstructuredNotes: [],
      warnings: ["missing_state", "no_distances_found", "no_lots_found"],
    };
    const raw: RawSourceExtraction = {
      sourceType: "ticketsports",
      sourceId: "src_porto",
      sourceExternalId: "85488",
      url: "https://www.ticketsports.com.br/e/Maratona-do-Porto-85488",
      title: "Maratona do Porto",
      importantHtml: "",
      importantText: "Maratona do Porto 2026. Porto, Portugal. Largada as 08:00.",
      rawSourceData: {},
      extractedLinks: ["https://www.ticketsports.com.br/e/Maratona-do-Porto-85488"],
      fetchedAt: "2026-06-28T00:00:00.000Z",
      contentHash: "hash_porto",
      adapter: "ticketsports",
      adapterVersion: "1.0.0",
    };

    const normalized = normalizeRaceEventExtraction(extraction, raw);

    expect(normalized.country).toBe("PT");
    expect(normalized.startTime).toBe("08:00");
    expect(normalized.description).toContain("Maratona do Porto 2026");
    expect(normalized.warnings).not.toContain("missing_state");
    expect(normalized.warnings).toContain("no_distances_found");
    expect(normalized.confidence).toBeGreaterThan(0);
    expect(evaluatePublishability(normalized).reasons).not.toContain("missing_location");
    expect(shouldPersistCanonicalEvent(normalized)).toBe(false);
    expect(shouldPersistCanonicalEvent({ country: "BR" })).toBe(true);
  });

  it("normalizes TicketSports payload deterministically without an AI provider", async () => {
    const adapter = new TicketSportsAdapter({
      async getJson() {
        return ticketsportsFixture;
      },
      async getText() {
        throw new Error("getText should not be called");
      },
    });
    const raw = await adapter.fetchAndExtract({
      sourceId: "src_ticketsports",
      sourceExternalId: "123456",
      url: "https://www.ticketsports.com.br/e/meia-maratona-florianopolis-123456",
    });

    const result = await curateTicketSportsSourceExtraction(raw);

    expect(result.normalizedEvent.name).toBe("Meia Maratona de Florianopolis");
    expect(result.normalizedEvent.date).toBe("2026-08-16");
    expect(result.normalizedEvent.startTime).toBe("06:30");
    expect(result.normalizedEvent.city).toBe("Florianopolis");
    expect(result.normalizedEvent.state).toBe("SC");
    expect(result.normalizedEvent.modality).toBe("road");
    expect(result.normalizedEvent.eventStatus).toBe("scheduled");
    expect(result.normalizedEvent.registrationUrl).toContain("ticketsports.com.br");
    expect(result.normalizedEvent.distances.map((distance) => distance.distanceKm)).toContain(21);
    expect(result.normalizedEvent.distances.map((distance) => distance.label)).toEqual(["5 km", "10 km", "21 km"]);
    expect(result.normalizedEvent.prices[0]?.price).toBe(120);
    expect(result.normalizedEvent.publicationStatus).toBe("published");
  });

  it("keeps deterministic TicketSports distances and prices when AI omits them", async () => {
    const adapter = new TicketSportsAdapter({
      async getJson() {
        return ticketsportsFixture;
      },
      async getText() {
        throw new Error("getText should not be called");
      },
    });
    const raw = await adapter.fetchAndExtract({
      sourceId: "src_ticketsports",
      sourceExternalId: "123456",
      url: "https://www.ticketsports.com.br/e/meia-maratona-florianopolis-123456",
    });
    const aiExtraction: RaceEventExtraction = {
      name: { value: "Meia Maratona de Florianopolis", confidence: 0.95, sourceText: "Meia Maratona de Florianopolis" },
      date: { value: "2026-08-16", confidence: 0.95, sourceText: "2026-08-16" },
      city: { value: "Florianopolis", confidence: 0.9, sourceText: "Florianopolis" },
      state: { value: "SC", confidence: 0.9, sourceText: "SC" },
      country: { value: "BR", confidence: 0.9, sourceText: "Brasil" },
      latitude: null,
      longitude: null,
      modality: "road",
      distances: [],
      prices: [],
      lots: [],
      currentLot: null,
      kits: [],
      schedule: [],
      rules: [],
      kitPickup: null,
      images: [],
      eventStatus: "scheduled",
      confidence: 0.9,
      fieldConfidences: {},
      unstructuredNotes: [],
      warnings: ["no_distances_found", "no_lots_found"],
      registrationUrl: { value: raw.url, confidence: 0.8, sourceText: raw.url },
      officialUrl: { value: raw.url, confidence: 0.7, sourceText: raw.url },
    };

    const result = applyRaceEventExtraction(raw, aiExtraction, {
      providerName: "openai-compatible",
      providerModel: "test-model",
      curationStatus: "curated",
    });

    expect(result.normalizedEvent.distances.map((distance) => distance.label)).toEqual(["5 km", "10 km", "21 km"]);
    expect(result.normalizedEvent.prices[0]?.price).toBe(120);
    expect(result.normalizedEvent.warnings).not.toContain("no_distances_found");
    expect(result.normalizedEvent.warnings).not.toContain("no_lots_found");
  });

  it("keeps suspicious TicketSports street addresses out of city and review-pends them", async () => {
    const adapter = new TicketSportsAdapter({
      async getJson() {
        return {
          ...ticketsportsFixture,
          title: "CIRCUITO DESBRAVA - RIO DE JANEIRO 2026",
          address: "Avenida Delfim Moreira, RJ, Brasil",
          eventContents: [
            {
              title: "Percursos",
              description: "<p>Corrida de 5K, 5 km e 10 Km. Caminhada opcional para acompanhantes.</p>",
            },
          ],
        };
      },
      async getText() {
        throw new Error("getText should not be called");
      },
    });
    const raw = await adapter.fetchAndExtract({
      sourceId: "src_ticketsports",
      sourceExternalId: "85556",
      url: "https://www.ticketsports.com.br/e/circuito-desbrava-85556",
    });

    const result = await curateTicketSportsSourceExtraction(raw);

    expect(result.normalizedEvent.city).toBeNull();
    expect(result.normalizedEvent.locationName).toBe("Avenida Delfim Moreira, RJ, Brasil");
    expect(result.normalizedEvent.modality).toBe("road");
    expect(result.normalizedEvent.distances.map((distance) => distance.label)).toEqual(["5 km", "10 km"]);
    expect(result.normalizedEvent.publicationStatus).toBe("pending_review");
    expect(result.normalizedEvent.publishabilityReasons).toContain("critical_warning");
  });
});
