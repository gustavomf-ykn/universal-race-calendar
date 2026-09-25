import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./index.js";
import type { Prisma, CollectionTask } from "@prisma/client";

export class TaskConflict extends Error {}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function enqueueTask(
  ownerId: string,
  idempotencyKey: string,
  source: string,
  kind: string,
  payload: Prisma.InputJsonValue,
  db: Prisma.TransactionClient = prisma,
) {
  const requestHash = createHash("sha256").update(stableJson({ source, kind, payload })).digest("hex");
  const task = await db.collectionTask.upsert({
    where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
    create: { ownerId, idempotencyKey, source, kind, payload, requestHash },
    update: {},
  });
  if (task.requestHash !== requestHash) throw new TaskConflict("idempotency_conflict");
  return task;
}
export function selectedTaskIds(): string[] | null {
  const file = process.env.WORKER_TASK_SELECTION_FILE;
  if (!file) return null;
  try {
    const ids: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string" || !id || id.length > 100))
      throw Error();
    return ids;
  } catch {
    throw new Error("task_selection_invalid");
  }
}
export async function claimTask(sources: string[]) {
  const token = randomUUID();
  const selected = selectedTaskIds();
  const rows =
    selected === null
      ? await prisma.$queryRaw<CollectionTask[]>`SELECT * FROM claim_task(${sources}::text[],${token})`
      : await prisma.$queryRaw<
          CollectionTask[]
        >`SELECT * FROM claim_selected_task(${sources}::text[],${token},${selected}::text[])`;
  return rows[0] ?? null;
}
export async function heartbeatTask(task: CollectionTask, progress: Prisma.InputJsonValue) {
  const rows = await prisma.$queryRaw<
    Array<{ ok: boolean }>
  >`SELECT heartbeat_task(${task.id},${task.leaseToken},${JSON.stringify(progress)}::jsonb) AS ok`;
  return rows[0]?.ok === true;
}
export async function finishTask(
  task: CollectionTask,
  status: string,
  progress: Prisma.InputJsonValue,
  error: string | null = null,
) {
  const rows = await prisma.$queryRaw<
    Array<{ ok: boolean }>
  >`SELECT finish_task(${task.id},${task.leaseToken},${status},${JSON.stringify(progress)}::jsonb,${error}) AS ok`;
  return rows[0]?.ok === true;
}
export function publicTask(task: CollectionTask) {
  return {
    id: task.id,
    source: task.source,
    kind: task.kind,
    status: task.status,
    executionHold: task.executionHold,
    holdReason: task.holdReason,
    progress: task.progress,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    errorCode: task.errorCode,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
  };
}
