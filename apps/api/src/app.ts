import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  auditCuration,
  importTicketSportsEvents,
  runAICurationBatch,
  runAICurationForEvent,
  runSourceCheck,
  type ImportTicketSportsEventsOptions,
} from "@race-calendar/curation";
import { createSource, dateToIsoDate, getLatestImportRun, getSource, listSources, prisma } from "@race-calendar/database";
import {
  curationJobStatusSchema,
  dedupeStatusSchema,
  eventStatusSchema,
  modalitySchema,
  publicationStatusSchema,
  sourceKindSchema,
} from "@race-calendar/schemas";

export type BuildAppOptions = {
  importTicketSportsEvents?: (options?: ImportTicketSportsEventsOptions) => ReturnType<typeof importTicketSportsEvents>;
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
  const app = Fastify({ logger: true });
  const runTicketSportsImport = options.importTicketSportsEvents ?? importTicketSportsEvents;
  await app.register(cors, {
    origin: corsOrigins(),
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Universal Race Calendar API",
        version: "0.1.0",
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.get("/health", async () => ({ status: "ok" }));
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
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map((event) => {
        const currentLot = currentPriceLot(event.prices);
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
          distances: event.distances.map((distance) => distance.label),
          distanceDetails: event.distances,
          lowestPrice: lowestPrice(event.prices),
          prices: event.prices.map(serializePublicPrice),
          priceLots: event.prices.map(serializePublicPrice),
          currentLot: currentLot ? serializePublicPrice(currentLot) : null,
          currentPrice: currentLot?.price ?? null,
          currentLotName: currentLot?.name ?? null,
          currency: currentLot?.currency ?? event.prices[0]?.currency ?? null,
          registrationUrl: event.registrationUrl,
          officialUrl: event.officialUrl,
          mainImageUrl: event.mainImageUrl,
          images: event.images.map((image) => image.url),
          kits: event.kits.map(serializePublicKit),
          kitPickup: event.kitPickups[0] ? serializePublicKitPickup(event.kitPickups[0]) : null,
          schedule: event.schedule.map(serializePublicScheduleItem),
          rules: event.rules.map(serializePublicRule),
          sourceType: event.sourceType,
          lastCuratedAt: event.curatedAt?.toISOString() ?? null,
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
    const query = request.query as { lat?: string; lng?: string; radiusKm?: string; from?: string; to?: string };
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
      include: { distances: true, prices: true },
      take: 200,
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
    return { data, pagination: { page: 1, limit: data.length, total: data.length, totalPages: 1 } };
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
    const result = await runSourceCheck(id);
    return reply.code(result.status === "success" ? 200 : 202).send(result);
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
    if (quantity != null) importOptions.quantity = quantity;
    if (quickFilter != null) importOptions.quickFilter = quickFilter;
    if (concurrency != null) importOptions.concurrency = concurrency;
    if (delayMs != null) importOptions.delayMs = delayMs;
    if (offset != null) importOptions.offset = offset;
    if (force != null) importOptions.force = force;
    const result = await runTicketSportsImport(importOptions);
    return reply.code(result.status === "success" ? 200 : 207).send(result);
  });

  app.get("/v1/imports/ticketsports/latest", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const latest = await getLatestImportRun("ticketsports");
    if (!latest) return reply.code(404).send({ error: "import_run_not_found" });
    return serializeImportRun(latest);
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
    const result = await runAICurationForEvent(id, {
      dryRun: optionalBoolean(body.dryRun) ?? false,
      force: optionalBoolean(body.force) ?? false,
    });
    return reply.code(result.status === "success" || result.status === "skipped_cached" ? 200 : 202).send(result);
  });

  app.post("/v1/curation/events/batch", { preHandler: requireInternalApiKey }, async (request, reply) => {
    const body = objectBody(request.body);
    const only = curationOnlyValue(body.only);
    const result = await runAICurationBatch({
      limit: optionalPositiveInt(body.limit) ?? 10,
      only,
      dryRun: optionalBoolean(body.dryRun) ?? false,
      force: optionalBoolean(body.force) ?? false,
    });
    return reply.code(result.status === "success" ? 200 : 207).send(result);
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
    },
  });
  if (!event) return reply.code(404).send({ error: "event_not_found" });
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
    distances: event.distances,
    prices: event.prices,
    kits: event.kits,
    kitPickup: event.kitPickups[0] ?? null,
    schedule: event.schedule,
    rules: event.rules,
    images: event.images.map((image) => image.url),
    currentLot: currentPriceLot(event.prices),
    currentPrice: currentPriceLot(event.prices)?.price ?? null,
    currentLotName: currentPriceLot(event.prices)?.name ?? null,
    currency: currentPriceLot(event.prices)?.currency ?? event.prices[0]?.currency ?? null,
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
  if (query.sourceType) where.sourceType = query.sourceType;
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
  if (query.sourceType) where.sourceType = query.sourceType;
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
  if (sort === "name") return { name: "asc" as const };
  return { date: "asc" as const };
}

async function requireInternalApiKey(request: FastifyRequest, reply: FastifyReply) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) return reply.code(500).send({ error: "internal_api_key_not_configured" });
  const provided = request.headers["x-api-key"];
  if (provided !== expected) return reply.code(401).send({ error: "unauthorized" });
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
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    durationMs: run.finishedAt.getTime() - run.startedAt.getTime(),
    createdAt: run.createdAt.toISOString(),
  };
}

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
  if (current) return current;
  return prices
    .filter((price) => typeof price.price === "number")
    .sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY))[0] ?? null;
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
