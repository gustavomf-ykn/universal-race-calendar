import { createHash } from "node:crypto";
import type { CatalogWeeklyOccurrence, CatalogWeeklySchedule, Prisma } from "@prisma/client";
import { inspectLocalResources } from "@race-calendar/utils";
import { prisma } from "./index.js";
import { assertCapacity, capacityGrowth, CapacityDeferred } from "./capacity.js";
import { enqueueTask, stableJson, TaskConflict } from "./tasks.js";
import { brazilianStateCodes } from "./publication-policy.js";
import { catalogCheckpoint } from "./catalog-continuation.js";
import { startCatalogReconciliation } from "./catalog-reconciliation.js";
import {
  catalogTimeZone,
  defaultWeeklySlot,
  coalesceWeeklyOccurrences,
  weeklyOccurrenceAfter,
} from "./catalog-weekly-clock.js";

const version = 1;
const sources = ["ticketsports", "corridasbr", "openresults"] as const;
const terminal = ["completed", "completed_with_review", "partial", "cancelled"];
const hash = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const lock = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('race_catalog_weekly',0))`;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const weeklyDefaults = {
  ...defaultWeeklySlot,
  recentDays: 90,
  historicalEveryWeeks: 4,
  batchSize: 5,
  snapshotLimit: 250,
  prefixLimit: 10000,
  states: [...brazilianStateCodes].sort(),
};
export type WeeklyConfiguration = typeof weeklyDefaults & {
  enabled: boolean;
  expectedRevision: number;
  reason: string;
};
function validate(input: WeeklyConfiguration) {
  if (
    typeof input.enabled !== "boolean" ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 3 ||
    input.reason.length > 500 ||
    !Array.isArray(input.states) ||
    input.states.length < 1 ||
    input.states.length > 27 ||
    new Set(input.states).size !== input.states.length ||
    input.states.some((s) => !brazilianStateCodes.includes(s))
  )
    throw new TaskConflict("weekly_configuration_invalid");
  for (const [name, min, max] of [
    ["recentDays", 1, 365],
    ["historicalEveryWeeks", 1, 52],
    ["batchSize", 1, 25],
    ["snapshotLimit", 5, 1000],
    ["prefixLimit", 25, 10000],
  ] as const)
    if (!Number.isInteger(input[name]) || input[name] < min || input[name] > max)
      throw new TaskConflict("weekly_configuration_invalid");
  try {
    weeklyOccurrenceAfter(new Date(), input);
  } catch {
    throw new TaskConflict("weekly_configuration_invalid");
  }
  return { ...input, states: [...input.states].sort(), reason: input.reason.trim() };
}
function publicSchedule(row: CatalogWeeklySchedule, now: Date) {
  return {
    enabled: row.enabled,
    revision: row.revision,
    coordinatorVersion: row.coordinatorVersion,
    timeZone: catalogTimeZone,
    weekday: row.weekday,
    hour: row.hour,
    minute: row.minute,
    options: row.revision === 0 ? weeklyDefaults : row.options,
    nextLocalDate: row.nextLocalDate,
    nextScheduledAt: row.nextScheduledAt,
    lastSuccessAt: row.lastSuccessAt,
    waitReason: row.waitReason,
    updatedAt: row.updatedAt,
    overdue: row.enabled && !!row.nextScheduledAt && row.nextScheduledAt <= now,
  };
}
export function publicWeeklyOccurrence(row: CatalogWeeklyOccurrence) {
  return {
    id: row.id,
    revision: row.revision,
    coordinatorVersion: row.coordinatorVersion,
    localDate: row.localDate,
    firstDueLocalDate: row.firstDueLocalDate,
    scheduledAt: row.scheduledAt,
    coalescedWeeks: row.coalescedWeeks,
    shiftedMinutes: row.shiftedMinutes,
    status: row.status,
    options: row.options,
    sourceSyncs: row.sourceSyncs,
    reconciliationId: row.reconciliationId,
    summary: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    // Lifecycle completion is not evidence of national coverage or fresh results.
    coverageVerified: false,
    resultsCollected: false,
  };
}
export async function readWeeklyCatalog(page = 1, limit = 10, now = new Date()) {
  const [row, total, runs, active] = await Promise.all([
    prisma.catalogWeeklySchedule.findUniqueOrThrow({ where: { id: 1 } }),
    prisma.catalogWeeklyOccurrence.count(),
    prisma.catalogWeeklyOccurrence.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.catalogWeeklyOccurrence.findFirst({ where: { status: { notIn: terminal } } }),
  ]);
  return {
    schedule: publicSchedule(row, now),
    serverTime: now,
    active: active ? publicWeeklyOccurrence(active) : null,
    data: runs.map(publicWeeklyOccurrence),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
export async function configureWeeklyCatalog(
  actorId: string,
  key: string,
  input: WeeklyConfiguration,
  now = new Date(),
) {
  const request = validate(input),
    requestHash = hash(request);
  if (!actorId || !key || key.length > 100) throw new TaskConflict("weekly_configuration_invalid");
  return prisma.$transaction(async (tx) => {
    await lock(tx);
    const prior = await tx.adminAudit.findFirst({
      where: { actorId, action: "weekly-configure", details: { path: ["idempotencyKey"], equals: key } },
    });
    if (prior) {
      const detail = prior.details as { requestHash: string; response: Prisma.JsonValue };
      if (detail.requestHash !== requestHash) throw new TaskConflict("idempotency_conflict");
      return detail.response;
    }
    const schedule = await tx.catalogWeeklySchedule.findUniqueOrThrow({ where: { id: 1 } });
    if (schedule.revision !== request.expectedRevision) throw new TaskConflict("weekly_revision_conflict");
    if (request.enabled) await assertCapacity(tx, capacityGrowth(request));
    const next = weeklyOccurrenceAfter(now, request);
    const { enabled, weekday, hour, minute, reason, expectedRevision, ...options } = request;
    const row = await tx.catalogWeeklySchedule.update({
      where: { id: 1 },
      data: {
        enabled,
        weekday,
        hour,
        minute,
        options,
        ownerId: actorId,
        coordinatorVersion: version,
        revision: expectedRevision + 1,
        nextLocalDate: next.localDate,
        nextScheduledAt: next.scheduledAt,
        waitReason: null,
        updatedAt: now,
      },
    });
    const response = json(publicSchedule(row, now));
    await tx.adminAudit.create({
      data: { actorId, action: "weekly-configure", details: { idempotencyKey: key, requestHash, reason, response } },
    });
    return response;
  });
}
function occurrenceOptions(first: string, last: string, input: Record<string, any>) {
  const week = (date: string) =>
    Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse("1970-01-05T00:00:00Z")) / (7 * 86400000));
  // Closed interval: an offline interval beginning on the historical week must
  // retain that sweep even if the most recent week is not historical itself.
  const historical =
    Math.ceil(week(first) / input.historicalEveryWeeks) <= Math.floor(week(last) / input.historicalEveryWeeks);
  return {
    ...input,
    historical,
    discoveryMode: "national",
    autoContinue: true,
    ...(!historical
      ? { from: new Date(Date.parse(`${last}T00:00:00Z`) - input.recentDays * 86400000).toISOString().slice(0, 10) }
      : {}),
  };
}
async function wait(tx: Prisma.TransactionClient, row: CatalogWeeklySchedule, reason: string | null) {
  if (row.waitReason !== reason)
    await tx.catalogWeeklySchedule.update({ where: { id: 1 }, data: { waitReason: reason, updatedAt: new Date() } });
  return { created: 0, reason };
}
async function observe(tx: Prisma.TransactionClient, run: CatalogWeeklyOccurrence, now: Date) {
  if (run.coordinatorVersion !== version)
    return { status: "blocked", summary: { reason: "weekly_schedule_version_incompatible" } };
  const syncs = run.sourceSyncs as Record<string, string>;
  if (sources.some((s) => typeof syncs[s] !== "string"))
    return { status: "blocked", summary: { reason: "weekly_source_missing" } };
  const rows = await tx.catalogSync.findMany({ where: { id: { in: Object.values(syncs) } } });
  if (rows.length !== 3) return { status: "blocked", summary: { reason: "weekly_source_missing" } };
  const ids = rows.map((r) => r.id);
  const stats = await tx.$queryRaw<
    Array<{ pending: number; held: number; failed: number; partial: number; cancelled: number }>
  >`
    WITH scoped AS (SELECT * FROM "CollectionTask" WHERE payload->>'syncId'=ANY(${ids}::text[])),
    leaves AS (SELECT t.* FROM scoped t WHERE NOT EXISTS(SELECT FROM scoped n WHERE n.payload->>'retryOf'=t.id)),
    latest AS (SELECT DISTINCT ON (source,kind,coalesce(payload->>'sourceId',payload->>'url','discovery')) * FROM leaves
      ORDER BY source,kind,coalesce(payload->>'sourceId',payload->>'url','discovery'),"createdAt" DESC,"updatedAt" DESC,id DESC)
    SELECT (SELECT count(*)::integer FROM scoped WHERE status IN ('queued','running')) AS pending,
      (SELECT count(*)::integer FROM scoped WHERE status='queued' AND "executionHold") AS held,
      count(*) FILTER(WHERE status='failed')::integer AS failed,
      count(*) FILTER(WHERE status='partial')::integer AS partial,
      count(*) FILTER(WHERE status='cancelled')::integer AS cancelled FROM latest`;
  const tasks = stats[0]!;
  const sourceSummary = rows.map((r) => ({
    source: r.source,
    syncId: r.id,
    status: r.status,
    coverage: r.coverage,
    discovered: r.discovered,
    processed: r.processed,
  }));
  const limitedSources = rows.filter((r) => r.status === "limited").map((r) => r.source);
  const summary: Record<string, any> = { sources: sourceSummary, tasks, limitedSources };
  if (rows.some((r) => !["completed", "limited"].includes(r.status)))
    return {
      status: rows.some((r) => ["blocked", "paused"].includes(r.status)) || tasks.held ? "blocked" : "discovery",
      summary,
    };
  if (tasks.pending) return { status: tasks.held ? "blocked" : "enrichment", summary };
  if (!run.reconciliationId) {
    const result = await startCatalogReconciliation(
      run.ownerId,
      hash(["weekly-reconcile", run.id]),
      "Cruzamento após atualização semanal",
      tx,
    );
    await tx.catalogWeeklyOccurrence.update({ where: { id: run.id }, data: { reconciliationId: result.run.id } });
    return { status: "reconciliation", summary };
  }
  const reconciliation = await tx.catalogReconciliation.findUnique({ where: { id: run.reconciliationId } });
  if (!reconciliation) return { status: "blocked", summary: { ...summary, reason: "weekly_reconciliation_missing" } };
  summary.reconciliation = {
    status: reconciliation.status,
    scanned: reconciliation.scannedCount,
    merged: reconciliation.mergedCount,
    review: reconciliation.reviewCount,
    unmatched: reconciliation.unmatchedCount,
  };
  // The run receipt is persisted before the worker acknowledges its queue task.
  // A terminal run alone cannot prove that the executor finished successfully.
  const reconciliationTasks = await tx.collectionTask.findMany({
    where: { kind: "catalog-reconcile", payload: { path: ["runId"], equals: run.reconciliationId } },
    select: { status: true, executionHold: true },
    orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
  });
  if (!reconciliationTasks.length)
    return { status: "blocked", summary: { ...summary, reason: "weekly_reconciliation_task_missing" } };
  const reconciliationPending = reconciliationTasks.some((t) => ["queued", "running"].includes(t.status));
  const reconciliationHeld = reconciliationTasks.some((t) => t.status === "queued" && t.executionHold);
  // A checkpoint resume creates a successor task; earlier failed receipts remain
  // in history but must not turn a successfully recovered cycle into a failure.
  const reconciliationFailed = ["failed", "partial", "cancelled"].includes(reconciliationTasks[0]!.status);
  summary.reconciliation.tasks = {
    pending: reconciliationPending,
    held: reconciliationHeld,
    failed: reconciliationFailed,
  };
  if (reconciliationPending) return { status: reconciliationHeld ? "blocked" : "reconciliation", summary };
  if (reconciliationFailed && !["completed", "completed_with_review", "cancelled"].includes(reconciliation.status))
    return { status: "blocked", summary: { ...summary, reason: "weekly_reconciliation_task_failed" } };
  if (!["completed", "completed_with_review", "cancelled"].includes(reconciliation.status))
    return { status: ["blocked", "paused"].includes(reconciliation.status) ? "blocked" : "reconciliation", summary };
  const partial =
    limitedSources.length ||
    tasks.failed ||
    tasks.partial ||
    tasks.cancelled ||
    reconciliationFailed ||
    reconciliation.status === "cancelled";
  const status = partial ? "partial" : reconciliation.reviewCount ? "completed_with_review" : "completed";
  if (!partial) await tx.catalogWeeklySchedule.update({ where: { id: 1 }, data: { lastSuccessAt: now } });
  return { status, summary };
}
/** Only the continuous local calendar worker calls this. No HTTP or results extraction. */
export async function coordinateWeeklyCatalog(now = new Date()) {
  if (process.env.WORKER_TASK_SELECTION_FILE || process.env.WORKER_MODE !== "continuous")
    return { created: 0, reason: "weekly_execution_mode_disabled" };
  const resources = inspectLocalResources();
  if (resources.reason) return { created: 0, reason: resources.reason };
  return prisma.$transaction(
    async (tx) => {
      await lock(tx);
      const schedule = await tx.catalogWeeklySchedule.findUniqueOrThrow({ where: { id: 1 } });
      const active = await tx.catalogWeeklyOccurrence.findFirst({ where: { status: { notIn: terminal } } });
      if (!schedule.enabled && !active) return wait(tx, schedule, null);
      if (schedule.coordinatorVersion !== version) return wait(tx, schedule, "weekly_schedule_version_incompatible");
      if (active) {
        let result;
        try {
          result = await observe(tx, active, now);
        } catch (error) {
          if (error instanceof TaskConflict || error instanceof CapacityDeferred)
            return wait(tx, schedule, error.message);
          throw error;
        }
        if (active.status !== result.status || stableJson(active.summary) !== stableJson(result.summary))
          await tx.catalogWeeklyOccurrence.update({
            where: { id: active.id },
            data: {
              status: result.status,
              summary: json(result.summary),
              updatedAt: now,
              ...(terminal.includes(result.status) ? { finishedAt: now } : {}),
            },
          });
        // Never begin another occurrence in the same poll as completing this one.
        return wait(tx, schedule, null);
      }
      if (!schedule.enabled || !schedule.nextLocalDate) return wait(tx, schedule, null);
      const due = coalesceWeeklyOccurrences(schedule.nextLocalDate, now, schedule);
      if (!due) return wait(tx, schedule, null);
      if (
        await tx.catalogSync.count({
          where: {
            source: { in: [...sources] },
            status: { notIn: ["completed", "limited", "cancelled"] },
            options: { path: ["discoveryMode"], equals: "national" },
          },
        })
      )
        return wait(tx, schedule, "weekly_scope_in_use");
      // Existing-cycle observation does not allocate new catalog data. Its
      // reconciliation starter performs its own capacity check after taking
      // the same start lock as the manual route. Holding the capacity row
      // before that lock would invert the manual route's order and deadlock.
      try {
        await assertCapacity(tx, 4 * 65536);
      } catch (error) {
        if (error instanceof CapacityDeferred) return wait(tx, schedule, error.reason);
        throw error;
      }
      const id = "weekly_" + hash([schedule.id, schedule.revision, due.localDate]).slice(0, 32);
      const options = occurrenceOptions(due.firstDueLocalDate, due.localDate, schedule.options as Record<string, any>);
      const syncs: Record<string, string> = {};
      for (const source of sources) {
        const syncId = hash([id, source]),
          key = hash(["weekly-discovery", id, source]);
        syncs[source] = syncId;
        const scope = { ...options, source };
        await tx.catalogSync.create({ data: { id: syncId, ownerId: schedule.ownerId, source, options: json(scope) } });
        await enqueueTask(
          schedule.ownerId,
          key,
          source,
          "catalog-sync",
          json({
            syncId,
            ...scope,
            weeklyOccurrenceId: id,
            checkpointHash: catalogCheckpoint({ page: 1, cursor: 0, snapshot: [] }),
          }),
          tx,
        );
      }
      await tx.catalogWeeklyOccurrence.create({
        data: {
          id,
          revision: schedule.revision,
          ownerId: schedule.ownerId,
          localDate: due.localDate,
          firstDueLocalDate: due.firstDueLocalDate,
          scheduledAt: due.scheduledAt,
          coalescedWeeks: due.coalescedWeeks,
          shiftedMinutes: due.shiftedMinutes,
          options: json(options),
          sourceSyncs: syncs,
        },
      });
      await tx.catalogWeeklySchedule.update({
        where: { id: 1 },
        data: {
          nextLocalDate: due.next.localDate,
          nextScheduledAt: due.next.scheduledAt,
          waitReason: null,
          updatedAt: now,
        },
      });
      await tx.adminAudit.create({
        data: {
          actorId: schedule.ownerId,
          action: "weekly-occurrence",
          details: {
            occurrenceId: id,
            revision: schedule.revision,
            localDate: due.localDate,
            firstDueLocalDate: due.firstDueLocalDate,
            coalescedWeeks: due.coalescedWeeks,
          },
        },
      });
      return { created: 1, reason: null, occurrenceId: id };
    },
    { timeout: 15000 },
  );
}

export async function cancelWeeklyOccurrence(actorId: string, key: string, id: string, reason: string) {
  if (
    !actorId ||
    !key ||
    key.length > 100 ||
    typeof reason !== "string" ||
    reason.trim().length < 3 ||
    reason.length > 500
  )
    throw new TaskConflict("weekly_configuration_invalid");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('race-task-acquisition'))`;
    await lock(tx);
    const run = await tx.catalogWeeklyOccurrence.findUnique({ where: { id } });
    if (!run) throw new TaskConflict("weekly_occurrence_not_found");
    const requestHash = hash({ id, reason: reason.trim() });
    const prior = await tx.adminAudit.findFirst({
      where: { actorId, action: "weekly-cancel", details: { path: ["idempotencyKey"], equals: key } },
    });
    if (prior) {
      const details = prior.details as { requestHash: string; response: Prisma.JsonValue };
      if (details.requestHash !== requestHash) throw new TaskConflict("idempotency_conflict");
      return details.response;
    }
    if (terminal.includes(run.status)) throw new TaskConflict("weekly_occurrence_finished");
    const syncIds = Object.values(run.sourceSyncs as Record<string, string>);
    await tx.$queryRaw`SELECT id FROM "CatalogSync" WHERE id=ANY(${syncIds}::text[]) ORDER BY id FOR UPDATE`;
    if (run.reconciliationId)
      await tx.$queryRaw`SELECT id FROM "CatalogReconciliation" WHERE id=${run.reconciliationId} FOR UPDATE`;
    // Prisma JSON filters cannot express membership of a string across paths.
    const relevant = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id,status FROM "CollectionTask"
      WHERE payload->>'syncId'=ANY(${syncIds}::text[]) OR (${run.reconciliationId}::text IS NOT NULL AND payload->>'runId'=${run.reconciliationId})`;
    if (relevant.some((t) => t.status === "running")) throw new TaskConflict("weekly_occurrence_in_use");
    await tx.collectionTask.updateMany({
      where: { id: { in: relevant.map((t) => t.id) }, status: "queued" },
      data: { status: "cancelled", finishedAt: new Date(), updatedAt: new Date() },
    });
    for (const syncId of syncIds) {
      const sync = await tx.catalogSync.findUnique({ where: { id: syncId } });
      if (sync)
        await tx.catalogSync.update({
          where: { id: syncId },
          data: {
            ...(!["completed", "limited"].includes(sync.status) ? { status: "cancelled" } : {}),
            options: json({
              ...(sync.options as object),
              autoContinue: false,
              pauseRequested: true,
              weeklyCancelled: true,
            }),
            updatedAt: new Date(),
          },
        });
    }
    if (run.reconciliationId)
      await tx.catalogReconciliation.updateMany({
        where: { id: run.reconciliationId, status: { notIn: ["completed", "completed_with_review", "cancelled"] } },
        data: {
          status: "cancelled",
          pauseRequested: true,
          activeTaskId: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    const row = await tx.catalogWeeklyOccurrence.update({
      where: { id },
      data: { status: "cancelled", finishedAt: new Date(), updatedAt: new Date() },
    });
    const response = json(publicWeeklyOccurrence(row));
    await tx.adminAudit.create({
      data: {
        actorId,
        action: "weekly-cancel",
        details: { idempotencyKey: key, requestHash, reason: reason.trim(), response },
      },
    });
    return response;
  });
}
