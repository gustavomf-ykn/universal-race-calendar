import { describe, expect, it } from "vitest";
import { normalizeRaceEventExtraction, evaluatePublishability, shouldPersistCanonicalEvent } from "@race-calendar/curation";
import { rawSourceExtractionSchema, raceEventExtractionSchema } from "@race-calendar/schemas";
import { OfficialEventPageAdapter, TicketSportsAdapter } from "@race-calendar/sources";

const proposal = raceEventExtractionSchema.parse({
  name: { value: "Nome inventado", confidence: 1 },
  date: { value: "2026-10-18", sourceText: "Data: 18/10/2026", confidence: 1 },
  city: { value: "Campinas", sourceText: "Campinas", confidence: 1 },
  state: { value: "SP", sourceText: "SP", confidence: 1 },
  country: { value: "BR", confidence: 1 }, modality: "road", confidence: 1,
});
const raw = (data: object, sourceType = "ticketsports", importantText = "Corrida de rua") => rawSourceExtractionSchema.parse({
  sourceType, sourceId: "date-location-test", sourceExternalId: "123456", title: "Corrida da fonte",
  url: "https://www.ticketsports.com.br/e/prova-123456", importantText, rawSourceData: data,
  fetchedAt: "2026-10-02T12:00:00Z", contentHash: "date-location-test-hash", adapter: sourceType, adapterVersion: "1.1.0",
});
const ld = (name = "Corrida da fonte", date = "2026-10-18", city = "Campinas", state = "SP") => ({
  "@type": "Event", name, startDate: date,
  location: { address: { addressLocality: city, addressRegion: state, addressCountry: "Brasil" } },
});
const normalize = (data: object, type = "ticketsports", text?: string) => normalizeRaceEventExtraction(proposal, raw(data, type, text));

describe("edition fields observed in the source, independent of model confidence", () => {
  it("keeps candidates without accepting invented identity or fabricated quotes", () => {
    const event = normalize({});
    expect(event).toMatchObject({ name: "Corrida da fonte", date: null, city: null, state: null });
    expect(event.warnings).toEqual(expect.arrayContaining(["missing_date", "missing_city", "missing_state"]));
    expect(evaluatePublishability(event).canPublish).toBe(false);
    expect(shouldPersistCanonicalEvent(event)).toBe(true);
  });
  it("uses structured source fields rather than a contradictory provider proposal", () => {
    const event = normalize({ realDate: "2027-10-18", address: "Garuva, SC, Brasil" });
    expect(event).toMatchObject({ date: "2027-10-18", city: "Garuva", state: "SC", country: "BR" });
    expect(event.warnings).toEqual(expect.arrayContaining(["date_evidence_mismatch", "location_evidence_mismatch"]));
    expect(evaluatePublishability(event).reasons).toContain("critical_warning");
  });
  it("does not replace an absent source name with the model's invented name", () => {
    const event = normalizeRaceEventExtraction(proposal, { ...raw({ realDate: "2026-10-18", address: "Campinas, SP, Brasil" }), title: null });
    expect(event.name).toBe("Evento sem nome");
    expect(event.warnings).toContain("missing_name");
    expect(evaluatePublishability(event).canPublish).toBe(false);
  });
  it("preserves the source's calendar day across ISO timezone notation", () => {
    expect(normalize({ realDate: "2026-10-18T23:00:00-03:00", date: "18/10/2026", address: "Campinas, SP, Brasil" }))
      .toMatchObject({ date: "2026-10-18", city: "Campinas", state: "SP" });
  });
  it("does not choose between contradictory date fields", () => {
    const event = normalize({ realDate: "2026-10-18", date: "2027-10-18", address: "Campinas, SP, Brasil" });
    expect(event.date).toBeNull();
    expect(event.warnings).toContain("conflicting_date");
    expect(evaluatePublishability(event).canPublish).toBe(false);
  });
  it.each(["Lagoa Santa, MG, Brasil", "Centro Novo do Maranhão, MA, Brasil"])("retains a municipality with an ambiguous venue word: %s", address => {
    expect(normalize({ realDate: "2026-10-18", address }).city).toBe(address.split(",")[0]);
  });
  it.each(["Rua das Flores, SP, Brasil", "Campinas, ZZ, Brasil"])("refuses a street or invalid Brazilian state: %s", address => {
    const event = normalize({ realDate: "2026-10-18", address });
    expect(evaluatePublishability(event).canPublish).toBe(false);
    expect(event.city === null || event.state === null).toBe(true);
  });
  it("requires a primary date, excluding registration and organizer text", () => {
    const event = normalize({}, "mock", "Retirada de kit. Data: 17/10/2026. Organizador: Campinas, SP, Brasil.");
    expect(event).toMatchObject({ date: null, city: null, state: null });
  });
  it("accepts a labelled primary event date and city clause", () => {
    expect(normalize({}, "mock", "Corrida de rua. Data da prova: 18/10/2026. Campinas, SP, Brasil."))
      .toMatchObject({ date: "2026-10-18", city: "Campinas", state: "SP", country: "BR" });
  });
  it("retains ambiguity when a primary text contains multiple event dates or locations", () => {
    const event = normalize({}, "mock", "Data: 18/10/2026. Data: 19/10/2026. Campinas, SP, Brasil. Garuva, SC, Brasil.");
    expect(event).toMatchObject({ date: null, city: null, state: null });
    expect(event.warnings).toEqual(expect.arrayContaining(["conflicting_date", "conflicting_location"]));
  });
  it.each(["ambiguous", "url_mismatch", undefined])("refuses unselected JSON-LD even with a plausible provider/text: %s", selection => {
    const event = normalize({ jsonLdSelection: selection, jsonLdEvent: ld() }, "official_event_page",
      "Data: 18/10/2026. Campinas, SP, Brasil. Corrida de rua.");
    expect(event).toMatchObject({ date: null, city: null, state: null });
    expect(event.warnings).toContain("edition_observation_unconfirmed");
  });
  it("uses only the selected event location, excluding the organizer's address", () => {
    expect(normalize({ jsonLdSelection: "url", jsonLdEvent: { ...ld(),
      organizer: { address: { addressLocality: "Garuva", addressRegion: "SC" } } } }, "official_event_page"))
      .toMatchObject({ date: "2026-10-18", city: "Campinas", state: "SP" });
  });
  it.each([
    ld("Outra prova"), ld("Corrida da fonte", "2027-10-18"), ld("Corrida da fonte", "2026-10-18", "Garuva", "SC"),
  ])("does not import unrelated linked-page identity or modality", linked => {
    const event = normalize({ corridasbr: { name: "Corrida da fonte", date: "18/10/2026", state: "SP" },
      officialPage: { jsonLdSelection: "single", jsonLdEvent: linked, importantText: "Corrida de montanha" } },
    "corridasbr", "Campinas, SP, Brasil. Corrida de montanha. Data: 18/10/2026.");
    expect(event).toMatchObject({ date: "2026-10-18", city: null, state: "SP", country: null, modality: "unknown" });
  });
  it("allows a compatible linked edition to fill missing city without changing its primary date", () => {
    expect(normalize({ corridasbr: { name: "Corrida da fonte", date: "18/10/2026", state: "SP" },
      officialPage: { jsonLdSelection: "single", jsonLdEvent: ld(), importantText: "Corrida de rua" } }, "corridasbr"))
      .toMatchObject({ date: "2026-10-18", city: "Campinas", state: "SP", country: "BR", modality: "road" });
  });
  it("a linked edition cannot supply a missing primary date", () => {
    expect(normalize({ corridasbr: { name: "Corrida da fonte" },
      officialPage: { jsonLdSelection: "single", jsonLdEvent: ld() } }, "corridasbr"))
      .toMatchObject({ date: null, city: null, state: null, country: null });
  });
  it("uses the selected linked description with the shape emitted by the adapter", () => {
    expect(normalize({ corridasbr: { name: "Corrida da fonte", date: "2026-10-18", city: "Campinas", state: "SP" },
      officialPage: { jsonLdSelection: "single", jsonLdEvent: { ...ld(), description: "Corrida de montanha" } } }, "corridasbr"))
      .toMatchObject({ modality: "trail" });
  });
});

