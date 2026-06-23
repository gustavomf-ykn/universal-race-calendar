import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockAIProvider } from "@race-calendar/ai";
import { curateSourceExtraction, curateTicketSportsSourceExtraction, evaluatePublishability } from "@race-calendar/curation";
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
    expect(result.normalizedEvent.prices[0]?.price).toBe(120);
    expect(result.normalizedEvent.publicationStatus).toBe("published");
  });
});
