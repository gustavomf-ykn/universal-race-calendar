import { createHash } from "node:crypto";
import { prisma, assertTaskLease, enqueueTask } from "@race-calendar/database";
import { discoverTicketSportsCatalogPage, nextTicketSportsPrefix, type TicketSportsCatalogPage } from "@race-calendar/sources";
type CatalogSync = Awaited<ReturnType<typeof prisma.catalogSync.findUniqueOrThrow>>;

type Receipt = { state: string; status: string; reason: string; requested: number; rawCount: number; unique: number };
type Snapshot = {
  nationalVersion: 1;
  candidates: TicketSportsCatalogPage["events"];
  seenIds: string[];
  allSeenIds?: string[];
  quantity: number;
  nextQuantity: number;
  status: "ready" | "completed" | "limited";
  reason: string;
  rawCount: number;
  receipts: Receipt[];
};
export function nationalSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Snapshot;
  if (s.nationalVersion !== 1 || !Array.isArray(s.candidates) || !Array.isArray(s.seenIds) || !Array.isArray(s.receipts))
    throw Error("catalog_checkpoint_incompatible");
  return s;
}

export async function syncNationalTicketSports(sync: CatalogSync, discover = discoverTicketSportsCatalogPage) {
  const options = sync.options as { states: string[]; batchSize: number; prefixLimit?: number; from?: string; to?: string };
  if (sync.status !== "ready") return { stage: sync.status, syncId: sync.id, processed: 0 };
  // Reconcile the nationwide listing as well: UF partitions omit records without a UF.
  const partitions = [...options.states, "BR"];
  const state = partitions[sync.page - 1];
  if (!state) throw Error("catalog_checkpoint_incompatible");
  let snapshot = nationalSnapshot(sync.snapshot);
  if (!snapshot || (!snapshot.candidates.length && sync.cursor === 0)) {
    const previous = snapshot?.seenIds ?? [];
    const result = await discover({ quantity: snapshot?.nextQuantity ?? 25, ...(state === "BR" ? {} : { state }),
      ...(options.from ? { from: options.from } : {}), ...(options.to ? { to: options.to } : {}) });
    if (state !== "BR" && result.events.some(e => e.state && e.state !== state)) throw Error("catalog_region_ignored");
    const expansion = nextTicketSportsPrefix(result, previous, options.prefixLimit ?? 10000);
    if (expansion.status === "blocked") throw Error(expansion.reason);
    const seen = new Set(snapshot?.allSeenIds ?? previous);
    const eligible = result.events.filter(e => !e.state || options.states.includes(e.state));
    snapshot = {
      nationalVersion: 1,
      candidates: eligible.filter(e => !seen.has(e.externalId)),
      seenIds: [...new Set([...previous, ...result.rawIds])],
      allSeenIds: [...new Set([...seen, ...eligible.map(e => e.externalId)])],
      quantity: result.requested, nextQuantity: expansion.quantity, status: expansion.status,
      reason: expansion.reason, rawCount: result.rawCount, receipts: snapshot?.receipts ?? [],
    };
    await prisma.$transaction(async tx => {
      await assertTaskLease(tx);
      await tx.catalogSync.update({ where: { id: sync.id }, data: {
        snapshot: JSON.parse(JSON.stringify(snapshot)), discovered: { increment: snapshot!.candidates.length },
        coverage: "official_state_and_national_prefixes", updatedAt: new Date(),
      } });
    });
  }
  const batch = snapshot.candidates.slice(sync.cursor, sync.cursor + options.batchSize);
  let created = 0, existing = 0;
  for (const candidate of batch) {
    await prisma.$transaction(async tx => {
      await assertTaskLease(tx);
      const identity = { sourceType: "ticketsports", sourceExternalId: candidate.externalId };
      const ref = await tx.eventSourceReference.findUnique({ where: { sourceType_sourceExternalId: identity } });
      const digest = createHash("sha256").update(`ticketsports:${candidate.externalId}`).digest("hex");
      const source = await tx.source.upsert({
        where: { adapter_externalId: { adapter: "ticketsports", externalId: candidate.externalId } },
        update: { metadata: JSON.parse(JSON.stringify(candidate.metadata)) },
        create: { name: candidate.name, url: candidate.url, type: "registration_page", adapter: "ticketsports",
          externalId: candidate.externalId, metadata: JSON.parse(JSON.stringify(candidate.metadata)) },
      });
      if (ref) {
        await tx.eventSourceReference.update({ where: { id: ref.id }, data: { lastSeenAt: new Date() } });
        existing++;
      } else {
        const event = await tx.event.upsert({ where: { sourceType_sourceExternalId: identity }, update: {}, create: {
          id: "evt_" + digest.slice(0, 24), slug: "ticketsports-" + digest.slice(0, 24), name: candidate.name,
          date: candidate.date ? new Date(candidate.date) : null, city: candidate.city, state: candidate.state,
          country: "BR", sourceId: source.id, ...identity, sourceUrl: candidate.url, canonicalFingerprint: digest,
          warnings: [], publishabilityReasons: ["metadata_validation_required"], publicationStatus: "pending_review",
          administrativeReview: false,
        } });
        await tx.eventSourceReference.create({ data: { eventId: event.id, sourceId: source.id, ...identity, url: candidate.url } });
        created++;
      }
      // Enrichment is durable and idempotent per synchronization/reference, also for existing editions.
      const key = createHash("sha256").update(`catalog-enrich:${sync.id}:${candidate.externalId}`).digest("hex");
      await enqueueTask(sync.ownerId, key, "ticketsports", "check-source", { sourceId: source.id, syncId: sync.id }, tx);
      await tx.catalogSync.update({ where: { id: sync.id }, data: { cursor: { increment: 1 }, processed: { increment: 1 }, updatedAt: new Date() } });
    });
  }
  const finished = sync.cursor + batch.length >= snapshot.candidates.length;
  if (finished) {
    const receipts = snapshot.status === "ready" ? snapshot.receipts : [...snapshot.receipts, {
      state, status: snapshot.status, reason: snapshot.reason, requested: snapshot.quantity,
      rawCount: snapshot.rawCount, unique: snapshot.seenIds.length,
    }];
    const nextState = snapshot.status !== "ready" && sync.page < partitions.length;
    const finalStatus = receipts.some(r => r.status === "limited") ? "limited" : "completed";
    const nextSnapshot: Snapshot = { ...snapshot, candidates: [], receipts,
      ...(nextState ? { seenIds: [], quantity: 25, nextQuantity: 25, status: "ready", reason: "next_state", rawCount: 0 } : {}) };
    await prisma.$transaction(async tx => {
      await assertTaskLease(tx);
      await tx.catalogSync.update({ where: { id: sync.id }, data: {
        snapshot: JSON.parse(JSON.stringify(nextSnapshot)), cursor: 0,
        ...(nextState ? { page: { increment: 1 } } : snapshot.status !== "ready" ? { status: finalStatus } : {}),
        updatedAt: new Date(),
      } });
    });
  }
  return { stage: "catalog_batch", syncId: sync.id, created, existing, processed: batch.length,
    coverage: "official_state_and_national_prefixes", state, requested: snapshot.quantity };
}
