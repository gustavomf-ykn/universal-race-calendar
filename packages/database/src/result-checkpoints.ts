import type { CollectionTask, Prisma } from "@prisma/client";
import { prisma } from "./index.js";
import { TaskConflict } from "./tasks.js";

export const resultParserVersion = 1;

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
    root.eventId !== payload.eventId ||
    root.externalId !== payload.externalId ||
    root.sourceUrl !== payload.url
  )
    reason = "result_checkpoint_incompatible";
  else if (root.expiresAt <= new Date() || root.status === "expired") reason = "result_checkpoint_expired";
  else if (!["collecting", "ready"].includes(root.status)) reason = "result_checkpoint_unavailable";
  else if (root.activeTask && ["queued", "running"].includes(root.activeTask.status))
    reason = "result_checkpoint_in_use";
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
  const checkpoint = await readResultCheckpoint(task, db);
  if (!checkpoint?.available) throw new TaskConflict(checkpoint?.reason ?? "result_checkpoint_unavailable");
  const payload = task.payload as Record<string, unknown>;
  const reference = await db.eventSourceReference.findUnique({
    where: {
      sourceType_sourceExternalId: { sourceType: "openresults", sourceExternalId: String(payload.externalId) },
    },
  });
  if (!reference || reference.eventId !== payload.eventId || reference.url !== payload.url)
    throw new TaskConflict("association_changed");
  return rootId;
}
