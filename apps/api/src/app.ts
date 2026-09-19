import { registerBackend, acceptTask } from "./backend.js";
import { installLegacyContracts } from "./legacy-contracts.js";
import { installCalendarContracts } from "./contracts.js";
import { requireAdmin as requireInternalApiKey } from "./auth.js";
import Fastify, { type FastifyReply, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  auditCuration,
  getCatalogImportRun,
  importCorridasBREvents,
  importTicketSportsEvents,
  type CatalogImportRunInput,
  type ImportCorridasBREventsOptions,
  type ImportTicketSportsEventsOptions,
} from "@race-calendar/curation";
import {
  createSource,
  dateToIsoDate,
  getLatestImportRun,
  getSource,
  listSources,
  prisma,
} from "@race-calendar/database";
import {
  curationJobStatusSchema,
  dedupeStatusSchema,
  eventStatusSchema,
  modalitySchema,
  publicationStatusSchema,
  sourceKindSchema,
} from "@race-calendar/schemas";
import {
  ADAPTER_VERSION_CORRIDASBR,
  ADAPTER_VERSION_TICKETSPORTS,
  CANONICAL_SCHEMA_VERSION,
  CURATION_PIPELINE_VERSION,
} from "@race-calendar/utils";

export type BuildAppOptions = {
  importTicketSportsEvents?: (options?: ImportTicketSportsEventsOptions) => ReturnType<typeof importTicketSportsEvents>;
  importCorridasBREvents?: (options?: ImportCorridasBREventsOptions) => ReturnType<typeof importCorridasBREvents>;
};

type EventListQuery = {
  country?: string | undefined;
  state?: string | undefined;
  city?: string | undefined;
  sourceType?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  distanceMin?: string | undefined;
  distanceMax?: string | undefined;
  modality?: string | undefined;
  status?: string | undefined;
  search?: string | undefined;
  page?: string | undefined;
  limit?: string | undefined;
  sort?: string | undefined;
};

type AdminEventListQuery = EventListQuery & {
  publicationStatus?: string | undefined;
  eventStatus?: string | undefined;
  warnings?: string | undefined;
};



