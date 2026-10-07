import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./auth.js";
import {
  weeklyDefaults,
  readWeeklyCatalog,
  configureWeeklyCatalog,
  cancelWeeklyOccurrence,
  brazilianStateCodes,
  TaskConflict,
  CapacityDeferred,
  type WeeklyConfiguration,
} from "@race-calendar/database";

const security = [{ supabaseAuth: [] }, { internalKey: [] }];
const headers = {
  type: "object",
  required: ["idempotency-key"],
  properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 100 } },
  additionalProperties: true,
};
const reason = { type: "string", minLength: 3, maxLength: 500 };
const error = { type: "object", required: ["error"], properties: { error: { type: "string" } } };
const response = {
  200: { type: "object", additionalProperties: true },
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
};
const path = "/v1/admin/catalog/weekly";
export async function registerWeeklyCatalog(app: FastifyInstance) {
  app.get(
    path,
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Operations"],
        security,
        response,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
          },
        },
      },
    },
    async (req) => {
      const { page, limit } = req.query as { page: number; limit: number };
      return readWeeklyCatalog(page, limit);
    },
  );
  app.post(
    `${path}/configure`,
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Operations"],
        security,
        headers,
        response,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "expectedRevision", "reason"],
          properties: {
            enabled: { type: "boolean" },
            expectedRevision: { type: "integer", minimum: 0 },
            reason,
            weekday: { type: "integer", minimum: 1, maximum: 7, default: weeklyDefaults.weekday },
            hour: { type: "integer", minimum: 0, maximum: 23, default: weeklyDefaults.hour },
            minute: { type: "integer", minimum: 0, maximum: 59, default: weeklyDefaults.minute },
            recentDays: { type: "integer", minimum: 1, maximum: 365, default: weeklyDefaults.recentDays },
            historicalEveryWeeks: {
              type: "integer",
              minimum: 1,
              maximum: 52,
              default: weeklyDefaults.historicalEveryWeeks,
            },
            batchSize: { type: "integer", minimum: 1, maximum: 25, default: weeklyDefaults.batchSize },
            snapshotLimit: { type: "integer", minimum: 5, maximum: 1000, default: weeklyDefaults.snapshotLimit },
            prefixLimit: { type: "integer", minimum: 25, maximum: 10000, default: weeklyDefaults.prefixLimit },
            states: {
              type: "array",
              items: { enum: brazilianStateCodes },
              minItems: 1,
              maxItems: 27,
              uniqueItems: true,
              default: weeklyDefaults.states,
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await configureWeeklyCatalog(
          req.principal!.id,
          String(req.headers["idempotency-key"]),
          req.body as WeeklyConfiguration,
        );
      } catch (error) {
        if (error instanceof TaskConflict || error instanceof CapacityDeferred)
          return reply
            .code(error.message === "weekly_configuration_invalid" ? 400 : 409)
            .send({ error: error.message });
        throw error;
      }
    },
  );
  app.post(
    `${path}/occurrences/:id/cancel`,
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Operations"],
        security,
        headers,
        response,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
        },
        body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason } },
      },
    },
    async (req, reply) => {
      try {
        return await cancelWeeklyOccurrence(
          req.principal!.id,
          String(req.headers["idempotency-key"]),
          (req.params as { id: string }).id,
          (req.body as { reason: string }).reason,
        );
      } catch (error) {
        if (error instanceof TaskConflict)
          return reply.code(error.message === "weekly_occurrence_not_found" ? 404 : 409).send({ error: error.message });
        throw error;
      }
    },
  );
}
