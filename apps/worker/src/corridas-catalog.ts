import { createHash } from "node:crypto";
import { prisma, assertTaskLease, enqueueTask } from "@race-calendar/database";
import { discoverCorridasBRCatalogPage, corridasBRCalendarUrl, type CorridasBRCatalogPage } from "@race-calendar/sources";

type Sync = Awaited<ReturnType<typeof prisma.catalogSync.findUniqueOrThrow>>;
type Snapshot = {
  corridasVersion: 2; candidates: CorridasBRCatalogPage["events"]; seenIds: string[];
  pageUrl: string; pendingUrls: string[]; visitedUrls: string[]; stateIds: string[]; rawCount: number;
  unknownCountryIds: string[]; excludedCountryIds: string[];
  receipts: Array<{ state: string; status: string; reason: string; requested: number; rawCount: number; unique: number;
    unknownCountry: number; outOfScope: number; scope: "source_partition" }>;
};
export async function syncNationalCorridasBR(sync: Sync, discover = discoverCorridasBRCatalogPage) {
  if (sync.status !== "ready") return { stage: sync.status, syncId: sync.id, processed: 0 };
  const options = sync.options as { states: string[]; batchSize: number; from?: string; to?: string };
  const state = options.states[sync.page - 1];
  if (!state) throw Error("catalog_checkpoint_incompatible");
  let snapshot: Snapshot;
  if (Array.isArray(sync.snapshot) && !sync.snapshot.length) snapshot = {
    corridasVersion: 2, candidates: [], seenIds: [], pageUrl: corridasBRCalendarUrl(state),
    pendingUrls: [], visitedUrls: [], stateIds: [], rawCount: 0, receipts: [],
    unknownCountryIds: [], excludedCountryIds: [],
  };
  else {
    snapshot = sync.snapshot as unknown as Snapshot;
    if (snapshot.corridasVersion !== 2 || !Array.isArray(snapshot.candidates) || !Array.isArray(snapshot.visitedUrls) ||
        !Array.isArray(snapshot.unknownCountryIds) || !Array.isArray(snapshot.excludedCountryIds))
      throw Error("catalog_checkpoint_incompatible");
  }
  if (!snapshot.candidates.length && sync.cursor === 0) {
    const page = await discover({ state, url: snapshot.pageUrl });
    if (page.events.some(e => e.state !== state)) throw Error("catalog_region_ignored");
    const visited = new Set([...snapshot.visitedUrls, page.url]);
    const seen = new Set(snapshot.seenIds);
    const eligible = page.events.filter(e => (!e.country || e.country === "BR") &&
      (!e.date || ((!options.from || e.date >= options.from) && (!options.to || e.date <= options.to))));
    snapshot = { ...snapshot, pageUrl: page.url, candidates: eligible.filter(e => !seen.has(e.externalId)),
      seenIds: [...new Set([...seen, ...eligible.map(e => e.externalId)])],
      visitedUrls: [...visited], pendingUrls: [...new Set([...snapshot.pendingUrls, ...page.nextUrls])].filter(url => !visited.has(url)),
      stateIds: [...new Set([...snapshot.stateIds, ...page.events.map(e => e.externalId)])], rawCount: snapshot.rawCount + page.events.length,
      unknownCountryIds: [...new Set([...snapshot.unknownCountryIds, ...page.events.filter(e => !e.country).map(e => e.externalId)])],
      excludedCountryIds: [...new Set([...snapshot.excludedCountryIds, ...page.events.filter(e => e.country && e.country !== "BR").map(e => e.externalId)])],
    };
    await prisma.$transaction(async tx => {
      await assertTaskLease(tx, 65536 + Buffer.byteLength(JSON.stringify(snapshot)) * 8);
      await tx.catalogSync.update({ where: { id: sync.id }, data: {
        snapshot: JSON.parse(JSON.stringify(snapshot)), discovered: { increment: snapshot.candidates.length },
        coverage: "explicit_state_calendar_links", updatedAt: new Date(),
      } });
    });
  }
  const batch = snapshot.candidates.slice(sync.cursor, sync.cursor + options.batchSize);
  let created = 0, existing = 0;
  for (const candidate of batch) await prisma.$transaction(async tx => {
    await assertTaskLease(tx, 65536 + Buffer.byteLength(JSON.stringify(snapshot)) * 8);
    const identity = { sourceType: "corridasbr", sourceExternalId: candidate.externalId };
    const ref = await tx.eventSourceReference.findUnique({ where: { sourceType_sourceExternalId: identity } });
    const source = await tx.source.upsert({ where: { adapter_externalId: { adapter: "corridasbr", externalId: candidate.externalId } },
      update: { metadata: JSON.parse(JSON.stringify(candidate.metadata)) }, create: {
        name: candidate.name, url: candidate.url, type: "aggregator", adapter: "corridasbr", externalId: candidate.externalId,
        metadata: JSON.parse(JSON.stringify(candidate.metadata)),
      } });
    if (ref) {
      await tx.eventSourceReference.update({ where: { id: ref.id }, data: { lastSeenAt: new Date() } }); existing++;
    } else {
      const digest = createHash("sha256").update(`corridasbr:${candidate.externalId}`).digest("hex");
      const event = await tx.event.upsert({ where: { sourceType_sourceExternalId: identity }, update: {}, create: {
        id: "evt_" + digest.slice(0, 24), slug: "corridasbr-" + digest.slice(0, 24), name: candidate.name,
        date: candidate.date ? new Date(candidate.date) : null, city: candidate.city, state: candidate.state, country: candidate.country,
        sourceId: source.id, ...identity, sourceUrl: candidate.url, canonicalFingerprint: digest,
        warnings: candidate.country ? [] : ["country_unconfirmed"],
        publishabilityReasons: ["metadata_validation_required", ...(!candidate.country ? ["country_unconfirmed"] : [])],
        publicationStatus: "pending_review", administrativeReview: false,
      } });
      await tx.eventSourceReference.create({ data: { eventId: event.id, sourceId: source.id, ...identity, url: candidate.url } }); created++;
    }
    const key = createHash("sha256").update(`catalog-enrich:${sync.id}:${candidate.externalId}`).digest("hex");
    await enqueueTask(sync.ownerId, key, "corridasbr", "check-source", { sourceId: source.id, syncId: sync.id }, tx);
    await tx.catalogSync.update({ where: { id: sync.id }, data: { cursor: { increment: 1 }, processed: { increment: 1 }, updatedAt: new Date() } });
  });
  if (sync.cursor + batch.length >= snapshot.candidates.length) {
    const nextPage = snapshot.pendingUrls[0];
    const nextState = !nextPage && sync.page < options.states.length;
    const receipts = nextPage ? snapshot.receipts : [...snapshot.receipts, {
      state, status: "completed", reason: "explicit_calendar_navigation_end", requested: snapshot.visitedUrls.length,
      rawCount: snapshot.rawCount, unique: snapshot.stateIds.length,
      unknownCountry: snapshot.unknownCountryIds.length, outOfScope: snapshot.excludedCountryIds.length, scope: "source_partition" as const,
    }];
    const nextSnapshot: Snapshot = { ...snapshot, candidates: [], receipts,
      ...(nextPage ? { pageUrl: nextPage, pendingUrls: snapshot.pendingUrls.slice(1) } : {}),
      ...(nextState ? { pageUrl: corridasBRCalendarUrl(options.states[sync.page]!), pendingUrls: [], visitedUrls: [], stateIds: [], rawCount: 0,
        unknownCountryIds: [], excludedCountryIds: [] } : {}),
    };
    await prisma.$transaction(async tx => {
      await assertTaskLease(tx, 65536 + Buffer.byteLength(JSON.stringify(snapshot)) * 8);
      await tx.catalogSync.update({ where: { id: sync.id }, data: { snapshot: JSON.parse(JSON.stringify(nextSnapshot)), cursor: 0,
        ...(nextState ? { page: { increment: 1 } } : !nextPage ? { status: "completed" } : {}), updatedAt: new Date() } });
    });
  }
  return { stage: "catalog_batch", syncId: sync.id, processed: batch.length, created, existing, state,
    coverage: "explicit_state_calendar_links" };
}