export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.x-api-key", "req.headers.x-client-key"] } });
  void options; // Deprecated constructor injection retained for source compatibility.
  await app.register(cors, {
    origin: corsOrigins(),
  });
  await app.register(swagger, {
    openapi: {
      components: { securitySchemes: { supabaseAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }, clientKey: { type: "apiKey", in: "header", name: "X-Client-Key" }, internalKey: { type: "apiKey", in: "header", name: "X-API-Key" } } },
      info: {
        title: "Universal Race Calendar API",
        version: "2.0.0",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  installCalendarContracts(app);
  installLegacyContracts(app);
  app.setErrorHandler<FastifyError>((error,request,reply)=>{
    const code=error.statusCode??500;
    if(code>=500)request.log.error({code:error.code??"internal_error"},"Request failed; inspect service and database health.");
    return reply.code(code).send({error:code>=500?"internal_error":error.validation?"invalid_request":error.message});
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/version", async () => ({
    status: "ok",
    gitSha: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_SHA ?? "development",
    backendVersion: "2.0.0",
    canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
    curationPipelineVersion: CURATION_PIPELINE_VERSION,
    ticketSportsAdapterVersion: ADAPTER_VERSION_TICKETSPORTS,
    corridasBRAdapterVersion: ADAPTER_VERSION_CORRIDASBR,
  }));
  app.get("/v1/openapi.json", async () => app.swagger());

  app.get("/v1/events", async (request) => {
    const query = request.query as EventListQuery;
    const page = positiveInt(query.page, 1);
    const limit = Math.min(positiveInt(query.limit, 20), 100);
    const where = publicEventsWhere(query);
    const orderBy = eventOrderBy(query.sort);
    const [total, rows] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        include: {
          distances: true,
          prices: true,
          kits: true,
          kitPickups: true,
          schedule: true,
          rules: true,
          images: { orderBy: { sortOrder: "asc" } },
          sourceReferences: { orderBy: { priority: "desc" }, include: { source: true } },
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map((event) => {
        const publicEvent = serializePublicEvent(event);
        return {
          id: event.id,
          slug: event.slug,
          name: event.name,
          date: dateToIsoDate(event.date),
          startTime: event.startTime,
          city: event.city,
          state: event.state,
          country: event.country,
          locationName: event.locationName,
          modality: event.modality,
          eventStatus: event.eventStatus,
          distances: publicEvent.distances.map((distance) => distance.label),
          distanceDetails: publicEvent.distances,
          lowestPrice: lowestPrice(publicEvent.prices),
          prices: publicEvent.prices.map(serializePublicPrice),
          priceLots: publicEvent.prices.map(serializePublicPrice),
          currentLot: publicEvent.currentLot ? serializePublicPrice(publicEvent.currentLot) : null,
          currentPrice: publicEvent.currentLot?.price ?? null,
          currentLotName: publicEvent.currentLot?.name ?? null,
          currency: publicEvent.currentLot?.currency ?? publicEvent.prices[0]?.currency ?? null,
          registrationUrl: event.registrationUrl,
          officialUrl: event.officialUrl,
          mainImageUrl: event.mainImageUrl,
          images: event.images.map((image) => image.url),
          kits: publicEvent.kits.map(serializePublicKit),
          kitPickup: publicEvent.kitPickup ? serializePublicKitPickup(publicEvent.kitPickup) : null,
          schedule: publicEvent.schedule.map(serializePublicScheduleItem),
          rules: publicEvent.rules.map(serializePublicRule),
          display: publicEvent.display,
          sourceType: event.sourceType,
          sources: serializePublicSources(event),
          lastCuratedAt: event.curatedAt?.toISOString() ?? null,
          lastUpdatedAt: event.updatedAt.toISOString(),
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  app.get("/v1/events/slug/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const event = await prisma.event.findUnique({ where: { slug } });
    if (!event) return reply.code(404).send({ error: "event_not_found" });
    return sendEventDetail(event.id, reply);
  });

  app.get("/v1/events/nearby", async (request) => {
    const query = request.query as { lat?: string; lng?: string; radiusKm?: string; from?: string; to?: string; page?: string; limit?: string };
    const lat = Number(query.lat);
    const lng = Number(query.lng);
    const radiusKm = Number(query.radiusKm ?? 50);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
    }
    const rows = await prisma.event.findMany({
      where: {
        ...publicEventsWhere({ from: query.from, to: query.to }),
        latitude: { not: null },
        longitude: { not: null },
      },
      select: { id:true,slug:true,name:true,date:true,city:true,state:true,country:true,latitude:true,longitude:true },

    });
    const data = rows
      .map((event) => ({ event, distanceKm: haversineKm(lat, lng, event.latitude ?? 0, event.longitude ?? 0) }))
      .filter((item) => item.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .map((item) => ({
        id: item.event.id,
        slug: item.event.slug,
        name: item.event.name,
        date: dateToIsoDate(item.event.date),
        city: item.event.city,
        state: item.event.state,
        country: item.event.country,
        distanceKm: Number(item.distanceKm.toFixed(1)),
      }));
    const page=positiveInt(query.page,1),limit=Math.min(positiveInt(query.limit,20),100);
    return { data:data.slice((page-1)*limit,page*limit), pagination: { page,limit,total:data.length,totalPages:Math.ceil(data.length/limit) } };
  });

  app.get("/v1/events/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    return sendEventDetail(id, reply);
  });

  app.get("/v1/sources", { preHandler: requireInternalApiKey }, async () => ({ data: await listSources() }));

  app.post("/v1/sources", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const parsedType = sourceKindSchema.safeParse(body.type);
    if (!parsedType.success) return reply.code(400).send({ error: "invalid_source_type" });
    const url = stringOrNull(body.url);
    if (!url) return reply.code(400).send({ error: "missing_url" });
    if (!isValidUrl(url)) return reply.code(400).send({ error: "invalid_url" });
    const source = await createSource({
      name: stringOrNull(body.name) ?? url,
      url,
      type: parsedType.data,
      country: stringOrNull(body.country),
      state: stringOrNull(body.state),
      city: stringOrNull(body.city),
      adapter: stringOrNull(body.adapter),
      externalId: stringOrNull(body.externalId),
      metadata: objectBody(body.metadata),
      checkIntervalMinutes: typeof body.checkIntervalMinutes === "number" ? body.checkIntervalMinutes : null,
    });
    return reply.code(201).send(source);
  });

  app.post("/v1/sources/:id/check", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = await getSource(id);
    if (!source) return reply.code(404).send({ error: "source_not_found" });
    return acceptTask(request, reply, source.adapter === "corridasbr" ? "corridasbr" : "ticketsports", "check-source", { sourceId: id });
  });

  app.post("/v1/imports/ticketsports/run", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const body = objectBody(request.body);
    const importOptions: ImportTicketSportsEventsOptions = {};
    const quantity = optionalPositiveInt(body.quantity);
    const quickFilter = stringOrNull(body.quickFilter);
    const concurrency = optionalPositiveInt(body.concurrency);
    const delayMs = optionalNonNegativeInt(body.delayMs);
    const offset = optionalNonNegativeInt(body.offset);
    const force = optionalBoolean(body.force);
    const maxDurationMs = optionalPositiveInt(body.maxDurationMs);
    if (quantity != null) importOptions.quantity = quantity;
    if (quickFilter != null) importOptions.quickFilter = quickFilter;
    if (concurrency != null) importOptions.concurrency = concurrency;
    if (delayMs != null) importOptions.delayMs = delayMs;
    if (offset != null) importOptions.offset = offset;
    if (force != null) importOptions.force = force;
    if (maxDurationMs != null) importOptions.maxDurationMs = maxDurationMs;
    return acceptTask(request, reply, "ticketsports", "calendar", { ...importOptions, quantity: Math.min(importOptions.quantity ?? 25, 500), concurrency: 1, delayMs: Math.max(importOptions.delayMs ?? 500, 500) });
  });

  app.get("/v1/imports/ticketsports/latest", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const latest = await getLatestImportRun("ticketsports");
    if (!latest) return reply.code(404).send({ error: "import_run_not_found" });
    return serializeImportRun(latest);
  });

  app.post("/v1/imports/corridasbr/run", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const body = objectBody(request.body);
    const importOptions: ImportCorridasBREventsOptions = {};
    const states = stringArray(body.states).map((state) => state.toUpperCase());
    const quantity = optionalPositiveInt(body.quantity);
    const concurrency = optionalPositiveInt(body.concurrency);
    const delayMs = optionalNonNegativeInt(body.delayMs);
    const offset = optionalNonNegativeInt(body.offset);
    const force = optionalBoolean(body.force);
    const maxDurationMs = optionalPositiveInt(body.maxDurationMs);
    if (states.length) importOptions.states = states;
    if (quantity != null) importOptions.quantity = quantity;
    if (concurrency != null) importOptions.concurrency = concurrency;
    if (delayMs != null) importOptions.delayMs = delayMs;
    if (offset != null) importOptions.offset = offset;
    if (force != null) importOptions.force = force;
    if (maxDurationMs != null) importOptions.maxDurationMs = maxDurationMs;
    return acceptTask(request, reply, "corridasbr", "calendar", { ...importOptions, quantity: Math.min(importOptions.quantity ?? 25, 500), concurrency: 1, delayMs: Math.max(importOptions.delayMs ?? 500, 500) });
  });

  app.get("/v1/imports/corridasbr/latest", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const latest = await getLatestImportRun("corridasbr");
    if (!latest) return reply.code(404).send({ error: "import_run_not_found" });
    return serializeImportRun(latest);
  });

  app.post("/v1/admin/import-runs", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const body = objectBody(request.body);
    const sources = stringArray(body.sources).filter(
      (source): source is "ticketsports" | "corridasbr" => source === "ticketsports" || source === "corridasbr",
    );
    const input: CatalogImportRunInput = {
      mode: body.mode === "apply" ? "apply" : "simulate",
      force: optionalBoolean(body.force) ?? false,
      enrichOfficialPages: optionalBoolean(body.enrichOfficialPages) ?? true,
    };
    if (sources.length) input.sources = sources;
    const states = stringArray(body.states).map((state) => state.toUpperCase());
    if (states.length) input.states = states;
    const from = stringOrNull(body.from);
    const to = stringOrNull(body.to);
    const candidateLimit = optionalPositiveInt(body.candidateLimit);
    if (from) input.from = from;
    if (to) input.to = to;
    if (candidateLimit) input.candidateLimit = candidateLimit;
    return acceptTask(request, reply, "maintenance", "catalog", { ...input, candidateLimit: Math.min(input.candidateLimit ?? 25, 500) });
  });

  app.post("/v1/admin/import-runs/:id/process", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const limit = optionalPositiveInt(objectBody(request.body).limit) ?? 25;
    return acceptTask(request, reply, "maintenance", "catalog-process", { runId: id, limit: Math.min(limit, 25) });
  });

  app.get("/v1/admin/import-runs/:id", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await getCatalogImportRun(id);
    if (!run) return reply.code(404).send({ error: "import_run_not_found" });
    const grouped = await prisma.importCandidate.groupBy({
      by: ["sourceType", "action", "status"],
      where: { importRunId: id },
      _count: { _all: true },
    });
    return { ...serializeCatalogImportRun(run), breakdown: grouped };
  });

  app.get("/v1/admin/import-runs/:id/candidates", { preHandler: requireInternalApiKey }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      sourceType?: string;
      state?: string;
      action?: string;
      status?: string;
      page?: string;
      limit?: string;
    };
    const page = positiveInt(query.page, 1);
    const limit = Math.min(positiveInt(query.limit, 50), 100);
    const where = {
      importRunId: id,
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.state ? { state: query.state.toUpperCase() } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.importCandidate.count({ where }),
      prisma.importCandidate.findMany({ where, orderBy: [{ date: "asc" }, { name: "asc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { data: rows.map(serializeImportCandidate), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  });

  app.get("/v1/extraction-jobs/:id", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.extractionJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return job;
  });

  app.post("/v1/curation/events/:id/run", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = objectBody(request.body);
    return acceptTask(request, reply, "maintenance", "curate-event", { eventId: id,
      dryRun: optionalBoolean(body.dryRun) ?? false,
      force: optionalBoolean(body.force) ?? false,
    });

  });

  app.post("/v1/curation/events/batch", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const body = objectBody(request.body);
    const only = curationOnlyValue(body.only);
    return acceptTask(request, reply, "maintenance", "curate-batch", {
      limit: Math.min(optionalPositiveInt(body.limit) ?? 10, 100),
      only,
      dryRun: optionalBoolean(body.dryRun) ?? false,
      force: optionalBoolean(body.force) ?? false,
    });

  });

  app.get("/v1/curation/jobs/:id", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await prisma.curationJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "curation_job_not_found" });
    return job;
  });

  app.get("/v1/admin/events", { preHandler: requireInternalApiKey }, async (request) => {
    const query = request.query as AdminEventListQuery;
    const page = positiveInt(query.page, 1);
    const limit = Math.min(positiveInt(query.limit, 50), 100);
    const where = adminEventsWhere(query);
    const [total, rows] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        include: {
          distances: true,
          prices: true,
          images: { orderBy: { sortOrder: "asc" } },
          source: true,
          sourceReferences: { orderBy: { priority: "desc" }, include: { source: true } },
        },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map(serializeAdminEventListItem),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  });

  app.get("/v1/admin/events/:id", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        distances: true,
        prices: true,
        kits: true,
        kitPickups: true,
        schedule: true,
        rules: true,
        images: { orderBy: { sortOrder: "asc" } },
        source: true,
        sourceReferences: { orderBy: { priority: "desc" }, include: { source: true } },
        versions: { orderBy: { createdAt: "desc" }, take: 5 },
        curationJobs: { orderBy: { createdAt: "desc" }, take: 10 },
        extractionJobs: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });
    if (!event) return reply.code(404).send({ error: "event_not_found" });
    const latestRawExtraction = event.sourceId
      ? await prisma.rawSourceExtraction.findFirst({
          where: { sourceId: event.sourceId },
          orderBy: { createdAt: "desc" },
        })
      : null;
    return serializeAdminEventDetail(event, latestRawExtraction);
  });

  app.patch("/v1/admin/events/:id/publication-status", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = objectBody(request.body);
    const parsed = publicationStatusSchema.safeParse(body.publicationStatus ?? body.status);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_publication_status" });
    return updateEventPublicationStatus(id, parsed.data, reply);
  });

  app.patch("/v1/admin/events/:id/dedupe-status", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = objectBody(request.body);
    const parsed = dedupeStatusSchema.safeParse(body.dedupeStatus ?? body.status);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_dedupe_status" });
    const duplicateOfEventId = stringOrNull(body.duplicateOfEventId);
    const data: { dedupeStatus: typeof parsed.data; duplicateOfEventId?: string | null } = {
      dedupeStatus: parsed.data,
    };
    if (duplicateOfEventId) data.duplicateOfEventId = duplicateOfEventId;
    if (parsed.data === "unique") data.duplicateOfEventId = null;
    const event = await prisma.event
      .update({
        where: { id },
        data,
        include: { distances: true, prices: true, images: { orderBy: { sortOrder: "asc" } }, source: true },
      })
      .catch(() => null);
    if (!event) return reply.code(404).send({ error: "event_not_found" });
    return serializeAdminEventListItem(event);
  });

  app.post("/v1/admin/events/:id/publish", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return updateEventPublicationStatus(id, "published", reply);
  });

  app.post("/v1/admin/events/:id/hide", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return updateEventPublicationStatus(id, "hidden", reply);
  });

  app.post("/v1/admin/events/:id/reject", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return updateEventPublicationStatus(id, "rejected", reply);
  });

  app.get("/v1/admin/curation/jobs", { preHandler: requireInternalApiKey }, async (request) => {
    const query = request.query as {
      status?: string;
      provider?: string;
      model?: string;
      eventId?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
    };
    const page = positiveInt(query.page, 1);
    const limit = Math.min(positiveInt(query.limit, 50), 100);
    const where = curationJobsWhere(query);
    const [total, rows] = await Promise.all([
      prisma.curationJob.count({ where }),
      prisma.curationJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map(serializeCurationJobListItem),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  });

  app.get("/v1/admin/import-runs", { preHandler: requireInternalApiKey }, async (request) => {
    const query = request.query as { source?: string; status?: string; from?: string; to?: string; page?: string; limit?: string };
    const page = positiveInt(query.page, 1);
    const limit = Math.min(positiveInt(query.limit, 50), 100);
    const where = importRunsWhere(query);
    const [total, rows] = await Promise.all([
      prisma.importRun.count({ where }),
      prisma.importRun.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map(serializeImportRun),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  });

  app.get("/v1/audit/curation-summary", { preHandler: requireInternalApiKey }, async () => auditCuration());

  app.get("/v1/admin/catalog-summary", { preHandler: requireInternalApiKey }, async () => {
    const future = { publicationStatus: "published" as const, country: "BR", date: { gte: startOfToday() } };
    const [total, ticketSports, corridasBRExclusive, bothSources, possibleDuplicates, withBanner, withDistance, withLocation, latestRuns] =
      await Promise.all([
        prisma.event.count({ where: future }),
        prisma.event.count({ where: { ...future, sourceReferences: { some: { sourceType: "ticketsports" } } } }),
        prisma.event.count({
          where: {
            ...future,
            sourceReferences: { some: { sourceType: "corridasbr" }, none: { sourceType: "ticketsports" } },
          },
        }),
        prisma.event.count({
          where: {
            ...future,
            AND: [
              { sourceReferences: { some: { sourceType: "ticketsports" } } },
              { sourceReferences: { some: { sourceType: "corridasbr" } } },
            ],
          },
        }),
        prisma.event.count({ where: { ...future, dedupeStatus: { in: ["possible_duplicate", "needs_review"] } } }),
        prisma.event.count({ where: { ...future, OR: [{ mainImageUrl: { not: null } }, { images: { some: {} } }] } }),
        prisma.event.count({ where: { ...future, distances: { some: {} } } }),
        prisma.event.count({ where: { ...future, city: { not: null }, state: { not: null } } }),
        prisma.importRun.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
      ]);
    return {
      total,
      bySource: { ticketsports: ticketSports, corridasbrExclusive: corridasBRExclusive, bothSources },
      possibleDuplicates,
      coverage: {
        banner: coverage(withBanner, total),
        distance: coverage(withDistance, total),
        location: coverage(withLocation, total),
      },
      latestImports: latestRuns.map(serializeImportRun),
    };
  });

  app.get("/v1/audit/events", { preHandler: requireInternalApiKey }, async (request) => {
    const query = request.query as { publicationStatus?: string; sourceType?: string; page?: string; limit?: string };
    const page = positiveInt(query.page, 1);
    const limit = Math.min(positiveInt(query.limit, 50), 100);
    const parsedPublicationStatus = publicationStatusSchema.safeParse(query.publicationStatus);
    const publicationStatus = parsedPublicationStatus.success ? parsedPublicationStatus.data : "pending_review";
    const where = {
      publicationStatus,
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.event.count({ where }),
      prisma.event.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      data: rows.map((event) => ({
        id: event.id,
        slug: event.slug,
        name: event.name,
        date: dateToIsoDate(event.date),
        city: event.city,
        state: event.state,
        country: event.country,
        locationName: event.locationName,
        address: event.address,
        sourceType: event.sourceType,
        sourceExternalId: event.sourceExternalId,
        eventStatus: event.eventStatus,
        publicationStatus: event.publicationStatus,
        dedupeStatus: event.dedupeStatus,
        duplicateOfEventId: event.duplicateOfEventId,
        confidence: event.confidence,
        warnings: event.warnings,
        publishabilityReasons: event.publishabilityReasons,
        registrationUrl: event.registrationUrl,
        updatedAt: event.updatedAt.toISOString(),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  });

  await registerBackend(app);
  return app;
}

async function sendEventDetail(id: string, reply: FastifyReply) {
  const event = await prisma.event.findFirst({
    where: { id, publicationStatus: "published", country: "BR" },
    include: {
      distances: true,
      prices: true,
      kits: true,
      kitPickups: true,
      schedule: true,
      rules: true,
      images: { orderBy: { sortOrder: "asc" } },
      source: true,
      sourceReferences: { orderBy: { priority: "desc" }, include: { source: true } },
    },
  });
  if (!event) return reply.code(404).send({ error: "event_not_found" });
  const publicEvent = serializePublicEvent(event);
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: event.description,
    date: dateToIsoDate(event.date),
    startTime: event.startTime,
    endTime: event.endTime,
    city: event.city,
    state: event.state,
    country: event.country,
    locationName: event.locationName,
    address: event.address,
    latitude: event.latitude,
    longitude: event.longitude,
    modality: event.modality,
    eventStatus: event.eventStatus,
    registrationUrl: event.registrationUrl,
    officialUrl: event.officialUrl,
    regulationUrl: event.regulationUrl,
    organizerName: event.organizerName,
    organizerUrl: event.organizerUrl,
    mainImageUrl: event.mainImageUrl,
    distances: publicEvent.distances,
    prices: publicEvent.prices.map(serializePublicPrice),
    kits: publicEvent.kits.map(serializePublicKit),
    kitPickup: publicEvent.kitPickup ? serializePublicKitPickup(publicEvent.kitPickup) : null,
    schedule: publicEvent.schedule.map(serializePublicScheduleItem),
    rules: publicEvent.rules.map(serializePublicRule),
    images: event.images.map((image) => image.url),
    currentLot: publicEvent.currentLot ? serializePublicPrice(publicEvent.currentLot) : null,
    currentPrice: publicEvent.currentLot?.price ?? null,
    currentLotName: publicEvent.currentLot?.name ?? null,
    currency: publicEvent.currentLot?.currency ?? publicEvent.prices[0]?.currency ?? null,
    display: publicEvent.display,
    sources: serializePublicSources(event),
    source: event.source
      ? {
          id: event.source.id,
          type: event.source.type,
          url: event.source.url,
          adapter: event.source.adapter,
        }
      : null,
    confidence: event.confidence,
    lastCuratedAt: event.curatedAt?.toISOString() ?? null,
    lastUpdatedAt: event.updatedAt.toISOString(),
  };
}

function serializePublicPrice(price: any) {
  return {
    id: price.id,
    name: price.name,
    price: price.price,
    currency: price.currency,
    startDate: dateToIsoDate(price.startDate),
    endDate: dateToIsoDate(price.endDate),
    status: price.status,
    isCurrent: price.isCurrent,
    confidence: price.confidence,
  };
}

function serializePublicKit(kit: any) {
  return {
    id: kit.id,
    name: kit.name,
    items: Array.isArray(kit.items) ? kit.items : [],
    price: kit.price,
    confidence: kit.confidence,
  };
}

function serializePublicKitPickup(kitPickup: any) {
  return {
    id: kitPickup.id,
    location: kitPickup.location,
    address: kitPickup.address,
    date: dateToIsoDate(kitPickup.date),
    startTime: kitPickup.startTime,
    endTime: kitPickup.endTime,
    requiredDocuments: Array.isArray(kitPickup.requiredDocuments) ? kitPickup.requiredDocuments : [],
    confidence: kitPickup.confidence,
  };
}

function serializePublicScheduleItem(item: any) {
  return {
    id: item.id,
    date: dateToIsoDate(item.date),
    time: item.time,
    activity: item.activity,
    location: item.location,
    confidence: item.confidence,
  };
}

function serializePublicRule(rule: any) {
  return {
    id: rule.id,
    category: rule.category,
    text: rule.text,
    confidence: rule.confidence,
  };
}

function serializeAdminEventListItem(event: any) {
  const currentLot = currentPriceLot(event.prices ?? []);
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    description: event.description,
    date: dateToIsoDate(event.date),
    startTime: event.startTime,
    endTime: event.endTime,
    city: event.city,
    state: event.state,
    country: event.country,
    locationName: event.locationName,
    address: event.address,
    latitude: event.latitude,
    longitude: event.longitude,
    modality: event.modality,
    eventStatus: event.eventStatus,
    publicationStatus: event.publicationStatus,
    registrationUrl: event.registrationUrl,
    officialUrl: event.officialUrl,
    regulationUrl: event.regulationUrl,
    organizerName: event.organizerName,
    organizerUrl: event.organizerUrl,
    mainImageUrl: event.mainImageUrl,
    distances: (event.distances ?? []).map((distance: any) => distance.label ?? distance),
    distanceDetails: event.distances ?? [],
    prices: event.prices ?? [],
    lowestPrice: lowestPrice(event.prices ?? []),
    currentLot,
    currentPrice: currentLot?.price ?? null,
    currentLotName: currentLot?.name ?? null,
    currency: currentLot?.currency ?? event.prices?.[0]?.currency ?? null,
    images: (event.images ?? []).map((image: any) => image.url ?? image),
    sourceType: event.sourceType,
    sourceExternalId: event.sourceExternalId,
    sourceUrl: event.sourceUrl,
    sources: serializePublicSources(event),
    source: event.source
      ? {
          id: event.source.id,
          name: event.source.name,
          type: event.source.type,
          url: event.source.url,
          adapter: event.source.adapter,
          externalId: event.source.externalId,
        }
      : null,
    confidence: event.confidence,
    curationStatus: event.curationStatus,
    curatedAt: event.curatedAt?.toISOString() ?? null,
    curationProvider: event.curationProvider,
    curationModel: event.curationModel,
    curationVersion: event.curationVersion,
    canonicalFingerprint: event.canonicalFingerprint,
    dedupeStatus: event.dedupeStatus,
    duplicateOfEventId: event.duplicateOfEventId,
    warnings: event.warnings,
    publishabilityReasons: event.publishabilityReasons,
    publishedAt: event.publishedAt?.toISOString() ?? null,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    lastCuratedAt: event.curatedAt?.toISOString() ?? null,
    lastUpdatedAt: event.updatedAt.toISOString(),
  };
}

function serializeAdminEventDetail(event: any, latestRawExtraction: any | null) {
  return {
    ...serializeAdminEventListItem(event),
    kits: event.kits ?? [],
    kitPickup: event.kitPickups?.[0] ?? null,
    kitPickups: event.kitPickups ?? [],
    schedule: event.schedule ?? [],
    rules: event.rules ?? [],
    versions: (event.versions ?? []).map((version: any) => ({
      id: version.id,
      schemaVersion: version.schemaVersion,
      curationVersion: version.curationVersion,
      createdAt: version.createdAt.toISOString(),
    })),
    curationJobs: (event.curationJobs ?? []).map(serializeCurationJobListItem),
    extractionJobs: (event.extractionJobs ?? []).map((job: any) => ({
      id: job.id,
      status: job.status,
      provider: job.provider,
      model: job.model,
      adapter: job.adapter,
      adapterVersion: job.adapterVersion,
      schemaVersion: job.schemaVersion,
      curationVersion: job.curationVersion,
      confidence: job.confidence,
      warnings: job.warnings,
      reasons: job.reasons,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
    })),
    latestRawExtraction: latestRawExtraction
      ? {
          id: latestRawExtraction.id,
          adapter: latestRawExtraction.adapter,
          adapterVersion: latestRawExtraction.adapterVersion,
          contentHash: latestRawExtraction.contentHash,
          title: latestRawExtraction.title,
          url: latestRawExtraction.url,
          fetchedAt: latestRawExtraction.fetchedAt.toISOString(),
          createdAt: latestRawExtraction.createdAt.toISOString(),
          rawSourceData: latestRawExtraction.rawSourceData,
          importantText: latestRawExtraction.importantText,
          importantHtml: latestRawExtraction.importantHtml,
          extractedLinks: latestRawExtraction.extractedLinks,
        }
      : null,
  };
}

function adminEventsWhere(query: AdminEventListQuery) {
  const where: any = {};
  const parsedPublicationStatus = publicationStatusSchema.safeParse(query.publicationStatus);
  if (parsedPublicationStatus.success) where.publicationStatus = parsedPublicationStatus.data;
  const parsedEventStatus = eventStatusSchema.safeParse(query.eventStatus ?? query.status);
  if (parsedEventStatus.success) where.eventStatus = parsedEventStatus.data;
  if (query.country) where.country = query.country.toUpperCase();
  if (query.state) where.state = query.state.toUpperCase();
  if (query.city) where.city = { contains: query.city, mode: "insensitive" as const };
  applySourceTypeFilter(where, query.sourceType);
  if (query.search) where.name = { contains: query.search, mode: "insensitive" as const };
  const from = isoDate(query.from);
  const to = isoDate(query.to);
  if (from || to) {
    where.date = {
      gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
      lte: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
    };
  }
  if (query.warnings) {
    where.warnings = { array_contains: [query.warnings] };
  }
  return where;
}

async function updateEventPublicationStatus(id: string, publicationStatus: "draft" | "pending_review" | "published" | "hidden" | "rejected", reply: FastifyReply) {
  const event = await prisma.event
    .update({
      where: { id },
      data: {
        publicationStatus,
        publishedAt: publicationStatus === "published" ? new Date() : null,
      },
      include: { distances: true, prices: true, images: { orderBy: { sortOrder: "asc" } }, source: true },
    })
    .catch(() => null);
  if (!event) return reply.code(404).send({ error: "event_not_found" });
  return serializeAdminEventListItem(event);
}

function curationJobsWhere(query: {
  status?: string;
  provider?: string;
  model?: string;
  eventId?: string;
  from?: string;
  to?: string;
}) {
  const where: any = {};
  const parsedStatus = curationJobStatusSchema.safeParse(query.status);
  if (parsedStatus.success) where.status = parsedStatus.data;
  if (query.provider) where.provider = query.provider;
  if (query.model) where.model = query.model;
  if (query.eventId) where.eventId = query.eventId;
  const from = isoDate(query.from);
  const to = isoDate(query.to);
  if (from || to) {
    where.createdAt = {
      gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
      lte: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
    };
  }
  return where;
}

function importRunsWhere(query: { source?: string; status?: string; from?: string; to?: string }) {
  const where: any = {};
  if (query.source) where.source = query.source;
  if (query.status) where.status = query.status;
  const from = isoDate(query.from);
  const to = isoDate(query.to);
  if (from || to) {
    where.createdAt = {
      gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
      lte: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
    };
  }
  return where;
}

function serializeCurationJobListItem(job: any) {
  return {
    id: job.id,
    eventId: job.eventId,
    rawSourceExtractionId: job.rawSourceExtractionId,
    provider: job.provider,
    model: job.model,
    status: job.status,
    contentHash: job.contentHash,
    schemaVersion: job.schemaVersion,
    curationVersion: job.curationVersion,
    appliedChanges: job.appliedChanges,
    warnings: job.warnings,
    confidence: job.confidence,
    isDryRun: job.isDryRun,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    durationMs: job.finishedAt ? job.finishedAt.getTime() - job.createdAt.getTime() : null,
  };
}

function publicEventsWhere(query: EventListQuery) {
  const where: any = {
    publicationStatus: "published" as const,
    country: query.country && query.country.toUpperCase() !== "BR" ? "__unsupported_country__" : "BR",
  };
  if (query.state) where.state = query.state.toUpperCase();
  if (query.city) where.city = { contains: query.city, mode: "insensitive" as const };
  applySourceTypeFilter(where, query.sourceType);
  const parsedModality = modalitySchema.safeParse(query.modality);
  if (parsedModality.success) where.modality = parsedModality.data;
  const parsedStatus = eventStatusSchema.safeParse(query.status);
  if (parsedStatus.success) where.eventStatus = parsedStatus.data;
  const from = isoDate(query.from);
  const to = isoDate(query.to);
  if (from || to) {
    where.date = {
      gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
      lte: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
    };
  }
  if (query.search) where.name = { contains: query.search, mode: "insensitive" as const };
  const distanceMin = numeric(query.distanceMin);
  const distanceMax = numeric(query.distanceMax);
  if (distanceMin != null || distanceMax != null) {
    where.distances = {
      some: {
        distanceKm: {
          gte: distanceMin ?? undefined,
          lte: distanceMax ?? undefined,
        },
      },
    };
  }
  return where;
}

function eventOrderBy(sort: string | undefined) {
  if (sort === "date_desc") return { date: "desc" as const };
  if (sort === "name" || sort === "name_asc") return { name: "asc" as const };
  return { date: "asc" as const };
}

function applySourceTypeFilter(where: any, value: string | undefined) {
  const sourceTypes = (value ?? "")
    .split(",")
    .map((sourceType) => sourceType.trim().toLowerCase())
    .filter((sourceType) => sourceType === "ticketsports" || sourceType === "corridasbr" || sourceType === "openresults");
  if (!sourceTypes.length) return;
  where.OR = [
    { sourceType: { in: sourceTypes } },
    { sourceReferences: { some: { sourceType: { in: sourceTypes } } } },
  ];
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function numeric(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: string | undefined): string | null {
  if (value === "today") return dateToIsoDate(new Date());
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
    : [];
}

function startOfToday(): Date {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
}

function coverage(count: number, total: number) {
  return { count, percentage: total ? Number(((count / total) * 100).toFixed(1)) : 0 };
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const radius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function toRad(value: number): number {
  return (value * Math.PI) / 180;
}

function serializeImportRun(run: Awaited<ReturnType<typeof getLatestImportRun>>) {
  if (!run) return null;
  return {
    id: run.id,
    source: run.source,
    quickFilter: run.quickFilter,
    status: run.status,
    requestedQuantity: run.requestedQuantity,
    offset: run.offset,
    discoveredCount: run.discoveredCount,
    processedCount: run.processedCount,
    publishedEvents: run.publishedEvents,
    manualReviewEvents: run.manualReviewEvents,
    unchangedEvents: run.unchangedEvents,
    failedCount: run.failedCount,
    failures: run.failures,
    mode: run.mode,
    cursor: run.cursor,
    candidateLimit: run.candidateLimit,
    options: run.options,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    durationMs: run.finishedAt.getTime() - run.startedAt.getTime(),
    createdAt: run.createdAt.toISOString(),
  };
}

function serializeCatalogImportRun(run: NonNullable<Awaited<ReturnType<typeof getCatalogImportRun>>>) {
  return {
    ...serializeImportRun(run),
    candidateCount: run._count.candidates,
    hasMore: run.cursor < run._count.candidates,
  };
}

function serializeImportCandidate(candidate: any) {
  return {
    id: candidate.id,
    importRunId: candidate.importRunId,
    sourceType: candidate.sourceType,
    sourceExternalId: candidate.sourceExternalId,
    sourceUrl: candidate.sourceUrl,
    name: candidate.name,
    date: dateToIsoDate(candidate.date),
    city: candidate.city,
    state: candidate.state,
    status: candidate.status,
    action: candidate.action,
    matchEventId: candidate.matchEventId,
    matchScore: candidate.matchScore,
    proposedEvent: candidate.proposedEvent,
    displayPreview: candidate.displayPreview,
    provenance: candidate.provenance,
    warnings: candidate.warnings,
    errorMessage: candidate.errorMessage,
    createdAt: candidate.createdAt.toISOString(),
    updatedAt: candidate.updatedAt.toISOString(),
  };
}

export function serializePublicEvent(event: any) {
  const distances = sanitizePublicDistances(event.distances ?? []);
  const prices = sanitizePublicPrices(event.prices ?? []);
  const kits = sanitizePublicKits(event.kits ?? []);
  const kitPickup = sanitizePublicKitPickup(event.kitPickups?.[0] ?? event.kitPickup ?? null);
  const schedule = (event.schedule ?? []).filter((item: any) => Number(item.confidence ?? 0) >= 0.5);
  const rules = (event.rules ?? []).filter((rule: any) => Number(rule.confidence ?? 0) >= 0.5);
  const currentLot = currentPriceLot(prices);
  const coverImageUrl = event.mainImageUrl ?? event.images?.[0]?.url ?? event.images?.[0] ?? null;
  const locationLabel = publicLocationLabel(event);
  const actionUrl = event.registrationUrl ?? event.officialUrl ?? event.sourceUrl ?? event.sourceReferences?.[0]?.url ?? null;
  const actionType = event.registrationUrl ? "registration" : event.officialUrl ? "official" : "source";
  const kitSummary = publicKitSummary(kits, kitPickup);

  return {
    distances,
    prices,
    kits,
    kitPickup,
    schedule,
    rules,
    currentLot,
    display: {
      coverImageUrl,
      locationLabel,
      distances: distances.map((distance: any) => distance.label).filter(Boolean),
      currentPrice: currentLot?.price ?? null,
      currentLotName: currentLot?.name ?? null,
      currency: currentLot?.currency ?? prices[0]?.currency ?? null,
      kitSummary,
      registrationUrl: event.registrationUrl ?? event.officialUrl ?? null,
      primaryAction: actionUrl
        ? {
            type: actionType,
            label: actionType === "registration" ? "Inscrever-se" : actionType === "official" ? "Ver informacoes" : "Ver fonte",
            url: actionUrl,
          }
        : null,
      badges: publicBadges({ distances, currentLot, kits, kitPickup }),
    },
  };
}

function serializePublicSources(event: any) {
  const references = Array.isArray(event.sourceReferences) ? event.sourceReferences : [];
  if (references.length) {
    return references.map((reference: any) => ({
      type: reference.sourceType,
      role: reference.role,
      url: reference.url,
      externalId: reference.sourceExternalId,
      updatedAt: reference.updatedAt?.toISOString() ?? null,
    }));
  }
  return event.sourceType ? [{ type: event.sourceType, role: "primary", url: event.sourceUrl }] : [];
}

function sanitizePublicDistances(distances: any[]): any[] {
  return distances
    .filter((distance) => {
      const distanceKm = Number(distance.distanceKm);
      if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 100) return false;
      if (Number(distance.confidence ?? 0) < 0.65) return false;
      const evidence = cleanForPublicPolicy(distance.sourceText ?? distance.label);
      if (!evidence) return false;
      if (/(raio|entrega|domicilio|frete|endereco|idade|anos|horario|retirada)/i.test(evidence)) return false;
      return true;
    })
    .map(serializePublicDistance)
    .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
}

function sanitizePublicPrices(prices: any[]): any[] {
  const seen = new Set<string>();
  const sanitized = prices.flatMap((price) => {
    const value = Number(price.price);
    if (!Number.isFinite(value) || value < 20 || value > 1000) return [];
    if (Number(price.confidence ?? 0) < 0.65) return [];
    const evidence = cleanForPublicPolicy(price.sourceText);
    if (!evidence) return [];
    const hasRegistrationEvidence = /(inscric|lote|valor|preco|a partir|vagas|participacao)/i.test(evidence);
    if (!hasRegistrationEvidence) return [];
    if (/(retirada de kit|entrega de kit|domicilio|frete|estacionamento|doacao|multa)/i.test(evidence) && !/(inscric|lote)/i.test(evidence)) {
      return [];
    }
    const key = `${price.name ?? ""}|${value}|${price.currency ?? "BRL"}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const status = cleanForPublicPolicy(price.status);
    const isClosed = /(sold out|sold_out|closed|ended|expired|encerrado|esgotado)/i.test(status);
    return [{ ...price, isCurrent: price.isCurrent === true && !isClosed }];
  });
  return sanitized;
}

function sanitizePublicKits(kits: any[]): any[] {
  return kits.filter((kit) => Number(kit.confidence ?? 0) >= 0.55 && Array.isArray(kit.items) && kit.items.length > 0);
}

function sanitizePublicKitPickup(kitPickup: any | null): any | null {
  if (!kitPickup || Number(kitPickup.confidence ?? 0) < 0.55) return null;
  if (!(kitPickup.location || kitPickup.address || kitPickup.date || kitPickup.startTime || kitPickup.endTime)) return null;
  return kitPickup;
}

function serializePublicDistance(distance: any) {
  return {
    id: distance.id,
    label: distance.label,
    distanceKm: distance.distanceKm,
    modality: distance.modality,
    startTime: distance.startTime,
    elevationGain: distance.elevationGain,
    confidence: distance.confidence,
  };
}

function publicLocationLabel(event: any): string | null {
  const state = isBrazilianState(event.state) ? String(event.state).toUpperCase() : null;
  const city = isSafePublicCity(event.city) ? String(event.city).trim() : null;
  if (city && state) return `${city}, ${state}`;
  return state;
}

function publicKitSummary(kits: any[], kitPickup: any | null): string | null {
  const items = kits.flatMap((kit) => (Array.isArray(kit.items) ? kit.items : [])).filter(Boolean);
  if (items.length) return items.slice(0, 3).join(", ");
  if (kitPickup) return "Retirada de kit informada";
  return null;
}

function publicBadges(input: { distances: any[]; currentLot: any | null; kits: any[]; kitPickup: any | null }): string[] {
  const badges: string[] = [];
  if (input.distances.length) badges.push(...input.distances.slice(0, 3).map((distance) => distance.label).filter(Boolean));
  if (input.currentLot?.price) badges.push("Inscricoes abertas");
  if (input.kits.length || input.kitPickup) badges.push("Kit informado");
  return badges;
}

function isSafePublicCity(value: unknown): boolean {
  const text = cleanForPublicPolicy(value);
  if (!text || text.length < 2) return false;
  if (/^\d/.test(text)) return false;
  return !/^(av|avenida|rua|rodovia|estrada|praca|parque|shopping|estadio|ginasio|centro|arena|complexo|campus|represa|lagoa|orla|posto|igreja|estacionamento|km)\b/i.test(text);
}

function isBrazilianState(value: unknown): boolean {
  return typeof value === "string" && brazilianStates.has(value.toUpperCase());
}

function cleanForPublicPolicy(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const brazilianStates = new Set([
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
]);

function lowestPrice(prices: Array<{ price: number | null }>): number | null {
  return (
    prices
      .map((price) => price.price)
      .filter((price): price is number => typeof price === "number")
      .sort((a, b) => a - b)[0] ?? null
  );
}

function currentPriceLot<T extends { isCurrent: boolean; price: number | null; currency: string; name: string | null; endDate?: Date | null }>(
  prices: T[],
): T | null {
  const current = prices.find((price) => price.isCurrent);
  return current ?? null;
}

function curationOnlyValue(value: unknown): "not_curated" | "published" | "pending_review" | "failed" | undefined {
  return value === "not_curated" || value === "published" || value === "pending_review" || value === "failed" ? value : undefined;
}

function corsOrigins(): boolean | string[] {
  const value = process.env.CORS_ORIGINS?.trim();
  if (!value || value === "*") return true;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
