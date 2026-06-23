import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { importTicketSportsEvents, runSourceCheck, type ImportTicketSportsEventsOptions } from "@race-calendar/curation";
import { createSource, dateToIsoDate, getLatestImportRun, getSource, listSources, prisma } from "@race-calendar/database";
import { eventStatusSchema, modalitySchema, publicationStatusSchema, sourceKindSchema } from "@race-calendar/schemas";

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
        include: { distances: true, prices: true },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map((event) => {
        const lowest = event.prices
          .map((price) => price.price)
          .filter((price): price is number => typeof price === "number")
          .sort((a, b) => a - b)[0];
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
          lowestPrice: lowest ?? null,
          currency: event.prices[0]?.currency ?? null,
          registrationUrl: event.registrationUrl,
          officialUrl: event.officialUrl,
          mainImageUrl: event.mainImageUrl,
          sourceType: event.sourceType,
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
    if (quantity != null) importOptions.quantity = quantity;
    if (quickFilter != null) importOptions.quickFilter = quickFilter;
    if (concurrency != null) importOptions.concurrency = concurrency;
    if (delayMs != null) importOptions.delayMs = delayMs;
    if (offset != null) importOptions.offset = offset;
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
    where: { id, publicationStatus: "published" },
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
    source: event.source
      ? {
          id: event.source.id,
          type: event.source.type,
          url: event.source.url,
          adapter: event.source.adapter,
        }
      : null,
    confidence: event.confidence,
    lastUpdatedAt: event.updatedAt.toISOString(),
  };
}

function publicEventsWhere(query: EventListQuery) {
  const where: any = {
    publicationStatus: "published" as const,
  };
  if (query.country) where.country = query.country.toUpperCase();
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

function corsOrigins(): boolean | string[] {
  const value = process.env.CORS_ORIGINS?.trim();
  if (!value || value === "*") return true;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