describe("adapter identity before curation", () => {
  it.each([
    { eventId: "654321", uri: "https://www.ticketsports.com.br/e/other-654321" },
    { eventId: "123456", uri: "https://www.ticketsports.com.br/e/other-654321" },
  ])("rejects TicketSports detail identity changes before exposing a raw extraction", async payload => {
    const adapter = new TicketSportsAdapter({ async getJson() { return payload; }, async getText() { throw Error("unexpected"); } });
    await expect(adapter.fetchAndExtract({ sourceId: "identity", sourceExternalId: "123456",
      url: "https://www.ticketsports.com.br/e/prova-123456" })).rejects.toThrow("edition_source_identity_conflict");
  });
  it.each([
    { path: "selected", events: [{ ...ld("Other edition"), url: "/other" }, { ...ld(), url: "/selected" }], reason: "url", name: "Corrida da fonte" },
    { path: "ambiguous", events: [ld(), ld("Other edition")], reason: "ambiguous", name: undefined },
    { path: "wrong-url", events: [{ ...ld(), url: "/other" }], reason: "url_mismatch", name: undefined },
    { path: "conflicting-id", events: [{ ...ld(), url: "/other", "@id": "/conflicting-id#event" }], reason: "url_mismatch", name: undefined },
    { path: "invalid-url", events: [{ ...ld(), url: "javascript:alert(1)" }], reason: "url_mismatch", name: undefined },
    { path: "single", events: [ld()], reason: "single", name: "Corrida da fonte" },
    { path: "two-matching", events: [{ ...ld(), url: "/two-matching" }, { ...ld(), url: "/two-matching" }], reason: "ambiguous", name: undefined },
  ])("selects page-specific JSON-LD conservatively: $path", async ({ path, events, reason, name }) => {
    const adapter = new OfficialEventPageAdapter({
      async getText() { return `<h1>Page heading</h1><script type="application/ld+json">${JSON.stringify(events)}</script>`; },
      async getJson() { throw Error("unexpected"); },
    });
    const result = await adapter.fetchAndExtract({ sourceId: "official", url: `https://evidence.example/${path}` });
    expect(result.rawSourceData.jsonLdSelection).toBe(reason);
    expect((result.rawSourceData.jsonLdEvent as Record<string, unknown>).name).toBe(name);
  });
});
