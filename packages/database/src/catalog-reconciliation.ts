import { createHash } from "node:crypto";
import type { CatalogReconciliation, CollectionTask, Prisma } from "@prisma/client";
import { prisma } from "./index.js";
import { assertTaskLease } from "./lease.js";
import { assertCapacity, CapacityDeferred } from "./capacity.js";
import { enqueueTask, TaskConflict } from "./tasks.js";
import { editionLinks, editionUrlVariants } from "./edition-evidence.js";
import { reconcileCatalogGroup, ReconciliationConflict } from "./event-reconciliation.js";

const version = 1;
const sources = ["ticketsports", "corridasbr", "openresults"];
const terminal = (run: CatalogReconciliation) =>
  ["completed", "completed_with_review", "cancelled"].includes(run.status);
const taskWhere = (id: string) => ({ kind: "catalog-reconcile", payload: { path: ["runId"], equals: id } });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function startCatalogReconciliation(ownerId: string, key: string, reason: string) {
  if (!ownerId || !key || key.length > 128 || reason.trim().length < 3 || reason.length > 500)
    throw new TaskConflict("reconciliation_request_invalid");
  const id = "reconcile_" + hash(JSON.stringify([ownerId, key])).slice(0, 32);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('race_catalog_reconciliation_start',0))`;
    const previous = await tx.catalogReconciliation.findUnique({ where: { id } });
    if (!previous) {
      if (
        await tx.catalogReconciliation.count({
          where: { status: { notIn: ["completed", "completed_with_review", "cancelled"] } },
        })
      )
        throw new TaskConflict("catalog_reconciliation_active");
      await assertCapacity(tx);
    }
    const task = await enqueueTask(
      ownerId,
      key,
      "maintenance",
      "catalog-reconcile",
      { runId: id, parserVersion: version, checkpointSequence: 0, reason },
      tx,
    );
    const run = await tx.catalogReconciliation.upsert({
      where: { id },
      update: {},
      create: {
        id,
        ownerId,
        rootTaskId: task.id,
        snapshotAt: task.createdAt,
      },
    });
    if (!previous)
      await tx.adminAudit.create({
        data: {
          actorId: ownerId,
          action: "catalog_reconciliation_start",
          taskId: task.id,
          details: { runId: id, reason, idempotencyKey: key },
        },
      });
    return { run: publicCatalogReconciliation(run), taskId: task.id };
  });
}
export function publicCatalogReconciliation(run: CatalogReconciliation) {
  return {
    id: run.id,
    rootTaskId: run.rootTaskId,
    status: run.status,
    parserVersion: run.parserVersion,
    snapshotAt: run.snapshotAt,
    pauseRequested: run.pauseRequested,
    scannedCount: run.scannedCount,
    mergedCount: run.mergedCount,
    reviewCount: run.reviewCount,
    unmatchedCount: run.unmatchedCount,
    foreignCount: run.foreignCount,
    nextAttemptAt: run.nextAttemptAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

// Collect the connected component of recognized edition links. More than three
// nodes is unresolved ambiguity, not a reason to choose the first three.
async function groupFor(tx: Prisma.TransactionClient, firstId: string, snapshotAt: Date) {
  const ids = new Set([firstId]);
  const pending = [firstId];
  let weak: string[] = [];
  while (pending.length) {
    const event = await tx.event.findUniqueOrThrow({
      where: { id: pending.shift()! },
      include: { sourceReferences: true },
    });
    const links = [
      ...editionLinks(event),
      ...event.sourceReferences.flatMap((ref) => editionLinks({ sourceUrl: ref.url })),
    ];
    const urls = [...new Set(links.flatMap(editionUrlVariants))];
    const ticketIds = [
      ...new Set(links.filter((link) => link.source === "ticketsports").map((link) => link.externalId)),
    ];
    if (urls.length || ticketIds.length) {
      const matches = await tx.event.findMany({
        where: {
          id: { notIn: [...ids] },
          createdAt: { lte: snapshotAt },
          OR: [
            { sourceType: "ticketsports", sourceExternalId: { in: ticketIds } },
            { sourceReferences: { some: { sourceType: "ticketsports", sourceExternalId: { in: ticketIds } } } },
            { sourceUrl: { in: urls } },
            { registrationUrl: { in: urls } },
            { officialUrl: { in: urls } },
            { sourceReferences: { some: { url: { in: urls } } } },
          ],
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 4,
      });
      for (const match of matches)
        if (!ids.has(match.id)) {
          ids.add(match.id);
          pending.push(match.id);
        }
      if (ids.size > 3) return { ids: [...ids], reason: "edition_link_ambiguous", weak };
    }
    if (ids.size === 1) {
      const generic = [event.registrationUrl, event.officialUrl].filter((value): value is string => Boolean(value));
      const matches = await tx.event.findMany({
        where: {
          id: { not: firstId },
          createdAt: { lte: snapshotAt },
          date: event.date,
          OR: [
            ...(event.canonicalFingerprint ? [{ canonicalFingerprint: event.canonicalFingerprint }] : []),
            { registrationUrl: { in: generic } },
            { officialUrl: { in: generic } },
          ],
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 4,
      });
      weak = matches.map((row) => row.id);
    }
  }
  return { ids: [...ids], reason: null, weak };
}

async function step(task: CollectionTask) {
  return prisma.$transaction(
    async (tx) => {
      // Acquisition locks the task row before its trigger takes the shared gate.
      // Fence the same row first, so recovery cannot hold it while we wait for the gate.
      const fenced = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CollectionTask"
      WHERE id=${task.id} AND status='running' AND "leaseToken"=${task.leaseToken}
        AND "leaseUntil">now() FOR UPDATE`;
      if (!fenced.length) throw Error("lease_lost");
      await assertTaskLease(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('race_event_reconciliation',0))`;
      const input = task.payload as { runId: string; parserVersion: number; checkpointSequence: number };
      if (!input || typeof input.runId !== "string" || !Number.isInteger(input.checkpointSequence))
        throw Error("catalog_reconciliation_request_invalid");
      await tx.$queryRaw`SELECT id FROM "CatalogReconciliation" WHERE id=${input.runId} FOR UPDATE`;
      const run = await tx.catalogReconciliation.findUniqueOrThrow({ where: { id: input.runId } });
      if (task.ownerId !== run.ownerId) throw Error("catalog_reconciliation_request_invalid");
      if (run.parserVersion !== version || input.parserVersion !== version)
        throw Error("catalog_reconciliation_checkpoint_incompatible");
      if (run.activeTaskId !== task.id && run.sequence !== input.checkpointSequence)
        throw Error("catalog_reconciliation_checkpoint_stale");
      if (terminal(run) || run.status === "paused" || run.status === "blocked") return run;
      if (run.pauseRequested)
        return tx.catalogReconciliation.update({
          where: { id: run.id },
          data: { status: "paused", updatedAt: new Date() },
        });
      const event = await tx.event.findFirst({
        where: {
          createdAt: { lte: run.snapshotAt },
          AND: [
            { OR: [{ sourceType: { in: sources } }, { sourceReferences: { some: { sourceType: { in: sources } } } }] },
            ...(run.cursorCreatedAt
              ? [
                  {
                    OR: [
                      { createdAt: { gt: run.cursorCreatedAt } },
                      { createdAt: run.cursorCreatedAt, id: { gt: run.cursorEventId! } },
                    ],
                  },
                ]
              : []),
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (!event)
        return tx.catalogReconciliation.update({
          where: { id: run.id },
          data: {
            status: run.reviewCount ? "completed_with_review" : "completed",
            finishedAt: new Date(),
            updatedAt: new Date(),
            activeTaskId: task.id,
          },
        });
      let status: "merged" | "review" | "unmatched" | "foreign" | "waiting" = "unmatched";
      let reason: string | null = null;
      let details: Prisma.InputJsonValue = {};
      let merged = 0;
      if (event.country && event.country !== "BR") status = "foreign";
      else {
        const group = await groupFor(tx, event.id, run.snapshotAt);
        if (group.reason) {
          status = "review";
          reason = group.reason;
          details = { eventIds: group.ids };
        } else if (group.ids.length > 1) {
          // SAVEPOINT ensures a rejected group never leaves a partially unified group.
          await tx.$executeRawUnsafe("SAVEPOINT reconciliation_group");
          try {
            const result = await reconcileCatalogGroup(tx, run.ownerId, `${run.id}:${event.id}`, group.ids);
            status = "merged";
            merged = result.merged.length;
            details = {
              eventIds: group.ids,
              targetId: result.eventId,
              auditIds: result.merged.map((row) => row.auditId),
            };
            await tx.$executeRawUnsafe("RELEASE SAVEPOINT reconciliation_group");
          } catch (error) {
            if (!(error instanceof ReconciliationConflict)) throw error;
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT reconciliation_group");
            await tx.$executeRawUnsafe("RELEASE SAVEPOINT reconciliation_group");
            status =
              error.message === "edition_reconciliation_in_use" || error.message === "reconciliation_preview_stale"
                ? "waiting"
                : "review";
            reason = error.message;
            details = { eventIds: group.ids };
          }
        } else if (group.weak.length) {
          status = "review";
          reason = "edition_link_unconfirmed";
          details = { eventIds: [event.id, ...group.weak] };
        } else if (!event.country || !event.date || !event.city || !event.state) {
          status = "review";
          reason = "edition_location_unconfirmed";
        }
      }
      await tx.catalogReconciliationDecision.upsert({
        where: { runId_eventId: { runId: run.id, eventId: event.id } },
        create: { runId: run.id, eventId: event.id, status, reason, details },
        update: { status, reason, details },
      });
      const updated = await tx.catalogReconciliation.update({
        where: { id: run.id },
        data: {
          activeTaskId: task.id,
          sequence: { increment: 1 },
          status: status === "waiting" ? "waiting" : "ready",
          nextAttemptAt: new Date(Date.now() + (status === "waiting" ? 30000 : 0)),
          updatedAt: new Date(),
          ...(status === "waiting"
            ? {}
            : {
                cursorCreatedAt: event.createdAt,
                cursorEventId: event.id,
                scannedCount: { increment: 1 },
                mergedCount: { increment: merged },
                reviewCount: { increment: status === "review" ? 1 : 0 },
                unmatchedCount: { increment: status === "unmatched" ? 1 : 0 },
                foreignCount: { increment: status === "foreign" ? 1 : 0 },
              }),
        },
      });
      return updated;
    },
    { timeout: 30000 },
  );
}

export async function processCatalogReconciliation(task: CollectionTask, limit = 10) {
  if (
    task.kind !== "catalog-reconcile" ||
    task.source !== "maintenance" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 25
  )
    throw Error("catalog_reconciliation_request_invalid");
  let run: CatalogReconciliation | undefined;
  for (let count = 0; count < limit; count++) {
    run = await step(task);
    if (run.status !== "ready") break;
  }
  return {
    runId: run!.id,
    stage: run!.status === "ready" ? "reconciliation_continuation" : run!.status,
    scanned: run!.scannedCount,
    merged: run!.mergedCount,
    review: run!.reviewCount,
    unmatched: run!.unmatchedCount,
    foreign: run!.foreignCount,
  };
}

export async function coordinateCatalogReconciliations(limit = 10) {
  const runs = await prisma.catalogReconciliation.findMany({
    where: {
      status: { in: ["ready", "waiting"] },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let queued = 0;
  for (const { id } of runs)
    queued += await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "CatalogReconciliation" WHERE id=${id} FOR UPDATE`;
      const run = await tx.catalogReconciliation.findUniqueOrThrow({ where: { id } });
      const where = taskWhere(id);
      if (
        !["ready", "waiting"].includes(run.status) ||
        run.nextAttemptAt > new Date() ||
        (await tx.collectionTask.count({ where: { ...where, status: { in: ["queued", "running"] } } }))
      )
        return 0;
      if (run.pauseRequested) {
        await tx.catalogReconciliation.update({ where: { id }, data: { status: "paused", updatedAt: new Date() } });
        return 0;
      }
      const last = await tx.collectionTask.findFirst({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
      if (!last || last.executionHold || last.status !== "completed") {
        await tx.catalogReconciliation.update({ where: { id }, data: { status: "blocked", updatedAt: new Date() } });
        return 0;
      }
      try {
        await assertCapacity(tx);
      } catch (error) {
        if (error instanceof CapacityDeferred) return 0;
        throw error;
      }
      await enqueueTask(
        run.ownerId,
        hash(`catalog-reconcile:${id}:${run.sequence}`),
        "maintenance",
        "catalog-reconcile",
        { runId: id, parserVersion: version, checkpointSequence: run.sequence },
        tx,
      );
      return 1;
    });
  return queued;
}

