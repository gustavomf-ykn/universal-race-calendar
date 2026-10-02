import type { FastifyInstance } from "fastify";
import { readCapacity, controlCapacity, TaskConflict, CapacityDeferred } from "@race-calendar/database";
import { requireAdmin } from "./auth.js";

const error = { type: "object", properties: { error: { type: "string" } } };
const common = {
  tags: ["Operations"],
  security: [{ supabaseAuth: [] }, { internalKey: [] }],
  response: { 200: { type: "object", additionalProperties: true }, 400: error, 401: error, 403: error, 409: error },
};
const reason = { type: "string", minLength: 3, maxLength: 500 };
const bytes = { type: "string", pattern: "^[1-9][0-9]{0,12}$" };
export async function registerCapacity(app: FastifyInstance) {
  app.get("/v1/admin/capacity", { onRequest: requireAdmin, schema: common }, async () => ({
    ...(await readCapacity()),
    providerQuotaVerified: false,
  }));
  for (const action of ["configure", "resume", "refresh"] as const) {
    app.post(
      `/v1/admin/capacity/${action}`,
      {
        onRequest: requireAdmin,
        schema: {
          ...common,
          headers: {
            type: "object",
            required: ["idempotency-key"],
            additionalProperties: true,
            properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 100 } },
          },
          body: {
            type: "object",
            additionalProperties: false,
            properties:
              action === "configure"
                ? {
                    reason,
                    databaseBudgetBytes: bytes,
                    storageBudgetBytes: bytes,
                    databaseHeadroomBytes: bytes,
                    storageHeadroomBytes: bytes,
                    allocationConfirmed: { type: "boolean", const: true },
                  }
                : action === "resume"
                  ? { reason, resource: { type: "string", enum: ["database", "storage"] } }
                  : { reason },
            required:
              action === "configure"
                ? [
                    "reason",
                    "databaseBudgetBytes",
                    "storageBudgetBytes",
                    "databaseHeadroomBytes",
                    "storageHeadroomBytes",
                    "allocationConfirmed",
                  ]
                : action === "resume"
                  ? ["reason", "resource"]
                  : ["reason"],
          },
        },
      },
      async (req, reply) => {
        try {
          return await controlCapacity(
            req.principal!.id,
            req.headers["idempotency-key"] as string,
            action,
            req.body as Parameters<typeof controlCapacity>[3],
          );
        } catch (e) {
          if (e instanceof TaskConflict || e instanceof CapacityDeferred)
            return reply.code(409).send({ error: e.message });
          throw e;
        }
      },
    );
  }
}
