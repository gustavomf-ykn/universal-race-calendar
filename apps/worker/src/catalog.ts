import { createHash } from "node:crypto";
import { prisma, assertTaskLease, enqueueTask } from "@race-calendar/database";
import { discoverTicketSportsEvents, discoverCorridasBREvents } from "@race-calendar/sources";
import { syncNationalTicketSports } from "./national-catalog.js";
import { syncNationalCorridasBR } from "./corridas-catalog.js";

type Candidate = {
  externalId: string;
  name: string;
  url: string;
  date?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  metadata?: unknown;
};
export async function syncCatalog(input: Record<string, unknown>, discover?: () => Promise<Candidate[]>) {
  const id = String(input.syncId);
  let sync = await prisma.catalogSync.findUniqueOrThrow({ where: { id } });
  if (sync.source === "ticketsports" && (sync.options as { discoveryMode?: string }).discoveryMode === "national")
    return syncNationalTicketSports(sync);
  if (sync.source === "corridasbr" && (sync.options as { discoveryMode?: string }).discoveryMode === "national")
    return syncNationalCorridasBR(sync);
  const options = sync.options as {
    states: string[];
    batchSize: number;
    snapshotLimit: number;
    from?: string;
    to?: string;
    discoveryMode?: string;
  };
  if (sync.status !== "ready") return { stage: sync.status, syncId: id, processed: 0 };
  let snapshot = sync.snapshot as unknown as Candidate[];
  if (!snapshot.length && sync.cursor === 0) {
    const rows: Candidate[] = discover
      ? await discover()
      : sync.source === "ticketsports"
        ? await discoverTicketSportsEvents({ quantity: options.snapshotLimit })
        : await discoverCorridasBREvents({ states: [options.states[sync.page - 1]!], concurrency: 1 });
    // Preserve unknown dates for review; never infer a date from the event name.
    snapshot = rows.filter(
      (r) =>
        (!r.country || r.country === "BR") &&
        (!r.state || options.states.includes(r.state)) &&
        (!r.date || ((!options.from || r.date >= options.from) && (!options.to || r.date <= options.to))),
    );
    sync = await prisma.$transaction(async (tx) => {
      await assertTaskLease(tx, 65536 + Buffer.byteLength(JSON.stringify(snapshot)) * 8);
      return tx.catalogSync.update({
        where: { id },
        data: {
          snapshot: JSON.parse(JSON.stringify(snapshot)),
          discovered: { increment: rows.length },
          coverage: sync.source === "ticketsports" ? "bounded_snapshot" : "state_calendar",
          updatedAt: new Date(),
        },
      });
    });
  }
  let created = 0,
    existing = 0;
  const batch = snapshot.slice(sync.cursor, sync.cursor + options.batchSize);
  for (const row of batch) {
    await prisma.$transaction(async (tx) => {
      await assertTaskLease(tx, 65536 + Buffer.byteLength(JSON.stringify(sync.snapshot)) * 8);
      const identity = { sourceType: sync.source, sourceExternalId: row.externalId };
      const ref = await tx.eventSourceReference.findUnique({ where: { sourceType_sourceExternalId: identity } });
      let sourceId = ref?.sourceId;
      if (ref) {
        await tx.eventSourceReference.update({ where: { id: ref.id }, data: { lastSeenAt: new Date() } });
        existing++;
      } else {
        const source = await tx.source.upsert({
          where: { adapter_externalId: { adapter: sync.source, externalId: row.externalId } },
          update: {},
          create: {
            name: row.name,
            url: row.url,
            type: "aggregator",
            adapter: sync.source,
            externalId: row.externalId,
            metadata: { catalog: true },
          },
        });
        sourceId = source.id;
        const digest = createHash("sha256")
          .update(sync.source + ":" + row.externalId)
          .digest("hex");
        const event = await tx.event.upsert({
          where: { sourceType_sourceExternalId: identity },
          update: {},
          create: {
            id: "evt_" + digest.slice(0, 24),
            slug: sync.source + "-" + digest.slice(0, 24),
            name: row.name,
            date: row.date ? new Date(row.date) : null,
            city: row.city || null,
            state: row.state || null,
            country: row.country || null,
            sourceId: source.id,
            ...identity,
            sourceUrl: row.url,
            canonicalFingerprint: digest,
            warnings: row.country ? [] : ["country_unconfirmed"],
            publishabilityReasons: ["administrative_review_required", ...(!row.country ? ["country_unconfirmed"] : [])],
            publicationStatus: "pending_review",
            administrativeReview: options.discoveryMode !== "national",
          },
        });
        await tx.eventSourceReference.create({
          data: { eventId: event.id, sourceId: source.id, ...identity, url: row.url },
        });
        created++;
      }
      if (options.discoveryMode === "national" && sourceId) {
        const key = createHash("sha256").update(`catalog-enrich:${id}:${row.externalId}`).digest("hex");
        await enqueueTask(sync.ownerId, key, sync.source, "check-source", { sourceId, syncId: id }, tx);
      }
      // Candidate and checkpoint commit together: a retry cannot skip a failed candidate.
      await tx.catalogSync.update({
        where: { id },
        data: { cursor: { increment: 1 }, processed: { increment: 1 }, updatedAt: new Date() },
      });
    });
  }
  const next = sync.cursor + batch.length;
  const finished = next >= snapshot.length;
  const nextState = sync.source === "corridasbr" && sync.page < options.states.length;
  await prisma.$transaction(async (tx) => {
    await assertTaskLease(tx, 65536 + Buffer.byteLength(JSON.stringify(sync.snapshot)) * 8);
    await tx.catalogSync.update({
      where: { id },
      data: finished
        ? nextState
          ? { snapshot: [], cursor: 0, page: { increment: 1 }, updatedAt: new Date() }
          : { status: sync.source === "ticketsports" ? "limited" : "completed", updatedAt: new Date() }
        : { updatedAt: new Date() },
    });
  });
  return {
    stage: "catalog_batch",
    syncId: id,
    created,
    existing,
    processed: batch.length,
    coverage: sync.source === "ticketsports" ? "bounded_snapshot" : "state_calendar",
  };
}
