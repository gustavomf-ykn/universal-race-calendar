import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { enqueueTask, prisma, publicTask, TaskConflict } from "@race-calendar/database";
import { authorize, keyHash, requireAdmin } from "./auth.js";
import { resultSchema, disciplineSchema, matchSchema } from "./contracts.js";

const text = { type: "string" } as const;
const idParams = { type: "object", required: ["id"], properties: { id: text } };
const error = { type: "object", required: ["error"], properties: { error: text } };
const security = [{ supabaseAuth: [] }, { clientKey: [] }, { internalKey: [] }];
const pageQuery = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
};
const pagination = {
  type: "object",
  properties: {
    page: { type: "integer" },
    limit: { type: "integer" },
    total: { type: "integer" },
    totalPages: { type: "integer" },
  },
};
const taskSchema = {
  type: "object",
  required: ["id", "status"],
  properties: {
    id: text,
    source: text,
    kind: text,
    status: { enum: ["queued", "running", "completed", "partial", "failed", "cancelled"] },
    progress: { type: "object", additionalProperties: true },
    attempt: { type: "integer" },
    maxAttempts: { type: "integer" },
    errorCode: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    finishedAt: { type: ["string", "null"], format: "date-time" },
  },
};
const errors = { 400: error, 401: error, 403: error, 404: error, 409: error, 429: error };
const idempotencyHeaders = {
  type: "object",
  required: ["idempotency-key"],
  properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 128 } },
};
const page = (q: unknown) => {
  const v = q as { page?: number; limit?: number };
  return { page: v.page ?? 1, limit: v.limit ?? 20 };
};
const envelope = (data: unknown[], total: number, p: number, l: number) => ({
  data,
  pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) },
});
const owned = (owner: string, req: FastifyRequest) => req.principal?.admin || owner === req.principal?.id;
export async function acceptTask(
  request: FastifyRequest,
  reply: FastifyReply,
  source: string,
  kind: string,
  payload: Record<string, unknown>,
) {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !key.trim() || key.length > 128)
    return reply.code(400).send({ error: "idempotency_key_required" });
  try {
    const task = await enqueueTask(request.principal!.id, key, source, kind, JSON.parse(JSON.stringify(payload)));
    return reply.code(202).header("Location", `/v1/tasks/${task.id}`).send(publicTask(task));
  } catch (e) {
    if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
    throw e;
  }
}
export async function registerBackend(app: FastifyInstance) {
  app.post(
    "/v1/admin/openresults/discover",
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Collections"],
        security,
        headers: idempotencyHeaders,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["from"],
          properties: {
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
            maxPages: { type: "integer", minimum: 1, maximum: 10, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          },
        },
        response: { 202: taskSchema, ...errors },
      },
    },
    async (req, reply) => {
      const body = req.body as { from: string; to?: string; maxPages: number; limit: number };
      if (body.to && body.to < body.from) return reply.code(400).send({ error: "invalid_date_range" });
      return acceptTask(req, reply, "openresults", "discover", { ...body });
    },
  );
  app.post(
    "/v1/collections",
    {
      onRequest: requireAdmin,
      schema: {
        tags: ["Collections"],
        security,
        headers: idempotencyHeaders,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["source"],
          properties: {
            source: { enum: ["ticketsports", "corridasbr", "openresults"] },
            eventId: text,
            url: text,
            quantity: { type: "integer", minimum: 1, maximum: 500, default: 25 },
            force: { type: "boolean", default: false },
            states: { type: "array", items: { type: "string", pattern: "^[A-Z]{2}$" }, maxItems: 27 },
          },
        },
        response: { 202: taskSchema, ...errors },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        source: string;
        eventId?: string;
        url?: string;
        quantity: number;
        force: boolean;
        states?: string[];
      };
      if (body.source === "openresults") {
        if (!body.eventId) return reply.code(400).send({ error: "event_id_required" });
        const reference = await prisma.eventSourceReference.findFirst({
          where: { eventId: body.eventId, sourceType: "openresults" },
        });
        if (!reference) return reply.code(409).send({ error: "source_association_required" });
        return acceptTask(req, reply, "openresults", "extract", {
          eventId: body.eventId,
          url: reference.url,
          externalId: reference.sourceExternalId,
        });
      }
      return acceptTask(req, reply, body.source, "calendar", {
        quantity: body.quantity,
        force: body.force,
        ...(body.states ? { states: body.states } : {}),
      });
    },
  );
  app.get(
    "/v1/tasks",
    {
      onRequest: authorize("tasks:read"),
      schema: {
        security,
        querystring: pageQuery,
        response: {
          200: { type: "object", properties: { data: { type: "array", items: taskSchema }, pagination } },
          ...errors,
        },
      },
    },
    async (req) => {
      const { page: p, limit: l } = page(req.query);
      const where = req.principal!.admin ? {} : { ownerId: req.principal!.id };
      const [rows, total] = await Promise.all([
        prisma.collectionTask.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p - 1) * l, take: l }),
        prisma.collectionTask.count({ where }),
      ]);
      return envelope(rows.map(publicTask), total, p, l);
    },
  );
  app.get(
    "/v1/tasks/:id",
    {
      onRequest: authorize("tasks:read"),
      schema: { security, params: idParams, response: { 200: taskSchema, ...errors } },
    },
    async (req, reply) => {
      const t = await prisma.collectionTask.findUnique({ where: { id: (req.params as { id: string }).id } });
      if (!t || !owned(t.ownerId, req)) return reply.code(404).send({ error: "task_not_found" });
      return publicTask(t);
    },
  );
  app.post(
    "/v1/tasks/:id/cancel",
    { onRequest: requireAdmin, schema: { security, params: idParams, response: { 200: taskSchema, ...errors } } },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const result = await prisma.collectionTask.updateMany({
        where: { id, status: "queued" },
        data: { status: "cancelled", finishedAt: new Date(), updatedAt: new Date() },
      });
      if (!result.count) return reply.code(409).send({ error: "only_queued_tasks_can_be_cancelled" });
      return publicTask(await prisma.collectionTask.findUniqueOrThrow({ where: { id } }));
    },
  );
  app.get(
    "/v1/events/:id/modalities",
    {
      schema: {
        params: idParams,
        response: {
          200: { type: "object", properties: { data: { type: "array", items: disciplineSchema } } },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const eventId = (req.params as { id: string }).id;
      if (!(await prisma.event.findFirst({ where: { id: eventId, publicationStatus: "published" } })))
        return reply.code(404).send({ error: "event_not_found" });
      return {
        data: await prisma.raceDiscipline.findMany({
          where: { resultSet: { eventId } },
          select: {
            id: true,
            name: true,
            distanceKm: true,
            externalId: true,
            resultSet: { select: { source: true, updatedAt: true } },
          },
        }),
      };
    },
  );
  app.get(
    "/v1/events/:id/results",
    {
      onRequest: authorize("results:read"),
      schema: {
        security,
        params: idParams,
        querystring: { ...pageQuery, properties: { ...pageQuery.properties, modality: text } },
        response: {
          200: { type: "object", properties: { data: { type: "array", items: resultSchema }, pagination } },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const eventId = (req.params as { id: string }).id;
      if (!(await prisma.event.findFirst({ where: { id: eventId, publicationStatus: "published" } })))
        return reply.code(404).send({ error: "event_not_found" });
      const { page: p, limit: l } = page(req.query);
      const modality = (req.query as { modality?: string }).modality;
      const where = { resultSet: { eventId }, ...(modality ? { modality } : {}) };
      const [rows, total] = await Promise.all([
        prisma.raceResult.findMany({
          where,
          skip: (p - 1) * l,
          take: l,
          orderBy: [{ overallPosition: "asc" }, { id: "asc" }],
          select: {
            id: true,
            modality: true,
            gender: true,
            category: true,
            bib: true,
            name: true,
            team: true,
            overallPosition: true,
            categoryPosition: true,
            time: true,
            pace: true,
            resultSet: { select: { source: true, sourceUrl: true, updatedAt: true } },
          },
        }),
        prisma.raceResult.count({ where }),
      ]);
      return envelope(rows, total, p, l);
    },
  );
  app.post(
    "/v1/events/:id/exports",
    {
      onRequest: authorize("exports:write"),
      schema: {
        security,
        params: idParams,
        headers: idempotencyHeaders,
        response: {
          202: { type: "object", properties: { id: text, taskId: text, status: text, expiresAt: text } },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const eventId = (req.params as { id: string }).id;
      if (!(await prisma.event.findFirst({ where: { id: eventId, publicationStatus: "published" } })))
        return reply.code(404).send({ error: "event_not_found" });
      if (!(await prisma.resultSet.count({ where: { eventId } })))
        return reply.code(409).send({ error: "results_unavailable" });
      let task;
      try {
        task = await enqueueTask(req.principal!.id, String(req.headers["idempotency-key"]), "exports", "export", {
          eventId,
        });
      } catch (e) {
        if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
        throw e;
      }
      const item = await prisma.exportArtifact.upsert({
        where: { taskId: task.id },
        update: {},
        create: {
          eventId,
          ownerId: req.principal!.id,
          taskId: task.id,
          expiresAt: new Date(task.createdAt.getTime() + 86400000),
        },
      });
      return reply
        .code(202)
        .send({ id: item.id, taskId: task.id, status: item.status, expiresAt: item.expiresAt.toISOString() });
    },
  );
  app.get(
    "/v1/exports/:id",
    {
      onRequest: authorize("exports:write"),
      schema: {
        security,
        params: idParams,
        response: {
          200: {
            type: "object",
            properties: {
              id: text,
              taskId: text,
              status: text,
              expiresAt: text,
              downloadUrl: { type: ["string", "null"] },
            },
          },
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const item = await prisma.exportArtifact.findUnique({ where: { id: (req.params as { id: string }).id } });
      if (!item || !owned(item.ownerId, req)) return reply.code(404).send({ error: "export_not_found" });
      if (!(await prisma.event.findFirst({ where: { id: item.eventId, publicationStatus: "published" } })))
        return reply.code(404).send({ error: "event_not_found" });
      const task = await prisma.collectionTask.findUnique({ where: { id: item.taskId }, select: { status: true } });
      const expired = item.expiresAt <= new Date();
      let downloadUrl: string | null = null;
      if (!expired && item.status === "completed" && item.objectPath) {
        const base = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!base || !key) return reply.code(503).send({ error: "storage_not_configured" });
        const response = await fetch(`${base}/storage/v1/object/sign/race-exports/${item.objectPath}`, {
          method: "POST",
          headers: {
            apikey: key,
            ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            expiresIn: Math.max(1, Math.min(60, Math.floor((item.expiresAt.getTime() - Date.now()) / 1000))),
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return reply.code(503).send({ error: "storage_unavailable" });
        const data = (await response.json()) as { signedURL: string };
        downloadUrl = `${base}/storage/v1${data.signedURL}`;
      }
      return {
        id: item.id,
        taskId: item.taskId,
        status: expired ? "expired" : item.status === "completed" ? "completed" : (task?.status ?? item.status),
        expiresAt: item.expiresAt.toISOString(),
        downloadUrl,
      };
    },
  );
  app.post(
    "/v1/admin/source-matches",
    {
      onRequest: requireAdmin,
      schema: {
        security,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: { url: { type: "string", pattern: "^https://openresults\\.run/evento/[^/?#]+/?$" } },
        },
        headers: idempotencyHeaders,
        response: { 202: taskSchema, ...errors },
      },
    },
    async (req, reply) => acceptTask(req, reply, "openresults", "inspect", { url: (req.body as { url: string }).url }),
  );
  app.get(
    "/v1/admin/source-matches",
    {
      onRequest: requireAdmin,
      schema: {
        security,
        querystring: pageQuery,
        response: {
          200: { type: "object", properties: { data: { type: "array", items: matchSchema }, pagination } },
          ...errors,
        },
      },
    },
    async (req) => {
      const { page: p, limit: l } = page(req.query);
      const where = { status: "pending" };
      const [data, total] = await Promise.all([
        prisma.sourceMatch.findMany({ where, skip: (p - 1) * l, take: l, orderBy: { id: "asc" } }),
        prisma.sourceMatch.count({ where }),
      ]);
      return envelope(data, total, p, l);
    },
  );
  app.post(
    "/v1/admin/source-matches/:id/resolve",
    {
      onRequest: requireAdmin,
      schema: {
        security,
        params: idParams,
        body: { type: "object", additionalProperties: false, required: ["eventId"], properties: { eventId: text } },
        response: { 200: matchSchema, ...errors },
      },
    },
    async (req, reply) => {
      const match = await prisma.sourceMatch.findUnique({ where: { id: (req.params as { id: string }).id } });
      const eventId = (req.body as { eventId: string }).eventId;
      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (!match || !event) return reply.code(404).send({ error: "match_or_event_not_found" });
      if (!match.date || !event.date || match.date.toISOString().slice(0, 10) !== event.date.toISOString().slice(0, 10))
        return reply.code(409).send({ error: "edition_date_mismatch" });
      const existing = await prisma.eventSourceReference.findUnique({
        where: { sourceType_sourceExternalId: { sourceType: match.source, sourceExternalId: match.externalId } },
      });
      if (existing && existing.eventId !== eventId) return reply.code(409).send({ error: "already_associated" });
      return prisma.$transaction(async (tx) => {
        const source = await tx.source.upsert({
          where: { adapter_externalId: { adapter: match.source, externalId: match.externalId } },
          update: {},
          create: {
            name: match.name,
            url: match.url,
            type: "official_page",
            adapter: match.source,
            externalId: match.externalId,
          },
        });
        const linked = await tx.eventSourceReference.upsert({
          where: { sourceType_sourceExternalId: { sourceType: match.source, sourceExternalId: match.externalId } },
          update: {},
          create: {
            eventId,
            sourceId: source.id,
            sourceType: match.source,
            sourceExternalId: match.externalId,
            url: match.url,
          },
        });
        if (linked.eventId !== eventId) throw Object.assign(new Error("already_associated"), { statusCode: 409 });
        return tx.sourceMatch.update({
          where: { id: match.id },
          data: { eventId, status: "resolved", resolvedBy: req.principal!.id, updatedAt: new Date() },
        });
      });
    },
  );
  app.post(
    "/v1/admin/api-keys",
    {
      onRequest: requireAdmin,
      schema: {
        security,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "scopes"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            scopes: {
              type: "array",
              items: { enum: ["results:read", "exports:write", "tasks:read"] },
              minItems: 1,
              uniqueItems: true,
            },
            limitPerHour: { type: "integer", minimum: 1, maximum: 100000, default: 1000 },
          },
        },
        response: { 201: { type: "object", properties: { id: text, key: text } }, ...errors },
      },
    },
    async (req, reply) => {
      const body = req.body as { name: string; scopes: string[]; limitPerHour: number };
      const key = `rk_${randomBytes(32).toString("base64url")}`;
      const item = await prisma.apiCredential.create({ data: { id: randomUUID(), ...body, keyHash: keyHash(key) } });
      return reply.code(201).send({ id: item.id, key });
    },
  );
  app.delete(
    "/v1/admin/api-keys/:id",
    { onRequest: requireAdmin, schema: { security, params: idParams, response: { 204: { type: "null" }, ...errors } } },
    async (req, reply) => {
      await prisma.apiCredential.updateMany({
        where: { id: (req.params as { id: string }).id },
        data: { revokedAt: new Date() },
      });
      return reply.code(204).send();
    },
  );
}
