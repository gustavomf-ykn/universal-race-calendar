import { describe, expect, it } from "vitest";
import { MockAIProvider } from "@race-calendar/ai";
import { curateSourceExtraction, evaluatePublishability } from "@race-calendar/curation";
import { MockSourceAdapter } from "@race-calendar/sources";

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
});