export async function controlCatalogReconciliation(
  actorId: string,
  key: string,
  id: string,
  action: "pause" | "resume" | "cancel",
) {
  if (!actorId || !key || key.length > 128 || !["pause", "resume", "cancel"].includes(action))
    throw new TaskConflict("reconciliation_request_invalid");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "CatalogReconciliation" WHERE id=${id} FOR UPDATE`;
    const run = await tx.catalogReconciliation.findUnique({ where: { id } });
    if (!run) throw new TaskConflict("reconciliation_run_not_found");
    const previous = await tx.adminAudit.findFirst({
      where: { actorId, action: "catalog_reconciliation_control", details: { path: ["idempotencyKey"], equals: key } },
    });
    if (previous) {
      const details = previous.details as { runId: string; action: string };
      if (details.runId !== id || details.action !== action) throw new TaskConflict("idempotency_conflict");
      return publicCatalogReconciliation(run);
    }
    if (terminal(run)) throw new TaskConflict("reconciliation_scope_completed");
    if (action !== "cancel" && run.parserVersion !== version)
      throw new TaskConflict("catalog_reconciliation_checkpoint_incompatible");
    const where = taskWhere(id);
    if (action === "cancel") {
      if (await tx.collectionTask.count({ where: { ...where, status: "running" } }))
        throw new TaskConflict("catalog_reconciliation_in_use");
      await tx.collectionTask.updateMany({
        where: { ...where, status: "queued" },
        data: {
          status: "cancelled",
          finishedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    } else if (action === "pause")
      await tx.collectionTask.updateMany({
        where: { ...where, status: "queued", executionHold: false },
        data: { executionHold: true, holdReason: "catalog_reconciliation_paused", updatedAt: new Date() },
      });
    else {
      await assertCapacity(tx);
      await tx.collectionTask.updateMany({
        where: { ...where, status: "queued", holdReason: "catalog_reconciliation_paused" },
        data: { executionHold: false, holdReason: null, updatedAt: new Date() },
      });
      if (!(await tx.collectionTask.count({ where: { ...where, status: { in: ["queued", "running"] } } })))
        await enqueueTask(
          run.ownerId,
          hash(JSON.stringify(["reconcile-resume", actorId, key])),
          "maintenance",
          "catalog-reconcile",
          { runId: id, parserVersion: version, checkpointSequence: run.sequence },
          tx,
        );
    }
    const running = await tx.collectionTask.count({ where: { ...where, status: "running" } });
    const updated = await tx.catalogReconciliation.update({
      where: { id },
      data: {
        pauseRequested: action === "pause",
        status: action === "cancel" ? "cancelled" : action === "pause" && !running ? "paused" : "ready",
        ...(action === "cancel" ? { finishedAt: new Date() } : {}),
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await tx.adminAudit.create({
      data: { actorId, action: "catalog_reconciliation_control", details: { idempotencyKey: key, runId: id, action } },
    });
    return publicCatalogReconciliation(updated);
  });
}
