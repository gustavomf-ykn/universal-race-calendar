import type { CollectionTask, Prisma, ResultCheckpoint } from "@prisma/client";
import { countryFromExplicitValue } from "@race-calendar/utils";
import { prisma } from "./index.js";
import { TaskConflict } from "./tasks.js";
import { resolveEventId } from "./event-reconciliation.js";
import { validPublicationDate } from "./publication-policy.js";

export const resultParserVersion = 2;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const locationText = (value: string | null) =>
  (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

async function checkpointEditionReason(root: ResultCheckpoint, db: Prisma.TransactionClient): Promise<string | null> {
  const metadata = record(record(root.manifest).metadata);
  if (!Object.keys(metadata).length) return "result_checkpoint_incompatible";
  if (String(metadata.event_id ?? "") !== root.externalId) return "source_identity_mismatch";
  if (
    typeof metadata.source_url !== "string" ||
    metadata.source_url.replace(/\/$/, "") !== root.sourceUrl.replace(/\/$/, "")
  )
    return "association_changed";
  const ref = await db.eventSourceReference.findUnique({
    where: { sourceType_sourceExternalId: { sourceType: "openresults", sourceExternalId: root.externalId } },
    include: { event: true },
  });
  if (!ref || ref.eventId !== root.eventId || ref.url !== root.sourceUrl) return "association_changed";
  if (!ref.event.date || typeof metadata.event_date !== "string" || !validPublicationDate(metadata.event_date))
    return "edition_date_unconfirmed";
  if (ref.event.date.toISOString().slice(0, 10) !== metadata.event_date) return "edition_date_mismatch";
  const countryEvidence = record(record(metadata.raw_metadata).country_evidence);
  const country = countryFromExplicitValue(typeof metadata.country === "string" ? metadata.country : null).country;
  if (["conflicting", "unrecognized"].includes(String(countryEvidence.status)) || (metadata.country && !country))
    return "edition_location_unconfirmed";
  const audits = await db.adminAudit.findMany({
    where: { eventId: root.eventId, action: "review_event" },
    select: { details: true },
  });
  const protectedFields = new Set(audits.flatMap((audit) => Object.keys(record(record(audit.details).changes))));
  for (const field of ["city", "state", "country"] as const) {
    if (protectedFields.has(field)) continue;
    const incoming = field === "country" ? country : typeof metadata[field] === "string" ? metadata[field] : null;
    const old = locationText(ref.event[field]),
      observed = locationText(incoming);
    if (old && observed && old !== observed) return "edition_location_conflict";
  }
  return null;
}

export function resultCheckpointRoot(task: CollectionTask): string {
  const payload = task.payload as Record<string, unknown>;
  return typeof payload.checkpointOf === "string" ? payload.checkpointOf : task.id;
}

export async function readResultCheckpoint(task: CollectionTask, db: Prisma.TransactionClient = prisma) {
  if (task.source !== "openresults" || task.kind !== "extract") return undefined;
  const rootId = resultCheckpointRoot(task);
  const root = await db.resultCheckpoint.findUnique({
    where: { rootTaskId: rootId },
    include: { groups: true, activeTask: { select: { id: true, status: true } } },
  });
  if (!root) return { available: false, reason: "result_checkpoint_unavailable" };
  const payload = task.payload as Record<string, unknown>;
  let reason: string | null = null;
  if (
    root.parserVersion !== resultParserVersion ||
    root.eventId !== (await resolveEventId(String(payload.eventId), db)) ||
    root.externalId !== payload.externalId ||
    root.sourceUrl !== payload.url
  )
    reason = "result_checkpoint_incompatible";
  else if (root.expiresAt <= new Date() || root.status === "expired") reason = "result_checkpoint_expired";
  else if (!["collecting", "ready"].includes(root.status)) reason = "result_checkpoint_unavailable";
  else if (root.activeTask && ["queued", "running"].includes(root.activeTask.status))
    reason = "result_checkpoint_in_use";
  else reason = await checkpointEditionReason(root, db);
  return {
    available: reason === null,
    reason,
    rootId,
    status: root.status,
    parserVersion: root.parserVersion,
    pageSize: root.pageSize,
    expiresAt: root.expiresAt,
    groups: root.groups.length,
    completedGroups: root.groups.filter((g) => g.status === "completed").length,
    pages: root.groups.reduce((sum, g) => sum + g.pageCount, 0),
    records: root.groups.reduce((sum, g) => sum + g.recordCount, 0),
  };
}

export async function reserveResultCheckpoint(task: CollectionTask, db: Prisma.TransactionClient) {
  const rootId = resultCheckpointRoot(task);
  await db.$queryRaw`SELECT "rootTaskId" FROM "ResultCheckpoint" WHERE "rootTaskId"=${rootId} FOR UPDATE`;
  const payload = task.payload as Record<string, unknown>;
  await db.$queryRaw`SELECT r.id FROM "EventSourceReference" r JOIN "Event" e ON e.id=r."eventId"
    WHERE r."sourceType"='openresults' AND r."sourceExternalId"=${String(payload.externalId)} FOR UPDATE OF r,e`;
  const checkpoint = await readResultCheckpoint(task, db);
  if (!checkpoint?.available) throw new TaskConflict(checkpoint?.reason ?? "result_checkpoint_unavailable");
  const reference = await db.eventSourceReference.findUnique({
    where: {
      sourceType_sourceExternalId: { sourceType: "openresults", sourceExternalId: String(payload.externalId) },
    },
  });
  if (
    !reference ||
    reference.eventId !== (await resolveEventId(String(payload.eventId), db)) ||
    reference.url !== payload.url
  )
    throw new TaskConflict("association_changed");
  return rootId;
}
