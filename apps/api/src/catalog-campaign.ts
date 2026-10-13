import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./auth.js";
import {
  campaignDefaults,
  startCatalogCampaign,
  readCatalogCampaigns,
  getCatalogCampaign,
  controlCatalogCampaign,
  TaskConflict,
  CapacityDeferred,
  type CampaignInput,
  prisma,
  brazilianStateCodes,
} from "@race-calendar/database";
const path = "/v1/admin/catalog/campaigns";
const reason = { type: "string", minLength: 3, maxLength: 500 };
const headers = {
  type: "object",
  required: ["idempotency-key"],
  properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 100 } },
  additionalProperties: true,
};
const error = { type: "object", properties: { error: { type: "string" } } };
const response = {
  200: { type: "object", additionalProperties: true },
  202: { type: "object", additionalProperties: true },
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
};
const schema = { tags: ["Operations"], security: [{ supabaseAuth: [] }, { internalKey: [] }], response };
function reject(reply: import("fastify").FastifyReply, e: unknown) {
  if (e instanceof TaskConflict || e instanceof CapacityDeferred)
    return reply.code(e.message === "campaign_not_found" ? 404 : 409).send({ error: e.message });
  throw e;
}
export async function registerCatalogCampaign(app: FastifyInstance) {
  app.get(
    path,
    {
      onRequest: requireAdmin,
      schema: {
        ...schema,
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
      const q = req.query as { page: number; limit: number };
      return readCatalogCampaigns(q.page, q.limit);
    },
  );
  app.get(
    path + "/:id",
    {
      onRequest: requireAdmin,
      schema: { ...schema, params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
    },
    async (req, reply) => {
      try {
        return await getCatalogCampaign((req.params as { id: string }).id);
      } catch (e) {
        return reject(reply, e);
      }
    },
  );
  app.post(
    path,
    {
      onRequest: requireAdmin,
      schema: {
        ...schema,
        headers,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: {
            reason,
            states: {
              type: "array",
              minItems: 1,
              maxItems: 27,
              uniqueItems: true,
              items: { enum: brazilianStateCodes },
              default: campaignDefaults.states,
            },
            batchSize: { type: "integer", minimum: 1, maximum: 25, default: campaignDefaults.batchSize },
            prefixLimit: { type: "integer", minimum: 25, maximum: 10000, default: campaignDefaults.prefixLimit },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return reply
          .code(202)
          .send(
            await startCatalogCampaign(
              req.principal!.id,
              String(req.headers["idempotency-key"]),
              req.body as CampaignInput,
            ),
          );
      } catch (e) {
        return reject(reply, e);
      }
    },
  );
  for (const action of ["pause", "resume", "cancel"] as const)
    app.post(
      path + "/:id/" + action,
      {
        onRequest: requireAdmin,
        schema: {
          ...schema,
          headers,
          params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason } },
        },
      },
      async (req, reply) => {
        try {
          return await controlCatalogCampaign(
            req.principal!.id,
            String(req.headers["idempotency-key"]),
            (req.params as { id: string }).id,
            action,
            (req.body as { reason: string }).reason,
          );
        } catch (e) {
          return reject(reply, e);
        }
      },
    );
  app.get(
    "/ready",
    { schema: { tags: ["Operations"], response: { 200: { type: "object", additionalProperties: true }, 503: error } } },
    async (_req, reply) => {
      try {
        const rows = await prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL statement_timeout='2500ms'`;
            await tx.$queryRaw`SELECT "leaseUntil","leaseToken" FROM "CollectionTask" LIMIT 0`;
            await tx.$queryRaw`SELECT "createdCount","existingCount","countsAvailable" FROM "CatalogSync" LIMIT 0`;
            await tx.$queryRaw`SELECT "sourceSyncs","reconciliationId" FROM "CatalogCampaign" LIMIT 0`;
            return tx.$queryRaw<
              Array<{ queue: boolean; campaign: boolean }>
            >`SELECT to_regclass('public."CollectionTask"') IS NOT NULL AS queue,
      to_regclass('public."CatalogCampaign"') IS NOT NULL AS campaign`;
          },
          { timeout: 4000, maxWait: 2000 },
        );
        const ref = process.env.EXPECTED_SUPABASE_PROJECT_REF;
        if (
          !rows[0]?.queue ||
          !rows[0]?.campaign ||
          !process.env.SUPABASE_URL ||
          (ref && process.env.SUPABASE_URL !== `https://${ref}.supabase.co`)
        )
          throw Error();
        return { status: "ready", database: true, schema: true };
      } catch {
        return reply.code(503).send({ error: "backend_not_ready" });
      }
    },
  );
}
