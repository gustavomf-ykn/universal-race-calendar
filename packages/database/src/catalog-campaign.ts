import { createHash } from "node:crypto";
import type { CatalogCampaign, Prisma } from "@prisma/client";
import { prisma } from "./index.js";
import { assertCapacity, CapacityDeferred } from "./capacity.js";
import { enqueueTask, stableJson, TaskConflict } from "./tasks.js";
import { brazilianStateCodes } from "./publication-policy.js";
import { catalogCheckpoint } from "./catalog-continuation.js";
import { observeCatalogCycle } from "./catalog-weekly.js";
import { inspectLocalResources } from "@race-calendar/utils";

export const campaignDefaults = { states: [...brazilianStateCodes].sort(), batchSize: 25, prefixLimit: 10000 };
export type CampaignInput = { reason: string; states?: string[]; batchSize?: number; prefixLimit?: number };
const sources = ["ticketsports", "corridasbr", "openresults"];
const terminal = ["completed", "completed_with_review", "partial", "cancelled"];
const digest = (v: unknown) => createHash("sha256").update(stableJson(v)).digest("hex");
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
// Shared with weekly creation: a manual and scheduled campaign cannot start concurrently.
const lock = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('race_catalog_campaign',0))`;
export function publicCampaign(r: CatalogCampaign) {
  return {
    id: r.id,
    status: r.status,
    pauseRequested: r.pauseRequested,
    options: r.options,
    sourceSyncs: r.sourceSyncs,
    reconciliationId: r.reconciliationId,
    summary: r.summary,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt,
    coverageVerified: false,
    resultsCollected: false,
  };
}
export async function startCatalogCampaign(actorId: string, key: string, input: CampaignInput) {
  const states = input.states ?? campaignDefaults.states;
  const batchSize = input.batchSize ?? campaignDefaults.batchSize,
    prefixLimit = input.prefixLimit ?? campaignDefaults.prefixLimit;
  if (
    !actorId ||
    !key ||
    key.length > 100 ||
    typeof input.reason !== "string" ||
    input.reason.trim().length < 3 ||
    input.reason.length > 500 ||
    !Array.isArray(states) ||
    !states.length ||
    states.length > 27 ||
    new Set(states).size !== states.length ||
    states.some((s) => !(brazilianStateCodes as readonly string[]).includes(s)) ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 25 ||
    !Number.isInteger(prefixLimit) ||
    prefixLimit < 25 ||
    prefixLimit > 10000
  )
    throw new TaskConflict("campaign_request_invalid");
  const request = { reason: input.reason.trim(), states: [...states].sort(), batchSize, prefixLimit };
  const id = "campaign_" + digest([actorId, key]).slice(0, 32),
    requestHash = digest(request);
  return prisma.$transaction(
    async (tx) => {
      await lock(tx);
      const prior = await tx.catalogCampaign.findUnique({ where: { id } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new TaskConflict("idempotency_conflict");
        return publicCampaign(prior);
      }
      if (await tx.catalogCampaign.count({ where: { status: { notIn: terminal } } }))
        throw new TaskConflict("campaign_active");
      if (await tx.catalogWeeklyOccurrence.count({ where: { status: { notIn: terminal } } }))
        throw new TaskConflict("campaign_scope_in_use");
      await assertCapacity(tx, 4 * 65536);
      const options = { ...request, discoveryMode: "national", autoContinue: true, snapshotLimit: 250 };
      const sourceSyncs: Record<string, string> = {};
      for (const source of sources) {
        const syncId = digest([id, source]);
        sourceSyncs[source] = syncId;
        const sync = await tx.catalogSync.create({
          data: { id: syncId, source, ownerId: actorId, countsAvailable: true, options: json({ ...options, source }) },
        });
        await enqueueTask(
          actorId,
          digest(["campaign", id, source]),
          source,
          "catalog-sync",
          json({ ...options, source, syncId, campaignId: id, checkpointHash: catalogCheckpoint(sync) }),
          tx,
        );
      }
      const run = await tx.catalogCampaign.create({
        data: { id, ownerId: actorId, requestHash, options: json(options), sourceSyncs },
      });
      await tx.adminAudit.create({
        data: { actorId, action: "catalog_campaign_start", details: { campaignId: id, reason: request.reason } },
      });
      return publicCampaign(run);
    },
    { timeout: 15000 },
  );
}
export async function readCatalogCampaigns(page = 1, limit = 10) {
  const [total, data, active] = await Promise.all([
    prisma.catalogCampaign.count(),
    prisma.catalogCampaign.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.catalogCampaign.findFirst({ where: { status: { notIn: terminal } } }),
  ]);
  return {
    data: data.map(publicCampaign),
    active: active ? publicCampaign(active) : null,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
export async function getCatalogCampaign(id: string) {
  const row = await prisma.catalogCampaign.findUnique({ where: { id } });
  if (!row) throw new TaskConflict("campaign_not_found");
  return publicCampaign(row);
}
function compatible(source: string, snapshot: Prisma.JsonValue) {
  if (Array.isArray(snapshot) && snapshot.length === 0) return true;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const version =
    source === "ticketsports" ? "nationalVersion" : source === "corridasbr" ? "corridasVersion" : "openresultsVersion";
  return snapshot[version] === 2;
}
export async function controlCatalogCampaign(
  actorId: string,
  key: string,
  id: string,
  action: "pause" | "resume" | "cancel",
  reason: string,
) {
  if (
    !actorId ||
    !key ||
    key.length > 100 ||
    !["pause", "resume", "cancel"].includes(action) ||
    typeof reason !== "string" ||
    reason.trim().length < 3 ||
    reason.length > 500
  )
    throw new TaskConflict("campaign_request_invalid");
  return prisma.$transaction(
    async (tx) => {
      await lock(tx);
      const prior = await tx.adminAudit.findFirst({
        where: { actorId, action: "catalog_campaign_control", details: { path: ["idempotencyKey"], equals: key } },
      });
      const requestHash = digest({ id, action, reason: reason.trim() });
      if (prior) {
        const d = prior.details as { requestHash: string; response: Prisma.JsonValue };
        if (d.requestHash !== requestHash) throw new TaskConflict("idempotency_conflict");
        return d.response;
      }
      await tx.$queryRaw`SELECT id FROM "CatalogCampaign" WHERE id=${id} FOR UPDATE`;
      const run = await tx.catalogCampaign.findUnique({ where: { id } });
      if (!run) throw new TaskConflict("campaign_not_found");
      const retryPartial = run.status === "partial" && action === "resume";
      if (terminal.includes(run.status) && !retryPartial) throw new TaskConflict("campaign_finished");
      if (retryPartial && (await tx.catalogCampaign.count({ where: { id: { not: id }, status: { notIn: terminal } } })))
        throw new TaskConflict("campaign_active");
      const ids = Object.values(run.sourceSyncs as Record<string, string>);
      // Capacity before the acquisition gate, matching candidate insertion order.
      if (action === "resume") await assertCapacity(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('race-task-acquisition'))`;
      await tx.$queryRaw`SELECT id FROM "CatalogSync" WHERE id=ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
      const tasks = await tx.$queryRaw<
        Array<{ id: string; status: string; executionHold: boolean; holdReason: string | null }>
      >`
   SELECT id,status,"executionHold","holdReason" FROM "CollectionTask"
   WHERE payload->>'syncId'=ANY(${ids}::text[]) OR (${run.reconciliationId}::text IS NOT NULL AND payload->>'runId'=${run.reconciliationId})`;
      if (action === "cancel" && tasks.some((t) => t.status === "running")) throw new TaskConflict("campaign_in_use");
      const scoped = { id: { in: tasks.map((t) => t.id) }, status: "queued" };
      if (action === "pause")
        await tx.collectionTask.updateMany({
          where: { ...scoped, executionHold: false },
          data: { executionHold: true, holdReason: "catalog_campaign_paused", updatedAt: new Date() },
        });
      if (action === "cancel")
        await tx.collectionTask.updateMany({
          where: scoped,
          data: { status: "cancelled", finishedAt: new Date(), updatedAt: new Date() },
        });
      const syncs = await tx.catalogSync.findMany({ where: { id: { in: ids } } });
      if (retryPartial && syncs.some((s) => s.status === "limited"))
        throw new TaskConflict("campaign_limited_new_scope_required");
      if (retryPartial) {
        const failed = await tx.$queryRaw<
          Array<{ id: string; source: string; kind: string; payload: Prisma.JsonValue }>
        >`
    SELECT t.id,t.source,t.kind,t.payload FROM "CollectionTask" t
    WHERE t.payload->>'syncId'=ANY(${ids}::text[]) AND t.kind IN ('inspect','check-source') AND t.status IN ('failed','partial')
     AND NOT EXISTS(SELECT FROM "CollectionTask" n WHERE n.payload->>'retryOf'=t.id)`;
        for (const task of failed)
          await enqueueTask(
            run.ownerId,
            digest(["campaign-metadata-retry", id, key, task.id]),
            task.source,
            task.kind,
            json({ ...(task.payload as object), retryOf: task.id, retryMode: "restart" }),
            tx,
          );
      }
      if (action === "resume" && syncs.some((s) => !compatible(s.source, s.snapshot)))
        throw new TaskConflict("catalog_checkpoint_incompatible");
      if (action === "resume")
        await tx.collectionTask.updateMany({
          where: { ...scoped, executionHold: true, holdReason: "catalog_campaign_paused" },
          data: { executionHold: false, holdReason: null, updatedAt: new Date() },
        });
      for (const sync of syncs) {
        const options = sync.options as Record<string, Prisma.JsonValue>;
        if (["completed", "limited"].includes(sync.status) && action !== "cancel") continue;
        const running = await tx.collectionTask.count({
          where: { kind: "catalog-sync", status: "running", payload: { path: ["syncId"], equals: sync.id } },
        });
        const updated = await tx.catalogSync.update({
          where: { id: sync.id },
          data: {
            options: json({
              ...options,
              pauseRequested: action === "pause",
              ...(action === "cancel" ? { weeklyCancelled: true } : {}),
            }),
            status:
              action === "cancel"
                ? "cancelled"
                : action === "pause" && !running
                  ? "paused"
                  : action === "resume"
                    ? "ready"
                    : sync.status,
            updatedAt: new Date(),
          },
        });
        if (
          action === "resume" &&
          !(await tx.collectionTask.count({
            where: {
              kind: "catalog-sync",
              status: { in: ["queued", "running"] },
              payload: { path: ["syncId"], equals: sync.id },
            },
          }))
        ) {
          const old = await tx.collectionTask.findFirst({
            where: { kind: "catalog-sync", payload: { path: ["syncId"], equals: sync.id } },
            orderBy: { createdAt: "desc" },
          });
          await enqueueTask(
            run.ownerId,
            digest(["campaign-resume", id, key, sync.id]),
            sync.source,
            "catalog-sync",
            json({
              ...options,
              pauseRequested: false,
              syncId: sync.id,
              campaignId: id,
              checkpointHash: catalogCheckpoint(updated),
              ...(old ? { retryOf: old.id, retryMode: "resume" } : {}),
            }),
            tx,
          );
        }
      }
      if (run.reconciliationId && !retryPartial) {
        await tx.$queryRaw`SELECT id FROM "CatalogReconciliation" WHERE id=${run.reconciliationId} FOR UPDATE`;
        const rec = await tx.catalogReconciliation.findUnique({ where: { id: run.reconciliationId } });
        if (rec && !["completed", "completed_with_review", "cancelled"].includes(rec.status)) {
          if (action === "resume" && rec.parserVersion !== 1)
            throw new TaskConflict("catalog_reconciliation_checkpoint_incompatible");
          await tx.catalogReconciliation.update({
            where: { id: rec.id },
            data: {
              pauseRequested: action === "pause",
              status: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "ready",
              nextAttemptAt: new Date(),
              updatedAt: new Date(),
              ...(action === "cancel" ? { finishedAt: new Date() } : {}),
            },
          });
          if (action === "resume") {
            const pending = await tx.collectionTask.count({
              where: {
                kind: "catalog-reconcile",
                status: { in: ["queued", "running"] },
                payload: { path: ["runId"], equals: rec.id },
              },
            });
            if (!pending)
              await enqueueTask(
                run.ownerId,
                digest(["campaign-reconcile-resume", id, key]),
                "maintenance",
                "catalog-reconcile",
                { runId: rec.id, parserVersion: rec.parserVersion, checkpointSequence: rec.sequence },
                tx,
              );
          }
        }
      }
      const updated = await tx.catalogCampaign.update({
        where: { id },
        data: {
          pauseRequested: action === "pause",
          status: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "discovery",
          updatedAt: new Date(),
          ...(retryPartial
            ? {
                finishedAt: null,
                reconciliationId: null,
                options: json({ ...(run.options as object), reconciliationEpoch: digest([id, key]) }),
              }
            : {}),
          ...(action === "cancel" ? { finishedAt: new Date() } : {}),
        },
      });
      const response = json(publicCampaign(updated));
      await tx.adminAudit.create({
        data: {
          actorId,
          action: "catalog_campaign_control",
          details: {
            idempotencyKey: key,
            requestHash,
            reason: reason.trim(),
            response,
            ...(retryPartial ? { previousReconciliationId: run.reconciliationId } : {}),
          },
        },
      });
      return response;
    },
    { timeout: 15000 },
  );
}
async function editionCounts(tx: Prisma.TransactionClient, run: CatalogCampaign) {
  const ids = Object.values(run.sourceSyncs as Record<string, string>);
  return tx.$queryRaw<Array<{ source: string; published: number; associated: number; pendingReview: number }>>`
  WITH touched AS (
   SELECT DISTINCT t.source,r."eventId" FROM "CollectionTask" t JOIN "EventSourceReference" r
    ON r."sourceType"=t.source AND (r."sourceId"=t.payload->>'sourceId' OR rtrim(r.url,'/')=rtrim(t.payload->>'url','/')
      OR r."eventId"=t.payload->>'eventId')
   WHERE t.payload->>'syncId'=ANY(${ids}::text[]) AND t.kind IN ('inspect','check-source')
  ) SELECT t.source,count(*) FILTER(WHERE e."publicationStatus"='published' AND e.country='BR')::int AS published,
   count(*) FILTER(WHERE (SELECT count(DISTINCT r."sourceType") FROM "EventSourceReference" r WHERE r."eventId"=e.id)>1)::int AS associated,
   count(*) FILTER(WHERE e."publicationStatus"='pending_review')::int AS "pendingReview"
  FROM touched t JOIN "Event" e ON e.id=t."eventId" GROUP BY t.source`;
}
export async function coordinateCatalogCampaigns() {
  if (process.env.WORKER_MODE !== "continuous" || process.env.WORKER_TASK_SELECTION_FILE) return { observed: 0 };
  if (inspectLocalResources().reason) return { observed: 0 };
  return prisma
    .$transaction(
      async (tx) => {
        await lock(tx);
        const run = await tx.catalogCampaign.findFirst({
          where: { status: { notIn: terminal }, pauseRequested: false },
        });
        if (!run) return { observed: 0 };
        let result;
        try {
          result = await observeCatalogCycle(tx, run, new Date(), {
            keyPrefix:
              "campaign-reconcile:" +
              String((run.options as { reconciliationEpoch?: string }).reconciliationEpoch ?? "initial"),
            reason: "Cruzamento após carga ampla",
            attach: (id) => tx.catalogCampaign.update({ where: { id: run.id }, data: { reconciliationId: id } }),
          });
        } catch (error) {
          if (!(error instanceof TaskConflict || error instanceof CapacityDeferred)) throw error;
          result = { status: "blocked", summary: { ...(run.summary as object), reason: error.message } };
        }
        const counts = await editionCounts(tx, run);
        const summary = json({ ...result.summary, editionCounts: counts });
        const status =
          result.status === "completed" && counts.some((c) => c.pendingReview > 0)
            ? "completed_with_review"
            : result.status;
        await tx.catalogCampaign.update({
          where: { id: run.id },
          data: {
            status,
            summary,
            updatedAt: new Date(),
            ...(terminal.includes(status) ? { finishedAt: new Date() } : {}),
          },
        });
        return { observed: 1 };
      },
      { timeout: 15000 },
    )
    .catch((e) => {
      if (e instanceof TaskConflict || e instanceof CapacityDeferred) return { observed: 0, reason: e.message };
      throw e;
    });
}
