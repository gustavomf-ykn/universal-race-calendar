import type { FastifyInstance } from "fastify";
import { prisma, compareSourceObservations, observationOf, type SourceObservation } from "@race-calendar/database";
import { requireAdmin } from "./auth.js";

export async function registerSourceComparison(app: FastifyInstance) {
  app.get("/v1/admin/catalog/events/:id/comparison", { onRequest: requireAdmin, schema: {
    tags: ["Operations"], security: [{ supabaseAuth: [] }, { internalKey: [] }],
    response: { 200: { type: "object", additionalProperties: true },
      401: { type: "object", properties: { error: { type: "string" } } },
      403: { type: "object", properties: { error: { type: "string" } } },
      404: { type: "object", properties: { error: { type: "string" } } } },
  } }, async (req, reply) => {
    const event = await prisma.event.findUnique({ where: { id: (req.params as { id: string }).id }, include: {
      sourceReferences: { orderBy: [{ priority: "desc" }, { id: "asc" }] },
    } });
    if (!event) return reply.code(404).send({ error: "event_not_found" });
    const sources = event.sourceReferences.map(ref => ({ sourceType: ref.sourceType, sourceExternalId: ref.sourceExternalId,
      url: ref.url, role: ref.role, lastSeenAt: ref.lastSeenAt, lastValidatedAt: ref.lastValidatedAt,
      observation: observationOf(ref.observation as SourceObservation) }));
    return { eventId: event.id, sources, fields: compareSourceObservations({ ...event, date: event.date?.toISOString().slice(0, 10) ?? null }, sources) };
  });
}
