import { describe, expect, it } from "vitest";
import { eventPublicationError, validPublicationReference } from "@race-calendar/database";
import { evaluatePublishability } from "@race-calendar/curation";

const event = {
  name: "Corrida de rua",
  date: "2026-10-10",
  city: "Vitória",
  state: "ES",
  country: "BR",
  modality: "road",
  sourceType: "ticketsports",
  sourceExternalId: "123456",
  sourceUrl: "https://www.ticketsports.com.br/e/prova-123456",
  locationName: "Parque Municipal",
  registrationUrl: null,
  officialUrl: "https://organizador.example/prova",
  confidence: 0.99,
  warnings: [],
};

describe("shared structural publication policy", () => {
  it("accepts a dated Brazilian edition with a recognized source reference", () => {
    expect(eventPublicationError(event)).toBeNull();
    expect(evaluatePublishability(event).canPublish).toBe(true);
  });
  it.each([
    { city: null },
    { city: "  " },
    { state: null },
    { state: "ZZ" },
    { state: "SC<script>" },
    { city: "Camboriú (Corrida nesta Cidade) (Corridas nesta Região)" },
    { city: "Cost�ão" },
  ])("does not allow a venue to replace city/UF: %j", (changes) => {
    expect(eventPublicationError({ ...event, ...changes })).toBe("publication_requires_date_city_state");
    expect(evaluatePublishability({ ...event, ...changes }).reasons).toContain("missing_location");
  });
  it.each(["2026-02-30", "2026-10-10T08:00:00Z", "amanhã"])("requires a valid calendar date: %s", (date) => {
    expect(eventPublicationError({ ...event, date })).toBe("publication_requires_date_city_state");
    expect(evaluatePublishability({ ...event, date }).reasons).toContain("missing_date");
  });
  it.each([
    { sourceUrl: "https://www.ticketsports.com.br/" },
    { sourceUrl: "https://www.ticketsports.com.br.evil.test/e/prova-123456" },
    { sourceUrl: "https://user:password@www.ticketsports.com.br/e/prova-123456" },
    { sourceUrl: "https://www.ticketsports.com.br/e/prova-654321" },
    { sourceType: "openresults" },
    { sourceExternalId: null },
  ])("does not publish with a generic, unsafe or mismatched reference: %j", (changes) => {
    expect(eventPublicationError({ ...event, ...changes })).toBe("publication_requires_valid_source_reference");
    expect(evaluatePublishability({ ...event, ...changes }).reasons).toContain("invalid_source_reference");
  });
  it("recognizes the source's different ID conventions without guessing an OpenResults numeric ID from the slug", () => {
    for (const sourceExternalId of ["SC:123", "123"])
      expect(
        validPublicationReference({
          sourceType: "corridasbr",
          sourceExternalId,
          url: "https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=123",
        }),
      ).toBe(true);
    for (const sourceExternalId of ["url:prova-2026", "9876"])
      expect(
        validPublicationReference({
          sourceType: "openresults",
          sourceExternalId,
          url: "https://openresults.run/evento/prova-2026/",
        }),
      ).toBe(true);
    expect(
      validPublicationReference({
        sourceType: "openresults",
        sourceExternalId: "url:outra-prova",
        url: "https://openresults.run/evento/prova-2026/",
      }),
    ).toBe(false);
  });
  it("does not publish a CorridasBR reference for a different UF", () => {
    const corridas = {
      ...event,
      sourceType: "corridasbr",
      sourceExternalId: "123",
      sourceUrl: "https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=123",
    };
    expect(eventPublicationError(corridas)).toBe("publication_requires_valid_source_reference");
    expect(evaluatePublishability(corridas).reasons).toContain("invalid_source_reference");
    expect(eventPublicationError({ ...corridas, state: "SC" })).toBeNull();
  });
  it("allows audited publication from a valid registered supplemental reference, but does not treat an arbitrary official URL as one", () => {
    const partial = { ...event, sourceUrl: "https://organizador.example/prova" };
    expect(eventPublicationError(partial)).toBe("publication_requires_valid_source_reference");
    expect(
      eventPublicationError({
        ...partial,
        sourceReferences: [
          { sourceType: "openresults", sourceExternalId: "123", url: "https://openresults.run/evento/prova-2026/" },
        ],
      }),
    ).toBeNull();
  });
  it("keeps other modalities in review automatically while permitting explicit administrative review", () => {
    expect(eventPublicationError({ ...event, modality: "mixed" })).toBeNull();
    expect(evaluatePublishability({ ...event, modality: "mixed" }).reasons).toContain("modality_requires_review");
  });
});
