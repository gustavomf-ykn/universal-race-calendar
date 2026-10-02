import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { generateEventFingerprint } from "@race-calendar/utils";
import { prisma } from "./index.js";
import { assertTaskLease } from "./lease.js";
import { capacityGrowth } from "./capacity.js";
import { observationOf, type SourceObservation } from "./source-comparison.js";
import { stableJson, TaskConflict } from "./tasks.js";
import {
  crossSourceEditionReason,
  editionLocationEvidence,
  editionLinks,
  editionUrlVariants,
} from "./edition-evidence.js";

export class ReconciliationConflict extends Error {}
export async function resolveEventId(id: string, tx: Prisma.TransactionClient = prisma): Promise<string> {
  return (
    (await tx.eventAlias.findUnique({ where: { id }, select: { canonicalEventId: true } }))?.canonicalEventId ?? id
  );
}
export async function resolveEventIds(ids: string[], tx: Prisma.TransactionClient = prisma): Promise<string[]> {
  const aliases = await tx.eventAlias.findMany({
    where: { id: { in: ids } },
    select: { id: true, canonicalEventId: true },
  });
  const mapping = new Map(aliases.map((a) => [a.id, a.canonicalEventId]));
  return [...new Set(ids.map((id) => mapping.get(id) ?? id))];
}
export async function resolveEventSlug(slug: string, tx: Prisma.TransactionClient = prisma): Promise<string | null> {
  return (
    (await tx.event.findUnique({ where: { slug }, select: { id: true } }))?.id ??
    (await tx.eventAlias.findUnique({ where: { oldSlug: slug }, select: { canonicalEventId: true } }))
      ?.canonicalEventId ??
    null
  );
}

const include = {
  sourceReferences: { orderBy: { id: "asc" as const } },
  distances: { orderBy: { id: "asc" as const } },
  prices: { orderBy: { id: "asc" as const } },
  kits: { orderBy: { id: "asc" as const } },
  kitPickups: { orderBy: { id: "asc" as const } },
  schedule: { orderBy: { id: "asc" as const } },
  rules: { orderBy: { id: "asc" as const } },
  images: { orderBy: { id: "asc" as const } },
  versions: { select: { id: true }, orderBy: { id: "asc" as const } },
  extractionJobs: { select: { id: true }, orderBy: { id: "asc" as const } },
  curationJobs: { select: { id: true }, orderBy: { id: "asc" as const } },
  resultSets: { select: { id: true, count: true, source: true, externalId: true }, orderBy: { id: "asc" as const } },
  resultCheckpoints: { select: { rootTaskId: true }, orderBy: { rootTaskId: "asc" as const } },
  exports: { select: { id: true }, orderBy: { id: "asc" as const } },
} satisfies Prisma.EventInclude;
type Row = Prisma.EventGetPayload<{ include: typeof include }>;
const scalarFields = [
  "name",
  "description",
  "date",
  "startTime",
  "endTime",
  "city",
  "state",
  "country",
  "locationName",
  "address",
  "latitude",
  "longitude",
  "modality",
  "eventStatus",
  "registrationUrl",
  "officialUrl",
  "regulationUrl",
  "organizerName",
  "organizerUrl",
  "mainImageUrl",
] as const;
const priority = (source: string | null) =>
  source === "ticketsports" ? 100 : source === "official" ? 80 : source === "corridasbr" ? 50 : 10;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(stableJson(json(value)))
    .digest("hex");

