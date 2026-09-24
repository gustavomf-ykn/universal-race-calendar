import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { prisma, enqueueTask, publicTask, TaskConflict } from "@race-calendar/database";
import { requireAdmin, authorize } from "./auth.js";

const str = { type: "string" };
const ids = { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 100, uniqueItems: true };
const page = {
  page: { type: "integer", minimum: 1, default: 1 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
};
const filter = {
  q: str,
  sourceType: { enum: ["ticketsports", "corridasbr", "openresults"] },
  publicationStatus: { enum: ["draft", "pending_review", "published", "hidden", "rejected"] },
  incomplete: { type: "boolean" },
  from: { type: "string", format: "date" },
  to: { type: "string", format: "date" },
  city: str,
  state: str,
};
const object = (properties: object, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const headers = object({ "idempotency-key": { type: "string", minLength: 1, maxLength: 100 } }, ["idempotency-key"]);
// Headers may also contain Authorization, Content-Type, etc.
headers.additionalProperties = true;
const security = [{ supabaseAuth: [] }, { internalKey: [] }];
const error = object({ error: str }, ["error"]);
const response = {
  200: { type: "object", additionalProperties: true },
  202: { type: "object", additionalProperties: true },
  400: error,
  401: error,
  403: error,
  404: error,
  409: error,
};
const schema = (body?: object) => ({ tags: ["Operations"], security, response, ...(body ? { body } : {}) });
export function adminEventFilter(q: Record<string, any>) {
  const AND: any[] = [];
  if (q.q) AND.push({ name: { contains: q.q, mode: "insensitive" } });
  if (q.publicationStatus) AND.push({ publicationStatus: q.publicationStatus });
  if (q.sourceType)
    AND.push({ OR: [{ sourceType: q.sourceType }, { sourceReferences: { some: { sourceType: q.sourceType } } }] });
  if (q.city) AND.push({ city: { contains: q.city, mode: "insensitive" } });
  if (q.state) AND.push({ state: q.state });
  if (q.from || q.to)
    AND.push({
      date: {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
      },
    });
  if (q.incomplete)
    AND.push({ OR: [{ date: null }, { city: null }, { state: null }, { sourceExternalId: { startsWith: "url:" } }] });
  return { AND };
}
export async function registerOperations(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    if (route.url.includes(":id") && route.schema)
      route.schema.params = object({ id: { type: "string", minLength: 1 } }, ["id"]);
  });
  app.post(
    "/v1/admin/source-matches/:id/register",
    { onRequest: requireAdmin, schema: schema() },
    async (req, reply) => {
      const match = await prisma.sourceMatch.findUnique({ where: { id: (req.params as { id: string }).id } });
      if (!match) return reply.code(404).send({ error: "match_not_found" });
      return prisma.$transaction(async (tx) => {
        const identity = { sourceType: match.source, sourceExternalId: match.externalId };
        const ref = await tx.eventSourceReference.findFirst({
          where: { sourceType: match.source, OR: [{ sourceExternalId: match.externalId }, { url: match.url }] },
        });
        if (ref) return { eventId: ref.eventId };
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
        const digest = createHash("sha256")
          .update(match.source + ":" + match.externalId)
          .digest("hex");
        const event = await tx.event.upsert({
          where: { sourceType_sourceExternalId: identity },
          update: {},
          create: {
            id: "evt_" + digest.slice(0, 24),
            slug: match.source + "-" + digest.slice(0, 24),
            name: match.name,
            date: match.date,
            city: match.city,
            state: match.state,
            country: "BR",
            sourceId: source.id,
            ...identity,
            sourceUrl: match.url,
            canonicalFingerprint: digest,
            warnings: [],
            publishabilityReasons: ["administrative_review_required"],
            publicationStatus: "pending_review",
            administrativeReview: true,
          },
        });
        await tx.eventSourceReference.upsert({
          where: { sourceType_sourceExternalId: identity },
          update: {},
          create: { eventId: event.id, sourceId: source.id, ...identity, url: match.url },
        });
        await tx.sourceMatch.update({
          where: { id: match.id },
          data: { eventId: event.id, status: "resolved", resolvedBy: req.principal!.id },
        });
        await tx.adminAudit.create({
          data: {
            actorId: req.principal!.id,
            eventId: event.id,
            action: "register_independent_edition",
            details: { matchId: match.id },
          },
        });
        return { eventId: event.id };
      });
    },
  );
  app.get(
    "/v1/admin/catalog/events",
    { onRequest: requireAdmin, schema: { ...schema(), querystring: object({ ...page, ...filter }) } },
    async (req) => {
      const q = req.query as any;
      const where = adminEventFilter(q);
      const [data, total] = await Promise.all([
        prisma.event.findMany({
          where,
          skip: (q.page - 1) * q.limit,
          take: q.limit,
          orderBy: [{ date: "asc" }, { id: "asc" }],
          include: { sourceReferences: true },
        }),
        prisma.event.count({ where }),
      ]);
      return { data, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } };
    },
  );
  app.patch(
    "/v1/admin/catalog/events/:id",
    {
      onRequest: requireAdmin,
      schema: schema(
        object(
          {
            name: { type: "string", minLength: 1, maxLength: 300 },
            date: { type: ["string", "null"], format: "date" },
            city: { type: ["string", "null"] },
            state: { type: ["string", "null"], pattern: "^[A-Z]{2}$" },
            publicationStatus: filter.publicationStatus,
            reason: { type: "string", minLength: 3, maxLength: 500 },
          },
          ["reason"],
        ),
      ),
    },
    async (req, reply) => {
      const id = (req.params as any).id,
        body = req.body as any;
      const current = await prisma.event.findUnique({ where: { id } });
      if (!current) return reply.code(404).send({ error: "event_not_found" });
      const { reason, ...changes } = body;
      if ("date" in changes) changes.date = changes.date ? new Date(changes.date) : null;
      const merged = { ...current, ...changes };
      if (merged.publicationStatus === "published" && (!merged.date || !merged.city?.trim() || !merged.state))
        return reply.code(409).send({ error: "publication_requires_date_city_state" });
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Event" WHERE id=${id} FOR UPDATE`;
        const latest = await tx.event.findUniqueOrThrow({ where: { id } });
        const next = { ...latest, ...changes };
        if (next.publicationStatus === "published" && (!next.date || !next.city?.trim() || !next.state))
          throw Object.assign(new Error("publication_requires_date_city_state"), { statusCode: 409 });
        const event = await tx.event.update({
          where: { id },
          data: {
            ...changes,
            administrativeReview: true,
            ...("publicationStatus" in changes
              ? { publishedAt: changes.publicationStatus === "published" ? (latest.publishedAt ?? new Date()) : null }
              : {}),
          },
        });
        await tx.adminAudit.create({
          data: {
            actorId: req.principal!.id,
            eventId: id,
            action: "review_event",
            details: JSON.parse(
              JSON.stringify({
                reason,
                before: {
                  name: latest.name,
                  date: latest.date,
                  city: latest.city,
                  state: latest.state,
                  publicationStatus: latest.publicationStatus,
                },
                changes,
              }),
            ),
          },
        });
        return { event };
      });
    },
  );
  app.get(
    "/v1/admin/catalog/events/:id/audit",
    { onRequest: requireAdmin, schema: { ...schema(), querystring: object(page) } },
    async (req) => {
      const q = req.query as any;
      return {
        data: await prisma.adminAudit.findMany({
          where: { eventId: (req.params as any).id },
          orderBy: { createdAt: "desc" },
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        }),
      };
    },
  );
  app.post(
    "/v1/tasks/:id/retry",
    {
      onRequest: requireAdmin,
      schema: { ...schema(object({ mode: { enum: ["restart", "resume"] } }, ["mode"])), headers },
    },
    async (req, reply) => {
      const old = await prisma.collectionTask.findUnique({ where: { id: (req.params as any).id } });
      if (!old) return reply.code(404).send({ error: "task_not_found" });
      if (!["failed", "partial"].includes(old.status))
        return reply.code(409).send({ error: "only_failed_or_partial_tasks_can_retry" });
      const mode = (req.body as any).mode;
      const payload = old.payload as any;
      if (mode === "resume" && old.kind !== "catalog-sync")
        return reply.code(409).send({ error: "compatible_checkpoint_unavailable" });
      if (old.kind === "catalog-sync" && mode === "restart")
        return reply.code(409).send({ error: "create_new_sync_for_restart" });
      // New task keeps the original immutable, and its own scoped key prevents duplicate retries.
      try {
        const task = await prisma.$transaction(async (tx) => {
          const key = String(req.headers["idempotency-key"]);
          const prior = await tx.collectionTask.findUnique({
            where: { ownerId_idempotencyKey: { ownerId: req.principal!.id, idempotencyKey: key } },
          });
          if (old.kind === "catalog-sync" && !prior) {
            const sync = await tx.$queryRaw<
              Array<{ status: string }>
            >`SELECT status FROM "CatalogSync" WHERE id=${payload.syncId} FOR UPDATE`;
            if (sync[0]?.status !== "ready") throw new TaskConflict("compatible_checkpoint_unavailable");
            if (
              await tx.collectionTask.count({
                where: {
                  kind: "catalog-sync",
                  status: { in: ["queued", "running"] },
                  payload: { path: ["syncId"], equals: payload.syncId },
                },
              })
            )
              throw new TaskConflict("sync_already_queued");
          }
          const task = await enqueueTask(
            req.principal!.id,
            key,
            old.source,
            old.kind,
            { ...payload, retryOf: old.id, retryMode: mode },
            tx,
          );
          if (old.kind === "export-selection") {
            const artifact = await tx.exportArtifact.findUnique({ where: { taskId: old.id } });
            if (!artifact) throw new TaskConflict("export_artifact_missing");
            await tx.exportArtifact.upsert({
              where: { taskId: task.id },
              update: {},
              create: {
                kind: artifact.kind,
                selection: artifact.selection as any,
                ownerId: req.principal!.id,
                taskId: task.id,
                expiresAt: new Date(task.createdAt.getTime() + 86400000),
              },
            });
          }
          return task;
        });
        return reply.code(202).send(publicTask(task));
      } catch (e) {
        if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
  app.post(
    "/v1/admin/syncs",
    {
      onRequest: requireAdmin,
      schema: {
        ...schema(
          object(
            {
              source: { enum: ["ticketsports", "corridasbr", "openresults"] },
              states: {
                type: "array",
                items: { type: "string", pattern: "^[A-Z]{2}$" },
                minItems: 1,
                maxItems: 27,
                default: ["SC"],
              },
              from: { type: "string", format: "date" },
              to: { type: "string", format: "date" },
              batchSize: { type: "integer", minimum: 1, maximum: 25, default: 5 },
              snapshotLimit: { type: "integer", minimum: 5, maximum: 1000, default: 250 },
            },
            ["source"],
          ),
        ),
        headers,
      },
    },
    async (req, reply) => {
      const body = req.body as any;
      if (body.from && body.to && body.from > body.to) return reply.code(400).send({ error: "invalid_date_range" });
      const key = String(req.headers["idempotency-key"]);
      const syncId = createHash("sha256")
        .update(req.principal!.id + ":" + key)
        .digest("hex");
      try {
        const task = await prisma.$transaction(async (tx) => {
          const item = await enqueueTask(req.principal!.id, key, body.source, "catalog-sync", { syncId, ...body }, tx);
          await tx.catalogSync.upsert({
            where: { id: syncId },
            update: {},
            create: { id: syncId, ownerId: req.principal!.id, source: body.source, options: body },
          });
          return item;
        });
        return reply.code(202).send({ ...publicTask(task), syncId });
      } catch (e) {
        if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
  app.get(
    "/v1/admin/syncs",
    { onRequest: requireAdmin, schema: { ...schema(), querystring: object(page) } },
    async (req) => {
      const q = req.query as any;
      return {
        data: await prisma.catalogSync.findMany({
          skip: (q.page - 1) * q.limit,
          take: q.limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            source: true,
            options: true,
            cursor: true,
            page: true,
            status: true,
            coverage: true,
            discovered: true,
            processed: true,
            updatedAt: true,
          },
        }),
      };
    },
  );
  app.post(
    "/v1/admin/syncs/:id/continue",
    { onRequest: requireAdmin, schema: { ...schema(), headers } },
    async (req, reply) => {
      const sync = await prisma.catalogSync.findUnique({ where: { id: (req.params as any).id } });
      if (!sync) return reply.code(404).send({ error: "sync_not_found" });
      try {
        const task = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "CatalogSync" WHERE id=${sync.id} FOR UPDATE`;
          const prior = await tx.collectionTask.findUnique({
            where: {
              ownerId_idempotencyKey: {
                ownerId: req.principal!.id,
                idempotencyKey: String(req.headers["idempotency-key"]),
              },
            },
          });
          const payload = { ...(sync.options as object), syncId: sync.id };
          if (prior)
            return enqueueTask(
              req.principal!.id,
              String(req.headers["idempotency-key"]),
              sync.source,
              "catalog-sync",
              payload,
              tx,
            );
          const latest = await tx.catalogSync.findUniqueOrThrow({ where: { id: sync.id } });
          if (latest.status !== "ready") throw new TaskConflict("scope_completed_or_limited");
          if (
            await tx.collectionTask.count({
              where: {
                kind: "catalog-sync",
                status: { in: ["queued", "running"] },
                payload: { path: ["syncId"], equals: sync.id },
              },
            })
          )
            throw new TaskConflict("sync_already_queued");
          return enqueueTask(
            req.principal!.id,
            String(req.headers["idempotency-key"]),
            sync.source,
            "catalog-sync",
            payload,
            tx,
          );
        });
        return reply.code(202).send(publicTask(task));
      } catch (e) {
        if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
  app.post(
    "/v1/admin/catalog/events/collect",
    {
      onRequest: requireAdmin,
      schema: {
        ...schema(object({ eventIds: ids, operation: { enum: ["metadata", "results"] } }, ["eventIds", "operation"])),
        headers,
      },
    },
    async (req, reply) => {
      const body = req.body as { eventIds: string[]; operation: string };
      const prepared: Array<{
        eventId: string;
        ref: { sourceType: string; url: string; sourceExternalId: string; sourceId: string };
      }> = [];
      for (const eventId of body.eventIds) {
        const event = await prisma.event.findUnique({ where: { id: eventId }, include: { sourceReferences: true } });
        if (!event) return reply.code(404).send({ error: "event_not_found" });
        const ref = event.sourceReferences.find((r) =>
          body.operation === "results" ? r.sourceType === "openresults" : r.sourceType === event.sourceType,
        );
        if (!ref) return reply.code(409).send({ error: "source_association_required" });
        prepared.push({ eventId, ref });
      }
      try {
        const data = await prisma.$transaction(async (tx) => {
          const data = [];
          for (const { eventId, ref } of prepared) {
            const key = createHash("sha256")
              .update(String(req.headers["idempotency-key"]) + ":" + body.operation + ":" + eventId)
              .digest("hex");
            const kind =
              body.operation === "results" ? "extract" : ref.sourceType === "openresults" ? "inspect" : "check-source";
            const payload = { eventId, url: ref.url, externalId: ref.sourceExternalId, sourceId: ref.sourceId };
            data.push(publicTask(await enqueueTask(req.principal!.id, key, ref.sourceType, kind, payload, tx)));
          }
          return data;
        });
        return reply.code(202).send({ data });
      } catch (e) {
        if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
  app.get(
    "/v1/exports",
    { onRequest: authorize("exports:write"), schema: { ...schema(), querystring: object(page) } },
    async (req) => {
      const q = req.query as any;
      const where = { ownerId: req.principal!.id };
      const [data, total] = await Promise.all([
        prisma.exportArtifact.findMany({
          where,
          skip: (q.page - 1) * q.limit,
          take: q.limit,
          orderBy: { createdAt: "desc" },
          include: { event: { select: { name: true } } },
        }),
        prisma.exportArtifact.count({ where }),
      ]);
      const tasks = await prisma.collectionTask.findMany({
        where: { id: { in: data.map((item) => item.taskId) } },
        select: { id: true, status: true },
      });
      const taskStatus = new Map(tasks.map((task) => [task.id, task.status]));
      return {
        data: data.map((item) => ({
          id: item.id,
          taskId: item.taskId,
          eventId: item.eventId,
          event: item.event,
          kind: item.kind,
          status:
            item.expiresAt < new Date()
              ? "expired"
              : item.status === "completed"
                ? "completed"
                : (taskStatus.get(item.taskId) ?? item.status),
          expiresAt: item.expiresAt,
          createdAt: item.createdAt,
        })),
        pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
      };
    },
  );
  app.post(
    "/v1/exports",
    {
      onRequest: authorize("exports:write"),
      schema: {
        ...schema(
          object(
            {
              kind: { enum: ["catalog-simple", "catalog-full", "results"] },
              eventIds: ids,
              filter: object(filter),
              layout: { enum: ["consolidated", "individual"], default: "consolidated" },
            },
            ["kind"],
          ),
        ),
        headers,
      },
    },
    async (req, reply) => {
      const body = req.body as any;
      if ((body.kind !== "results" || body.filter) && !req.principal!.admin)
        return reply.code(403).send({ error: "admin_required" });
      if ((!body.eventIds && !body.filter) || (body.eventIds && body.filter))
        return reply.code(400).send({ error: "select_ids_or_filter" });
      const payload = {
        kind: body.kind,
        layout: body.layout,
        selection: body.eventIds ? { eventIds: body.eventIds } : { filter: body.filter },
      };
      const previous = await prisma.collectionTask.findUnique({
        where: {
          ownerId_idempotencyKey: {
            ownerId: req.principal!.id,
            idempotencyKey: String(req.headers["idempotency-key"]),
          },
        },
      });
      if (previous) {
        try {
          await enqueueTask(
            req.principal!.id,
            String(req.headers["idempotency-key"]),
            "exports",
            "export-selection",
            payload,
          );
          const artifact = await prisma.exportArtifact.findUniqueOrThrow({ where: { taskId: previous.id } });
          return reply
            .code(202)
            .send({ id: artifact.id, taskId: previous.id, status: artifact.status, expiresAt: artifact.expiresAt });
        } catch (e) {
          if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
          throw e;
        }
      }
      // Snapshot IDs at acceptance, including every page. Hard limit is explicit, never silent truncation.
      const where = body.eventIds ? { id: { in: body.eventIds } } : adminEventFilter(body.filter);
      const events = await prisma.event.findMany({
        where: { AND: [where, ...(req.principal!.admin ? [] : [{ publicationStatus: "published" as const }])] },
        select: { id: true },
        take: 10001,
        orderBy: { id: "asc" },
      });
      if (!events.length) return reply.code(409).send({ error: "empty_selection" });
      if (events.length > 10000) return reply.code(409).send({ error: "selection_exceeds_10000_refine_filter" });
      if (body.eventIds && events.length !== body.eventIds.length)
        return reply.code(404).send({ error: "event_not_found" });
      try {
        const { task, artifact } = await prisma.$transaction(async (tx) => {
          const task = await enqueueTask(
            req.principal!.id,
            String(req.headers["idempotency-key"]),
            "exports",
            "export-selection",
            payload,
            tx,
          );
          const artifact = await tx.exportArtifact.upsert({
            where: { taskId: task.id },
            update: {},
            create: {
              kind: body.kind,
              ownerId: req.principal!.id,
              taskId: task.id,
              selection: {
                eventIds: events.map((e) => e.id),
                layout: body.layout,
                administrative: req.principal!.admin,
              },
              expiresAt: new Date(task.createdAt.getTime() + 86400000),
            },
          });
          return { task, artifact };
        });
        return reply
          .code(202)
          .send({ id: artifact.id, taskId: task.id, status: artifact.status, expiresAt: artifact.expiresAt });
      } catch (e) {
        if (e instanceof TaskConflict) return reply.code(409).send({ error: e.message });
        throw e;
      }
    },
  );
}
