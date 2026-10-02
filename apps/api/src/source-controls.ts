import type { FastifyInstance } from "fastify";
import {
  prisma,
  requestSources,
  publicSourceControl,
  configureSourceRequests,
  resumeSourceRequests,
  TaskConflict,
  type RequestSource,
} from "@race-calendar/database";
import { requireAdmin } from "./auth.js";

const error = { type: "object", properties: { error: { type: "string" } } };
const common = {
  tags: ["Operations"],
  security: [{ supabaseAuth: [] }, { internalKey: [] }],
  response: { 200: { type: "object", additionalProperties: true }, 400: error, 401: error, 403: error, 409: error },
};
const headers = {
  type: "object",
  properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 100 } },
  required: ["idempotency-key"],
  additionalProperties: true,
};
const params = {
  type: "object",
  properties: { source: { type: "string", enum: [...requestSources] } },
  required: ["source"],
};
const reason = { type: "string", minLength: 3, maxLength: 500 };

export async function registerSourceControls(app: FastifyInstance) {
  app.get("/v1/admin/source-controls", { onRequest: requireAdmin, schema: common }, async () => {
    const gates = await prisma.sourceRequestControl.findMany();
    const now = new Date();
    return {
      data: requestSources.map((source) =>
        publicSourceControl(
          gates.find((g) => g.source === source) ?? {
            source,
            windowStart: new Date(Math.floor(now.getTime() / 3600000) * 3600000),
            requestCount: 0,
            limitPerHour: 100,
            minDelayMs: 1000,
            blockedAt: null,
            blockedUntil: null,
            blockReason: null,
          },
          now,
        ),
      ),
    };
  });
  for (const action of ["configure", "resume"] as const) {
    app.post(
      `/v1/admin/source-controls/:source/${action}`,
      {
        onRequest: requireAdmin,
        schema: {
          ...common,
          headers,
          params,
          body: {
            type: "object",
            additionalProperties: false,
            properties:
              action === "resume"
                ? { reason }
                : {
                    reason,
                    limitPerHour: { type: "integer", minimum: 1, maximum: 100 },
                    minDelayMs: { type: "integer", minimum: 1000, maximum: 60000 },
                  },
            required: action === "resume" ? ["reason"] : ["reason", "limitPerHour", "minDelayMs"],
          },
        },
      },
      async (req, reply) => {
        const { source } = req.params as { source: RequestSource };
        const payload = req.body as { reason: string; limitPerHour: number; minDelayMs: number };
        const key = req.headers["idempotency-key"] as string;
        try {
          return action === "resume"
            ? await resumeSourceRequests(source, req.principal!.id, payload.reason, key)
            : await configureSourceRequests(source, req.principal!.id, payload, key);
        } catch (e) {
          if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
          throw e;
        }
      },
    );
  }
}