async function activeTasks(
  tx: Prisma.TransactionClient,
  eventIds: string[],
  sourceIds: string[],
  sourceTypes: string[],
) {
  return tx.$queryRaw<
    Array<{ id: string; kind: string; source: string }>
  >`SELECT t.id,t.kind,t.source FROM "CollectionTask" t
    WHERE t.status='running' AND (t.payload->>'eventId'=ANY(${eventIds}::text[])
      OR t.payload->'eventIds' ?| ${eventIds}::text[] OR t.payload->>'sourceId'=ANY(${sourceIds}::text[])
      OR EXISTS(SELECT FROM "ExportArtifact" a WHERE a."taskId"=t.id
        AND (a."eventId"=ANY(${eventIds}::text[]) OR a.selection->'eventIds' ?| ${eventIds}::text[]))
      OR EXISTS(SELECT FROM "ResultCheckpoint" c WHERE c."activeTaskId"=t.id AND c."eventId"=ANY(${eventIds}::text[])))
      OR t.status='running' AND t.kind IN ('calendar','catalog','catalog-process','catalog-sync','curate-batch')
        AND (t.source='maintenance' OR t.source=ANY(${sourceTypes}::text[]))
    ORDER BY t.id`;
}
async function inspect(tx: Prisma.TransactionClient, sourceId: string, targetId: string) {
  const source = await tx.event.findUnique({ where: { id: sourceId }, include });
  const target = await tx.event.findUnique({ where: { id: targetId }, include });
  if (!source || !target) throw new ReconciliationConflict("event_not_found");
  if (sourceId === targetId) throw new ReconciliationConflict("editions_already_unified");
  const aliases = await tx.eventAlias.findMany({
    where: { canonicalEventId: { in: [sourceId, targetId] } },
    orderBy: { id: "asc" },
  });
  const audits = await tx.adminAudit.findMany({
    where: { eventId: { in: [sourceId, targetId] }, action: { in: ["review_event", "publication_status"] } },
    orderBy: { id: "asc" },
  });
  const protectedFields = (id: string) =>
    new Set(
      audits
        .filter((a) => a.eventId === id)
        .flatMap((a) => {
          if (a.action === "publication_status") return ["publicationStatus"];
          const details = a.details as { changes?: object };
          return Object.keys(details?.changes ?? {});
        }),
    );
  const sourceProtected = protectedFields(sourceId),
    targetProtected = protectedFields(targetId);
  const reasons = new Set<string>();
  const location = editionLocationEvidence(source, target);
  if (location) reasons.add(location);
  if ([source, target].some((e) => ["hidden", "rejected"].includes(e.publicationStatus)))
    reasons.add("edition_administratively_restricted");
  if (!source.sourceReferences.length || !target.sourceReferences.length) reasons.add("edition_link_unconfirmed");
  const references = [...source.sourceReferences, ...target.sourceReferences];
  for (const ref of references)
    if (
      references.some((other) => other.sourceType === ref.sourceType && other.sourceExternalId !== ref.sourceExternalId)
    )
      reasons.add("edition_source_identity_conflict");
  for (const field of [...scalarFields, "publicationStatus"] as const)
    if (sourceProtected.has(field) && targetProtected.has(field) && hash(source[field]) !== hash(target[field]))
      reasons.add("edition_manual_conflict");
  let automaticReason = reasons.size
    ? [...reasons][0]!
    : (crossSourceEditionReason(source, target) ?? crossSourceEditionReason(target, source));
  if (!automaticReason) {
    const links = [...editionLinks(source), ...editionLinks(target)];
    const urls = [...new Set(links.flatMap(editionUrlVariants))];
    const ticketIds = links.filter((link) => link.source === "ticketsports").map((link) => link.externalId);
    const conflicting = await tx.event.findFirst({
      where: {
        id: { notIn: [sourceId, targetId] },
        OR: [
          { sourceType: "ticketsports", sourceExternalId: { in: ticketIds } },
          { sourceReferences: { some: { sourceType: "ticketsports", sourceExternalId: { in: ticketIds } } } },
          { registrationUrl: { in: urls } },
          { officialUrl: { in: urls } },
          { sourceUrl: { in: urls } },
          { sourceReferences: { some: { url: { in: urls } } } },
        ],
      },
      select: { id: true },
    });
    if (conflicting) automaticReason = "edition_link_ambiguous";
  }
  const eventIds = [sourceId, targetId, ...aliases.map((a) => a.id)];
  const running = await activeTasks(
    tx,
    eventIds,
    references.map((r) => r.sourceId),
    references.map((r) => r.sourceType),
  );
  if (running.length) reasons.add("edition_reconciliation_in_use");
  return {
    source,
    target,
    aliases,
    audits,
    sourceProtected,
    targetProtected,
    reasons: [...reasons],
    running,
    automaticReason,
    revision: hash({ source, target, aliases, audits }),
  };
}
export async function previewEventReconciliation(sourceId: string, targetId: string) {
  return prisma.$transaction(async (tx) => {
    const state = await inspect(tx, await resolveEventId(sourceId, tx), await resolveEventId(targetId, tx));
    const summary = (row: Row) => ({
      id: row.id,
      name: row.name,
      date: row.date,
      city: row.city,
      state: row.state,
      country: row.country,
      publicationStatus: row.publicationStatus,
      sources: row.sourceReferences.map((r) => ({
        sourceType: r.sourceType,
        externalId: r.sourceExternalId,
        url: r.url,
        observation: observationOf(r.observation as SourceObservation),
        lastValidatedAt: r.lastValidatedAt,
      })),
      results: row.resultSets.reduce((n, r) => n + r.count, 0),
      exports: row.exports.length,
    });
    return {
      source: summary(state.source),
      target: summary(state.target),
      revision: state.revision,
      canMerge: state.reasons.length === 0,
      reasons: state.reasons,
      automatic: state.reasons.length === 0 && state.automaticReason === null,
      automaticReason: state.automaticReason,
      runningTasks: state.running,
    };
  });
}
export type ReconciliationInput = {
  sourceId: string;
  targetId: string;
  revision: string;
  reason: string;
  confirmedSameEdition: boolean;
  mode: "manual" | "automatic";
};
export async function reconcileEventEditions(actorId: string, key: string, input: ReconciliationInput) {
  if (!actorId || !key || key.length > 128 || input.reason.trim().length < 3 || input.reason.length > 500)
    throw new ReconciliationConflict("reconciliation_request_invalid");
  const requestHash = hash(input);
  return prisma.$transaction(
    async (tx) => {
      await assertTaskLease(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"reconcile:" + actorId + ":" + key},0))`;
      const previous = await tx.adminAudit.findFirst({
        where: { actorId, action: "reconcile_events", details: { path: ["idempotencyKey"], equals: key } },
      });
      if (previous) {
        const details = previous.details as {
          requestHash: string;
          result: { eventId: string; sourceId: string; auditId: string };
        };
        if (details.requestHash !== requestHash) throw new TaskConflict("idempotency_conflict");
        return details.result;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('race_event_reconciliation',0))`;
      const sourceId = await resolveEventId(input.sourceId, tx),
        targetId = await resolveEventId(input.targetId, tx);
      const original = await tx.event.findUnique({ where: { id: sourceId }, select: { slug: true } });
      if (!original) throw new ReconciliationConflict("event_not_found");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"event_id:" + sourceId},0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"event_slug:" + original.slug},0))`;
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id=ANY(${[sourceId, targetId]}::text[]) ORDER BY id FOR UPDATE`;
      const state = await inspect(tx, sourceId, targetId);
      if (state.revision !== input.revision) throw new ReconciliationConflict("reconciliation_preview_stale");
      if (state.reasons.length) throw new ReconciliationConflict(state.reasons[0]);
      if (!input.confirmedSameEdition) throw new ReconciliationConflict("edition_confirmation_required");
      if (input.mode === "automatic" && state.automaticReason) throw new ReconciliationConflict(state.automaticReason);
      await assertTaskLease(tx, capacityGrowth({ snapshot: state.source, audit: input }));
      const primary = [...state.target.sourceReferences, ...state.source.sourceReferences].sort(
        (a, b) => priority(b.sourceType) - priority(a.sourceType),
      )[0]!;
      const preferred = primary.eventId === sourceId ? state.source : state.target;
      const changes: Record<string, unknown> = {};
      for (const field of scalarFields) {
        const absent = (value: unknown) => value == null || value === "" || value === "unknown";
        changes[field] = state.targetProtected.has(field)
          ? state.target[field]
          : state.sourceProtected.has(field)
            ? state.source[field]
            : !absent(preferred[field])
              ? preferred[field]
              : !absent(state.target[field])
                ? state.target[field]
                : state.source[field];
      }
      const publicationStatus = state.targetProtected.has("publicationStatus")
        ? state.target.publicationStatus
        : state.sourceProtected.has("publicationStatus")
          ? state.source.publicationStatus
          : [state.target.publicationStatus, state.source.publicationStatus].includes("published")
            ? "published"
            : state.target.publicationStatus;
      const identity = changes as Pick<Row, "name" | "date" | "city" | "state" | "country">;
      // Free the transferred primary identity before assigning it to the target.
      await tx.event.update({ where: { id: sourceId }, data: { sourceType: null, sourceExternalId: null } });
      await tx.event.update({
        where: { id: targetId },
        data: {
          ...changes,
          canonicalFingerprint: generateEventFingerprint({
            ...identity,
            date: identity.date?.toISOString().slice(0, 10),
          }),
          publicationStatus,
          publishedAt:
            publicationStatus === "published"
              ? (state.target.publishedAt ?? state.source.publishedAt ?? new Date())
              : null,
          sourceId: primary.sourceId,
          sourceType: primary.sourceType,
          sourceExternalId: primary.sourceExternalId,
          sourceUrl: primary.url,
          administrativeReview: state.source.administrativeReview || state.target.administrativeReview,
          confidence: Math.max(state.source.confidence, state.target.confidence),
          duplicateOfEventId: null,
          dedupeStatus: "unique",
        },
      });
      await tx.eventSourceReference.updateMany({
        where: { eventId: sourceId },
        data: { eventId: targetId, role: "supplemental" },
      });
      await tx.eventSourceReference.updateMany({
        where: { eventId: targetId },
        data: { role: "supplemental" },
      });
      await tx.eventSourceReference.updateMany({
        where: {
          eventId: targetId,
          sourceType: primary.sourceType,
          sourceExternalId: primary.sourceExternalId,
        },
        data: { role: "primary" },
      });
      const transfer = { eventId: targetId };
      await tx.resultSet.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.resultCheckpoint.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.exportArtifact.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.eventVersion.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.extractionJob.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.curationJob.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.adminAudit.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.sourceMatch.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.importCandidate.updateMany({ where: { matchEventId: sourceId }, data: { matchEventId: targetId } });
      await tx.event.updateMany({ where: { duplicateOfEventId: sourceId }, data: { duplicateOfEventId: targetId } });
      // Complete a missing collection; conflicting collections remain in the archived snapshot.
      if (!state.target.distances.length)
        await tx.eventDistance.updateMany({ where: { eventId: sourceId }, data: transfer });
      if (!state.target.prices.length) await tx.eventPrice.updateMany({ where: { eventId: sourceId }, data: transfer });
      if (!state.target.kits.length) await tx.eventKit.updateMany({ where: { eventId: sourceId }, data: transfer });
      if (!state.target.kitPickups.length)
        await tx.eventKitPickup.updateMany({ where: { eventId: sourceId }, data: transfer });
      if (!state.target.schedule.length)
        await tx.eventSchedule.updateMany({ where: { eventId: sourceId }, data: transfer });
      if (!state.target.rules.length) await tx.eventRule.updateMany({ where: { eventId: sourceId }, data: transfer });
      if (!state.target.images.length) await tx.eventImage.updateMany({ where: { eventId: sourceId }, data: transfer });
      await tx.eventAlias.updateMany({ where: { canonicalEventId: sourceId }, data: { canonicalEventId: targetId } });
      await tx.event.delete({ where: { id: sourceId } });
      await tx.eventAlias.create({
        data: {
          id: sourceId,
          oldSlug: state.source.slug,
          canonicalEventId: targetId,
          snapshot: json(state.source),
          createdBy: actorId,
        },
      });
      const auditId = randomUUID();
      const result = { eventId: targetId, sourceId, auditId };
      await tx.adminAudit.create({
        data: {
          id: auditId,
          actorId,
          eventId: targetId,
          action: "reconcile_events",
          details: json({
            idempotencyKey: key,
            requestHash,
            result,
            reason: input.reason,
            mode: input.mode,
            from: sourceId,
            to: targetId,
            originalReviewIds: state.audits.map((a) => a.id),
            revision: state.revision,
          }),
        },
      });
      return result;
    },
    { timeout: 30000 },
  );
}
