import type { FastifyInstance } from "fastify";
import {
  previewEventReconciliation,
  reconcileEventEditions,
  ReconciliationConflict,
  TaskConflict,
  CapacityDeferred,
  type ReconciliationInput,
  prisma,
  startCatalogReconciliation,
  publicCatalogReconciliation,
  controlCatalogReconciliation,
  publicTask,
  resolveEventIds,
} from "@race-calendar/database";
import { requireAdmin } from "./auth.js";

const identity = { type: "string", minLength: 1, maxLength: 100 };
const pair = { sourceId: identity, targetId: identity };
const object = (properties: object, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const error = object({ error: { type: "string" } }, ["error"]);
const response = {
  200: { type: "object", additionalProperties: true },
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
  503: error,
};
const security = [{ supabaseAuth: [] }, { internalKey: [] }];
const idempotency = {
  type: "object",
  required: ["idempotency-key"],
  properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 128 } },
};
const page = { type: "integer", minimum: 1, default: 1 };
const limit = { type: "integer", minimum: 1, maximum: 100, default: 20 };
async function scanWithTask(run: Parameters<typeof publicCatalogReconciliation>[0]) {
  const task = await prisma.collectionTask.findFirst({
    where: { kind: "catalog-reconcile", payload: { path: ["runId"], equals: run.id } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return { ...publicCatalogReconciliation(run), latestTask: task ? publicTask(task) : null };
}

export async function registerReconciliation(app: FastifyInstance) {
  app.post(
    "/v1/admin/catalog/reconciliations/scans",
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Operations"],
        security,
        headers: idempotency,
        body: object({ reason: { type: "string", minLength: 3, maxLength: 500 } }, ["reason"]),
        response: { ...response, 202: { type: "object", additionalProperties: true } },
      },
    },
    async (request, reply) => {
      try {
        const result = await startCatalogReconciliation(
          request.principal!.id,
          String(request.headers["idempotency-key"]),
          (request.body as { reason: string }).reason,
        );
        return reply.code(202).send(result);
      } catch (error) {
        if (error instanceof TaskConflict) return reply.code(409).send({ error: error.message });
        if (error instanceof CapacityDeferred) return reply.code(503).send({ error: "catalog_capacity_wait" });
        throw error;
      }
    },
  );
  app.get(
    "/v1/admin/catalog/reconciliations/scans",
    {
      onRequest: requireAdmin,
      schema: { tags: ["Operations"], security, querystring: object({ page, limit }, []), response },
    },
    async (request) => {
      const query = request.query as { page: number; limit: number };
      const where = {};
      const [total, runs] = await Promise.all([
        prisma.catalogReconciliation.count({ where }),
        prisma.catalogReconciliation.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);
      return { data: await Promise.all(runs.map(scanWithTask)), total, page: query.page, limit: query.limit };
    },
  );
  app.get(
    "/v1/admin/catalog/reconciliations/scans/:id",
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Operations"],
        security,
        params: object({ id: identity }, ["id"]),
        querystring: object(
          { page, limit, status: { type: "string", enum: ["merged", "review", "unmatched", "foreign", "waiting"] } },
          [],
        ),
        response,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { page: number; limit: number; status?: string };
      const run = await prisma.catalogReconciliation.findUnique({ where: { id } });
      if (!run) return reply.code(404).send({ error: "reconciliation_run_not_found" });
      const where = { runId: id, ...(query.status ? { status: query.status } : {}) };
      const [total, decisions] = await Promise.all([
        prisma.catalogReconciliationDecision.count({ where }),
        prisma.catalogReconciliationDecision.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ]);
      const data = await Promise.all(
        decisions.map(async ({ eventId, status, reason, details, createdAt }) => {
          const ids = (details as { eventIds?: unknown }).eventIds;
          const originals = Array.isArray(ids)
            ? ids.filter((value): value is string => typeof value === "string").slice(0, 8)
            : [eventId];
          const canonical = await resolveEventIds(originals);
          const candidates = await prisma.event.findMany({
            where: { id: { in: canonical } },
            orderBy: { id: "asc" },
            select: {
              id: true,
              name: true,
              date: true,
              city: true,
              state: true,
              country: true,
              sourceType: true,
              publicationStatus: true,
              sourceReferences: { select: { sourceType: true, sourceExternalId: true, url: true } },
            },
          });
          return {
            eventId,
            status,
            reason,
            details,
            createdAt,
            candidates: candidates.map(({ sourceReferences, ...event }) => ({
              ...event,
              sources: sourceReferences.map((ref) => ({
                sourceType: ref.sourceType,
                externalId: ref.sourceExternalId,
                url: ref.url,
              })),
            })),
          };
        }),
      );
      return { run: await scanWithTask(run), data, total, page: query.page, limit: query.limit };
    },
  );
  app.post(
    "/v1/admin/catalog/reconciliations/scans/:id/:action",
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Operations"],
        security,
        headers: idempotency,
        params: object({ id: identity, action: { type: "string", enum: ["pause", "resume", "cancel"] } }, [
          "id",
          "action",
        ]),
        response,
      },
    },
    async (request, reply) => {
      const { id, action } = request.params as { id: string; action: "pause" | "resume" | "cancel" };
      try {
        return await controlCatalogReconciliation(
          request.principal!.id,
          String(request.headers["idempotency-key"]),
          id,
          action,
        );
      } catch (error) {
        if (error instanceof TaskConflict)
          return reply
            .code(error.message === "reconciliation_run_not_found" ? 404 : 409)
            .send({ error: error.message });
        if (error instanceof CapacityDeferred) return reply.code(503).send({ error: "catalog_capacity_wait" });
        throw error;
      }
    },
  );
  app.post(
    "/v1/admin/catalog/reconciliations/preview",
    {
      onRequest: requireAdmin,
      schema: { tags: ["Operations"], security, body: object(pair, ["sourceId", "targetId"]), response },
    },
    async (request, reply) => {
      const input = request.body as { sourceId: string; targetId: string };
      try {
        return await previewEventReconciliation(input.sourceId, input.targetId);
      } catch (error) {
        if (error instanceof ReconciliationConflict)
          return reply.code(error.message === "event_not_found" ? 404 : 409).send({ error: error.message });
        throw error;
      }
    },
  );
  app.post(
    "/v1/admin/catalog/reconciliations",
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Operations"],
        security,
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 128 } },
        },
        body: object(
          {
            ...pair,
            revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            reason: { type: "string", minLength: 3, maxLength: 500 },
            confirmedSameEdition: { type: "boolean", const: true },
          },
          ["sourceId", "targetId", "revision", "reason", "confirmedSameEdition"],
        ),
        response,
      },
    },
    async (request, reply) => {
      const input = request.body as Omit<ReconciliationInput, "mode">;
      try {
        return await reconcileEventEditions(request.principal!.id, String(request.headers["idempotency-key"]), {
          ...input,
          mode: "manual",
        });
      } catch (error) {
        if (error instanceof ReconciliationConflict || error instanceof TaskConflict)
          return reply.code(error.message === "event_not_found" ? 404 : 409).send({ error: error.message });
        if (error instanceof CapacityDeferred) return reply.code(503).send({ error: "catalog_capacity_wait" });
        throw error;
      }
    },
  );
}
