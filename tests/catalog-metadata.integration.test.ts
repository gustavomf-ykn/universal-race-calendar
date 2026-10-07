import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, saveCanonicalEvent } from "@race-calendar/database";
import type { CanonicalRaceEvent } from "@race-calendar/schemas";
import { raceEventExtractionSchema, rawSourceExtractionSchema } from "@race-calendar/schemas";
import { normalizeRaceEventExtraction } from "@race-calendar/curation";
const enabled = Boolean(process.env.DATABASE_URL);
const prefix = "metadata-test-" + randomUUID();
describe.skipIf(!enabled)("recurring catalog metadata preserves valid and reviewed values", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || !url.pathname.endsWith("_test"))
      throw Error("isolated_database_required");
  });
  afterAll(async () => {
    await prisma.adminAudit.deleteMany({ where: { actorId: prefix } });
    await prisma.event.deleteMany({ where: { sourceExternalId: { startsWith: prefix } } });
    await prisma.source.deleteMany({ where: { externalId: { startsWith: prefix } } });
  });
  async function fixture(name: string, sourceType = "ticketsports") {
    const source = await prisma.source.create({ data: { name: "Fixture", url: `https://www.ticketsports.com.br/e/fixture-${name}`,
      adapter: sourceType, externalId: prefix + name, type: "registration_page" } });
    const canonical: CanonicalRaceEvent = {
      slug: prefix + name, name: "Corrida validada " + name, description: "Descrição validada", date: "2026-10-10",
      startTime: "08:00", endTime: null, city: "Garuva", state: "SC", country: "BR", locationName: null,
      address: null, latitude: null, longitude: null, modality: "road", eventStatus: "scheduled", publicationStatus: "published",
      registrationUrl: source.url, officialUrl: null, regulationUrl: null, organizerName: null, organizerUrl: null, mainImageUrl: null,
      sourceId: source.id, sourceType, sourceExternalId: source.externalId, sourceUrl: source.url, confidence: 1,
      canonicalFingerprint: prefix + name, dedupeStatus: "unique", duplicateOfEventId: null, warnings: [], publishabilityReasons: [],
      distances: [{ label: "5 km", distanceKm: 5, modality: "road", startTime: null, elevationGain: null, sourceText: "5 km", confidence: 1 }],
      prices: [], kits: [], schedule: [], rules: [], kitPickup: null, images: ["https://www.ticketsports.com.br/images/fixture.jpg"],
    };
    const saved = await saveCanonicalEvent(canonical);
    return { canonical, id: saved.event.id };
  }
  it("does not erase scalar metadata, distance or images when a subsequent extraction lacks them", async () => {
    const { canonical, id } = await fixture("partial");
    await saveCanonicalEvent({ ...canonical, description: null, date: null, city: null, startTime: null,
      modality: "unknown", distances: [], images: [] });
    expect(await prisma.event.findUnique({ where: { id }, include: { distances: true, images: true } })).toMatchObject({
      description: canonical.description, city: canonical.city, startTime: canonical.startTime, modality: "road",
      distances: [{ distanceKm: 5 }], images: [{ url: canonical.images[0] }],
    });
    const ref = await prisma.eventSourceReference.findFirstOrThrow({ where: { eventId: id } });
    expect(ref.observation).toMatchObject({ city: null, date: null, modality: "unknown" });
  });
  it("does not turn model-only identity into a source observation when refreshing existing data", async () => {
    const { canonical, id } = await fixture("unobserved");
    const proposal = raceEventExtractionSchema.parse({
      name: { value: canonical.name, confidence: 1 }, date: { value: canonical.date, confidence: 1 },
      city: { value: "Cidade inventada", sourceText: "Cidade inventada", confidence: 1 },
      state: { value: "SP", confidence: 1 }, country: { value: "BR", confidence: 1 }, modality: "road", confidence: 1,
    });
    const observed = normalizeRaceEventExtraction(proposal, rawSourceExtractionSchema.parse({
      sourceType: canonical.sourceType, sourceId: canonical.sourceId, sourceExternalId: canonical.sourceExternalId,
      url: canonical.sourceUrl, title: canonical.name, importantText: "Inscrições abertas", rawSourceData: {},
      adapter: "ticketsports", adapterVersion: "1.1.0", fetchedAt: new Date().toISOString(), contentHash: "unobserved-test-hash",
    }));
    await saveCanonicalEvent({ ...canonical, date: observed.date, city: observed.city, state: observed.state,
      country: observed.country, modality: observed.modality, warnings: observed.warnings, publicationStatus: "pending_review" });
    expect(await prisma.event.findUniqueOrThrow({ where: { id } })).toMatchObject({
      date: new Date("2026-10-10"), city: "Garuva", state: "SC", country: "BR", modality: "road",
    });
    expect((await prisma.eventSourceReference.findFirstOrThrow({ where: { eventId: id } })).observation)
      .toMatchObject({ date: null, city: null, state: null, country: null, modality: "unknown" });
  });
  it("preserves a known name when the source no longer supplies it, without calling the placeholder evidence", async () => {
    const { canonical, id } = await fixture("missing-name");
    await saveCanonicalEvent({ ...canonical, name: "Evento sem nome", warnings: ["missing_name"], publicationStatus: "pending_review" });
    expect((await prisma.event.findUniqueOrThrow({ where: { id } })).name).toBe(canonical.name);
    expect((await prisma.eventSourceReference.findFirstOrThrow({ where: { eventId: id } })).observation)
      .toMatchObject({ name: null });
  });
  it("preserves specific audited corrections and intentional nulls while recording the source's conflicting values", async () => {
    const { canonical, id } = await fixture("reviewed");
    await prisma.event.update({ where: { id }, data: {
      name: "Nome revisado", city: "Cidade revisada", date: new Date("2026-10-11"), registrationUrl: null,
      publicationStatus: "hidden", administrativeReview: true,
      modality: "trail",
    } });
    await prisma.adminAudit.create({ data: { actorId: prefix, eventId: id, action: "review_event",
      details: { changes: { name: "Nome revisado", city: "Cidade revisada", date: "2026-10-11", registrationUrl: null, modality: "trail" } } } });
    await saveCanonicalEvent({ ...canonical, description: "Descrição nova" });
    expect(await prisma.event.findUnique({ where: { id } })).toMatchObject({
      name: "Nome revisado", city: "Cidade revisada", date: new Date("2026-10-11"), registrationUrl: null,
      publicationStatus: "hidden", description: "Descrição nova", modality: "trail",
    });
    expect((await prisma.eventSourceReference.findFirstOrThrow({ where: { eventId: id } })).observation)
      .toMatchObject({ name: canonical.name, city: canonical.city, date: canonical.date, modality: "road" });
  });
  it("a refresh through a supplemental reference cannot replace the primary source", async () => {
    const { canonical, id } = await fixture("primary");
    const secondary = await prisma.source.create({ data: { name: "Secundária", adapter: "corridasbr", externalId: prefix + "secondary",
      type: "aggregator", url: "https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=123" } });
    await prisma.eventSourceReference.create({ data: { eventId: id, sourceId: secondary.id, sourceType: "corridasbr",
      sourceExternalId: secondary.externalId!, url: secondary.url, role: "supplemental" } });
    await saveCanonicalEvent({ ...canonical, sourceType: "corridasbr", sourceExternalId: secondary.externalId,
      sourceId: secondary.id, sourceUrl: secondary.url, name: "Nome da fonte secundária", city: "Cidade secundária" });
    expect(await prisma.event.findUnique({ where: { id } })).toMatchObject({
      sourceType: "ticketsports", sourceId: canonical.sourceId, name: canonical.name, city: canonical.city,
    });
  });
  it("priority promotion preserves audited nulls, hidden status and the canonical edition ID", async () => {
    const { canonical, id } = await fixture("promoted", "corridasbr");
    await prisma.event.update({ where: { id }, data: { city: null, publicationStatus: "hidden", administrativeReview: true } });
    await prisma.adminAudit.create({ data: { actorId: prefix, eventId: id, action: "review_event",
      details: { changes: { city: null, publicationStatus: "hidden" } } } });
    const primary = await prisma.source.create({ data: { name: "Principal", adapter: "ticketsports",
      externalId: prefix + "promoted-ts", type: "registration_page", url: "https://www.ticketsports.com.br/e/promoted-fixture" } });
    await prisma.eventSourceReference.create({ data: { eventId: id, sourceId: primary.id, sourceType: "ticketsports",
      sourceExternalId: primary.externalId!, url: primary.url, role: "supplemental" } });
    const result = await saveCanonicalEvent({ ...canonical, sourceType: "ticketsports", sourceId: primary.id,
      sourceExternalId: primary.externalId, sourceUrl: primary.url, city: "Cidade da fonte principal" });
    expect(result.event.id).toBe(id);
    expect(await prisma.event.findUnique({ where: { id } })).toMatchObject({ sourceType: "ticketsports",
      sourceId: primary.id, city: null, publicationStatus: "hidden" });
    expect((await prisma.eventSourceReference.findFirstOrThrow({ where: { eventId: id, sourceId: primary.id } })).observation)
      .toMatchObject({ city: "Cidade da fonte principal" });
  });
});
