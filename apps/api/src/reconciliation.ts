import type { FastifyInstance } from "fastify";
import {
  previewEventReconciliation,
  reconcileEventEditions,
  ReconciliationConflict,
  TaskConflict,
  CapacityDeferred,
  type ReconciliationInput,
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

export async function registerReconciliation(app: FastifyInstance) {
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
