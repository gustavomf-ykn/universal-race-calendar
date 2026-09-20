import { randomUUID } from "node:crypto";
import { assertTaskLease } from "./lease.js";
export { setTaskLease } from "./lease.js";
export { enqueueTask, claimTask, heartbeatTask, finishTask, publicTask, TaskConflict, stableJson } from "./tasks.js";
import { PrismaClient } from "@prisma/client";
import type { CanonicalRaceEvent, CurationJobStatus, CurationStatus, RawSourceExtraction } from "@race-calendar/schemas";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

export async function withPostgresAdvisoryLock<T>(key: string, run: () => Promise<T>): Promise<T | null> {
  return prisma.$transaction(
    async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS "acquired"
      `;
      if (!rows[0]?.acquired) return null;
      return run();
    },
    { maxWait: 5_000, timeout: 30 * 60 * 1_000 },
  );
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export type CreateSourceInput = {
  name: string;
  url: string;
  type: "official_page" | "registration_page" | "organizer_page" | "aggregator";
  country?: string | null;
  state?: string | null;
  city?: string | null;
  adapter?: string | null;
  externalId?: string | null;
  metadata?: Record<string, unknown>;
  checkIntervalMinutes?: number | null;
};

export async function createSource(input: CreateSourceInput) {
  return prisma.source.create({
    data: withoutUndefined({
      id: prefixedId("src"),
      name: input.name,
      url: input.url,
      type: input.type,
      country: input.country,
      state: input.state,
      city: input.city,
      adapter: input.adapter,
      externalId: input.externalId,
      metadata: json(input.metadata ?? {}),
      checkIntervalMinutes: input.checkIntervalMinutes,
    }),
  });
}

export async function upsertSourceByAdapterExternalId(input: CreateSourceInput & { adapter: string; externalId: string }) {
  const existing = await prisma.source.findFirst({
    where: {
      adapter: input.adapter,
      externalId: input.externalId,
    },
  });
  if (!existing) return createSource(input);

  return prisma.source.update({
    where: { id: existing.id },
    data: withoutUndefined({
      name: input.name,
      url: input.url,
      type: input.type,
      country: input.country,
      state: input.state,
      city: input.city,
      adapter: input.adapter,
      externalId: input.externalId,
      metadata: json(input.metadata ?? {}),
      checkIntervalMinutes: input.checkIntervalMinutes,
      status: "active",
    }),
  });
}

export async function listSources() {
  return prisma.source.findMany({ orderBy: { createdAt: "desc" } });
}

export async function getSource(id: string) {
  return prisma.source.findUnique({ where: { id } });
}

export async function createExtractionJob(sourceId: string) {
  return prisma.extractionJob.create({
    data: {
      id: prefixedId("job"),
      sourceId,
      status: "pending",
      createdAt: new Date(),
    },
  });
}

export async function saveRawSourceExtraction(raw: RawSourceExtraction) {
  return prisma.rawSourceExtraction.create({
    data: {
      id: prefixedId("raw"),
      sourceId: raw.sourceId,
      sourceType: raw.sourceType,
      sourceExternalId: raw.sourceExternalId,
      url: raw.url,
      contentHash: raw.contentHash,
      title: raw.title,
      importantHtml: raw.importantHtml,
      importantText: raw.importantText,
      rawSourceData: json(raw.rawSourceData),
      extractedLinks: json(raw.extractedLinks),
      adapter: raw.adapter,
      adapterVersion: raw.adapterVersion,
      fetchedAt: new Date(raw.fetchedAt),
    },
  });
}

export type SaveImportRunInput = {
  id: string;
  source: string;
  quickFilter: string;
  status: string;
  requestedQuantity: number;
  offset: number;
  discoveredCount: number;
  processedCount: number;
  publishedEvents: number;
  manualReviewEvents: number;
  unchangedEvents: number;
  failedCount: number;
  failures: Array<{ externalId: string; error: string }>;
  startedAt: string;
  finishedAt: string;
};

export async function saveImportRun(input: SaveImportRunInput) {
  return prisma.importRun.create({
    data: {
      id: input.id,
      source: input.source,
      quickFilter: input.quickFilter,
      status: input.status,
      requestedQuantity: input.requestedQuantity,
      offset: input.offset,
      discoveredCount: input.discoveredCount,
      processedCount: input.processedCount,
      publishedEvents: input.publishedEvents,
      manualReviewEvents: input.manualReviewEvents,
      unchangedEvents: input.unchangedEvents,
      failedCount: input.failedCount,
      failures: json(input.failures),
      startedAt: new Date(input.startedAt),
      finishedAt: new Date(input.finishedAt),
    },
  });
}

export async function getLatestImportRun(source?: string) {
  return prisma.importRun.findFirst(
    withoutUndefined({
      where: source ? { source } : undefined,
      orderBy: { createdAt: "desc" as const },
    }),
  );
}

export async function saveCanonicalEvent(event: CanonicalRaceEvent, options: { contentHash?: string | null } = {}): Promise<{
  event: { id: string };
  canonicalEvent: CanonicalRaceEvent;
  duplicateOfEventId: string | null;
}> {
  const directExisting =
    event.sourceType && event.sourceExternalId
      ? await prisma.event.findFirst({ where: { sourceType: event.sourceType, sourceExternalId: event.sourceExternalId } })
      : null;
  const referenceExisting =
    !directExisting && event.sourceType && event.sourceExternalId
      ? await prisma.eventSourceReference.findUnique({
          where: { sourceType_sourceExternalId: { sourceType: event.sourceType, sourceExternalId: event.sourceExternalId } },
          include: { event: true },
        })
      : null;
  const existingBySource = directExisting ?? referenceExisting?.event ?? null;
  if(existingBySource?.date && event.date && existingBySource.date.getUTCFullYear()!==new Date(event.date).getUTCFullYear()) {
    throw new Error("source_identifier_reused_for_different_edition");
  }
  const crossSourceMatch = existingBySource ? null : await findCanonicalEventMatch(event);
  if (crossSourceMatch?.automatic) {
    const linked = await mergeCrossSourceEvent(crossSourceMatch.event.id, event);
    const role = sourcePriority(event.sourceType) > sourcePriority(crossSourceMatch.event.sourceType) ? "primary" : "supplemental";
    await upsertEventSourceReference(linked.event.id, event, role, options.contentHash);
    return linked;
  }
  const duplicate = crossSourceMatch?.event ?? null;
  const dedupeStatus = duplicate ? "needs_review" : event.dedupeStatus;
  const duplicateOfEventId = duplicate?.id ?? null;
  const publicationStatus = duplicate ? "pending_review" : event.publicationStatus;
  const slug = existingBySource?.slug ?? (await uniqueSlug(event.slug));
  const canonicalEvent: CanonicalRaceEvent = {
    ...event,
    slug,
    publicationStatus,
    dedupeStatus,
    duplicateOfEventId,
    publishabilityReasons: duplicate
      ? [...new Set([...event.publishabilityReasons, "possible_duplicate"])]
      : event.publishabilityReasons,
  };

  if (existingBySource) {
    const saved = await prisma.$transaction(async (tx) => {
      await assertTaskLease(tx);
      const updated = await tx.event.update({
        where: { id: existingBySource.id },
        data: {
          ...eventScalarData(canonicalEvent),
          publishedAt:
            publicationStatus === "published" ? (existingBySource.publishedAt ?? new Date()) : null,
          versions: {
            create: eventVersionData(canonicalEvent),
          },
        },
      });
      await replaceEventChildren(tx, updated.id, canonicalEvent);
      return updated;
    });
    const role = existingBySource.sourceType === canonicalEvent.sourceType ? "primary" : "supplemental";
    await upsertEventSourceReference(saved.id, canonicalEvent, role, options.contentHash);
    return { event: saved, canonicalEvent, duplicateOfEventId };
  }

  const saved = await prisma.$transaction(async tx=>{
    await assertTaskLease(tx);
    return tx.event.create({
    data: {
      id: prefixedId("evt"),
      ...eventScalarData(canonicalEvent),
      publishedAt: publicationStatus === "published" ? new Date() : null,
      ...eventChildrenCreateData(canonicalEvent),
      versions: {
        create: eventVersionData(canonicalEvent),
      },
    },
  });

  });
  await upsertEventSourceReference(saved.id, canonicalEvent, "primary", options.contentHash);

  return { event: saved, canonicalEvent, duplicateOfEventId };
}

export async function findCanonicalEventMatch(event: CanonicalRaceEvent): Promise<{
  event: { id: string; sourceType: string | null };
  score: number;
  automatic: boolean;
  sameSource: boolean;
} | null> {
  if (event.sourceType && event.sourceExternalId) {
    const sameSource = await prisma.event.findFirst({
      where: {
        OR: [
          { sourceType: event.sourceType, sourceExternalId: event.sourceExternalId },
          { sourceReferences: { some: { sourceType: event.sourceType, sourceExternalId: event.sourceExternalId } } },
        ],
      },
      select: { id: true, sourceType: true },
    });
    if (sameSource) return { event: sameSource, score: 1, automatic: true, sameSource: true };
  }
  if (!event.date) return null;
  const editionDate=new Date(`${event.date}T00:00:00.000Z`);
  const ticketSportsId = ticketSportsIdFromEvent(event);
  if (ticketSportsId) {
    const byTicketSportsId = await prisma.event.findMany({
      take: 2,
      where: {
        date: editionDate,
        OR: [
          { sourceType: "ticketsports", sourceExternalId: ticketSportsId },
          { sourceReferences: { some: { sourceType: "ticketsports", sourceExternalId: ticketSportsId } } },
        ],
        publicationStatus: { not: "rejected" },
      },
      select: { id: true, sourceType: true },
    });
    if (byTicketSportsId.length) return { event: byTicketSportsId[0]!, score: 1, automatic: byTicketSportsId.length === 1, sameSource: false };
  }

  const urls = [event.registrationUrl, event.officialUrl, event.sourceUrl].filter((value): value is string => Boolean(value));
  if (urls.length) {
    const byUrl = await prisma.event.findMany({
      take: 2,
      where: {
        date: editionDate,
        publicationStatus: { not: "rejected" },
        OR: [
          { registrationUrl: { in: urls } },
          { officialUrl: { in: urls } },
          { sourceUrl: { in: urls } },
          { sourceReferences: { some: { url: { in: urls } } } },
        ],
      },
      select: { id: true, sourceType: true },
    });
    if (byUrl.length) return { event: byUrl[0]!, score: 1, automatic: byUrl.length === 1, sameSource: false };
  }

  const exact = await prisma.event.findMany({
      take: 2,
    where: {
      canonicalFingerprint: event.canonicalFingerprint,
      date: editionDate,
      publicationStatus: { not: "rejected" },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, sourceType: true },
  });
  if (exact.length) return { event: exact[0]!, score: 1, automatic: exact.length === 1, sameSource: false };
  if (!event.date || !event.city || !event.state) return null;

  const candidates = await prisma.event.findMany({
    where: {
      date: new Date(`${event.date}T00:00:00.000Z`),
      city: { equals: event.city, mode: "insensitive" },
      state: event.state,
      country: "BR",
      publicationStatus: { not: "rejected" },
    },
    select: { id: true, name: true, sourceType: true },
    take: 50,
  });
  const best = candidates
    .map((candidate) => ({ ...candidate, score: tokenSimilarity(candidate.name, event.name) }))
    .sort((left, right) => right.score - left.score)[0];
  if (!best || best.score < 0.8) return null;
  return {
    event: { id: best.id, sourceType: best.sourceType },
    score: best.score,
    automatic: false,
    sameSource: false,
  };
}

async function mergeCrossSourceEvent(
  existingEventId: string,
  incoming: CanonicalRaceEvent,
): Promise<{ event: { id: string }; canonicalEvent: CanonicalRaceEvent; duplicateOfEventId: null }> {
  const existing = await prisma.event.findUnique({
    where: { id: existingEventId },
    include: { distances: true, prices: true, kits: true, kitPickups: true, schedule: true, rules: true, images: true },
  });
  if (!existing) throw new Error(`Matched event not found: ${existingEventId}`);
  const promoteIncoming = sourcePriority(incoming.sourceType) > sourcePriority(existing.sourceType);
  const canonicalEvent: CanonicalRaceEvent = promoteIncoming
    ? {
        ...incoming,
        slug: existing.slug,
        description: incoming.description ?? existing.description,
        date: incoming.date ?? dateToIsoDate(existing.date),
        startTime: incoming.startTime ?? existing.startTime,
        endTime: incoming.endTime ?? existing.endTime,
        city: incoming.city ?? existing.city,
        state: incoming.state ?? existing.state,
        country: incoming.country ?? existing.country,
        locationName: incoming.locationName ?? existing.locationName,
        address: incoming.address ?? existing.address,
        latitude: incoming.latitude ?? existing.latitude,
        longitude: incoming.longitude ?? existing.longitude,
        registrationUrl: incoming.registrationUrl ?? existing.registrationUrl,
        officialUrl: incoming.officialUrl ?? existing.officialUrl,
        regulationUrl: incoming.regulationUrl ?? existing.regulationUrl,
        organizerName: incoming.organizerName ?? existing.organizerName,
        organizerUrl: incoming.organizerUrl ?? existing.organizerUrl,
        mainImageUrl: incoming.mainImageUrl ?? existing.mainImageUrl,
        publicationStatus:
          existing.publicationStatus === "published" && incoming.publicationStatus === "pending_review"
            ? "published"
            : incoming.publicationStatus,
        confidence: Math.max(existing.confidence, incoming.confidence),
        canonicalFingerprint: incoming.date && incoming.city && incoming.state ? incoming.canonicalFingerprint : existing.canonicalFingerprint,
        warnings: [...new Set([...jsonArray(existing.warnings), ...incoming.warnings])],
        publishabilityReasons: incoming.publicationStatus === "published" ? incoming.publishabilityReasons : jsonArray(existing.publishabilityReasons),
        distances: incoming.distances.length ? incoming.distances : existing.distances,
        prices: incoming.prices.length ? incoming.prices : existingPrices(existing.prices),
        kits: incoming.kits.length ? incoming.kits : existingKits(existing.kits),
        schedule: incoming.schedule.length ? incoming.schedule : existingSchedule(existing.schedule),
        rules: incoming.rules.length ? incoming.rules : existingRules(existing.rules),
        kitPickup: incoming.kitPickup ?? existingKitPickup(existing.kitPickups[0]),
        images: incoming.images.length ? incoming.images : existing.images.map((image) => image.url),
        duplicateOfEventId: null,
        dedupeStatus: "unique",
      }
    : {
        ...incoming,
        slug: existing.slug,
        name: existing.name,
        description: existing.description ?? incoming.description,
        date: dateToIsoDate(existing.date) ?? incoming.date,
        startTime: existing.startTime ?? incoming.startTime,
        endTime: existing.endTime ?? incoming.endTime,
        city: existing.city ?? incoming.city,
        state: existing.state ?? incoming.state,
        country: existing.country ?? incoming.country,
        locationName: existing.locationName ?? incoming.locationName,
        address: existing.address ?? incoming.address,
        latitude: existing.latitude ?? incoming.latitude,
        longitude: existing.longitude ?? incoming.longitude,
        modality: existing.modality,
        eventStatus: existing.eventStatus,
        publicationStatus: existing.publicationStatus,
        registrationUrl: existing.registrationUrl ?? incoming.registrationUrl,
        officialUrl: existing.officialUrl ?? incoming.officialUrl,
        regulationUrl: existing.regulationUrl ?? incoming.regulationUrl,
        organizerName: existing.organizerName ?? incoming.organizerName,
        organizerUrl: existing.organizerUrl ?? incoming.organizerUrl,
        mainImageUrl: existing.mainImageUrl ?? incoming.mainImageUrl,
        sourceId: existing.sourceId,
        sourceType: existing.sourceType,
        sourceExternalId: existing.sourceExternalId,
        sourceUrl: existing.sourceUrl,
        confidence: Math.max(existing.confidence, incoming.confidence),
        curationStatus: existing.curationStatus ?? incoming.curationStatus,
        curatedAt: existing.curatedAt?.toISOString() ?? incoming.curatedAt,
        curationProvider: existing.curationProvider ?? incoming.curationProvider,
        curationModel: existing.curationModel ?? incoming.curationModel,
        curationVersion: existing.curationVersion ?? incoming.curationVersion,
        canonicalFingerprint: existing.canonicalFingerprint,
        duplicateOfEventId: null,
        dedupeStatus: "unique",
        warnings: jsonArray(existing.warnings),
        publishabilityReasons: jsonArray(existing.publishabilityReasons),
        distances: existing.distances.length ? existing.distances : incoming.distances,
        prices: existing.prices.length ? existingPrices(existing.prices) : incoming.prices,
        kits: existing.kits.length ? existingKits(existing.kits) : incoming.kits,
        schedule: existing.schedule.length ? existingSchedule(existing.schedule) : incoming.schedule,
        rules: existing.rules.length ? existingRules(existing.rules) : incoming.rules,
        kitPickup: existing.kitPickups[0] ? existingKitPickup(existing.kitPickups[0]) : incoming.kitPickup,
        images: existing.images.length ? existing.images.map((image) => image.url) : incoming.images,
      };

  const updated = await prisma.$transaction(async (tx) => {
    await assertTaskLease(tx);
    if (promoteIncoming) {
      const row = await tx.event.update({
        where: { id: existing.id },
        data: {
          ...eventScalarData(canonicalEvent),
          publishedAt: canonicalEvent.publicationStatus === "published" ? (existing.publishedAt ?? new Date()) : null,
          versions: { create: eventVersionData(canonicalEvent) },
        },
      });
      await replaceEventChildren(tx, existing.id, canonicalEvent);
      await tx.eventSourceReference.updateMany({ where: { eventId: existing.id }, data: { role: "supplemental" } });
      return row;
    }

    const row = await tx.event.update({
      where: { id: existing.id },
      data: {
        description: existing.description ?? incoming.description,
        startTime: existing.startTime ?? incoming.startTime,
        endTime: existing.endTime ?? incoming.endTime,
        city: existing.city ?? incoming.city,
        state: existing.state ?? incoming.state,
        country: existing.country ?? incoming.country,
        locationName: existing.locationName ?? incoming.locationName,
        address: existing.address ?? incoming.address,
        latitude: existing.latitude ?? incoming.latitude,
        longitude: existing.longitude ?? incoming.longitude,
        registrationUrl: existing.registrationUrl ?? incoming.registrationUrl,
        officialUrl: existing.officialUrl ?? incoming.officialUrl,
        regulationUrl: existing.regulationUrl ?? incoming.regulationUrl,
        organizerName: existing.organizerName ?? incoming.organizerName,
        organizerUrl: existing.organizerUrl ?? incoming.organizerUrl,
        mainImageUrl: existing.mainImageUrl ?? incoming.mainImageUrl,
        versions: { create: eventVersionData(canonicalEvent) },
      },
    });
    if (!existing.distances.length && incoming.distances.length) {
      await tx.eventDistance.createMany({ data: distanceCreateData(incoming).map((item) => ({ ...item, eventId: existing.id })) });
    }
    if (!existing.prices.length && incoming.prices.length) {
      await tx.eventPrice.createMany({ data: priceCreateData(incoming).map((item) => ({ ...item, eventId: existing.id })) });
    }
    if (!existing.kits.length && incoming.kits.length) {
      await tx.eventKit.createMany({ data: kitCreateData(incoming).map((item) => ({ ...item, eventId: existing.id })) });
    }
    if (!existing.kitPickups.length && incoming.kitPickup) {
      await tx.eventKitPickup.createMany({ data: kitPickupCreateData(incoming).map((item) => ({ ...item, eventId: existing.id })) });
    }
    if (!existing.schedule.length && incoming.schedule.length) {
      await tx.eventSchedule.createMany({ data: scheduleCreateData(incoming).map((item) => ({ ...item, eventId: existing.id })) });
    }
    if (!existing.rules.length && incoming.rules.length) {
      await tx.eventRule.createMany({ data: ruleCreateData(incoming).map((item) => ({ ...item, eventId: existing.id })) });
    }
    if (!existing.images.length && incoming.images.length) {
      await tx.eventImage.createMany({ data: incoming.images.map((url, index) => ({ eventId: existing.id, url, sortOrder: index })) });
    }
    return row;
  });
  return { event: updated, canonicalEvent, duplicateOfEventId: null };
}

async function upsertEventSourceReference(
  eventId: string,
  event: CanonicalRaceEvent,
  role: "primary" | "supplemental",
  contentHash?: string | null,
) {
  if (!event.sourceId || !event.sourceType || !event.sourceExternalId || !event.sourceUrl) return;
  await prisma.$transaction(async tx => {
    await assertTaskLease(tx);
    await tx.eventSourceReference.upsert({
    where: { sourceType_sourceExternalId: { sourceType: event.sourceType!, sourceExternalId: event.sourceExternalId! } },
    create: {
      id: prefixedId("ref"),
      eventId,
      sourceId: event.sourceId!,
      sourceType: event.sourceType!,
      sourceExternalId: event.sourceExternalId!,
      url: event.sourceUrl!,
      role,
      priority: sourcePriority(event.sourceType!),
      contentHash: contentHash ?? null,
      lastSeenAt: new Date(),
    },
    update: {
      eventId,
      sourceId: event.sourceId!,
      url: event.sourceUrl!,
      role,
      priority: sourcePriority(event.sourceType!),
      ...(contentHash ? { contentHash } : {}),
      lastSeenAt: new Date(),
    },
    });
  });
}

function eventScalarData(canonicalEvent: CanonicalRaceEvent) {
  return withoutUndefined({
    slug: canonicalEvent.slug,
    name: canonicalEvent.name,
    description: canonicalEvent.description,
    date: canonicalEvent.date ? new Date(`${canonicalEvent.date}T00:00:00.000Z`) : null,
    startTime: canonicalEvent.startTime,
    endTime: canonicalEvent.endTime,
    city: canonicalEvent.city,
    state: canonicalEvent.state,
    country: canonicalEvent.country,
    locationName: canonicalEvent.locationName,
    address: canonicalEvent.address,
    latitude: canonicalEvent.latitude,
    longitude: canonicalEvent.longitude,
    modality: canonicalEvent.modality,
    eventStatus: canonicalEvent.eventStatus,
    publicationStatus: canonicalEvent.publicationStatus,
    registrationUrl: canonicalEvent.registrationUrl,
    officialUrl: canonicalEvent.officialUrl,
    regulationUrl: canonicalEvent.regulationUrl,
    organizerName: canonicalEvent.organizerName,
    organizerUrl: canonicalEvent.organizerUrl,
    mainImageUrl: canonicalEvent.mainImageUrl,
    sourceId: canonicalEvent.sourceId,
    sourceType: canonicalEvent.sourceType,
    sourceExternalId: canonicalEvent.sourceExternalId,
    sourceUrl: canonicalEvent.sourceUrl,
    confidence: canonicalEvent.confidence,
    curationStatus: canonicalEvent.curationStatus,
    curatedAt: canonicalEvent.curatedAt ? new Date(canonicalEvent.curatedAt) : undefined,
    curationProvider: canonicalEvent.curationProvider,
    curationModel: canonicalEvent.curationModel,
    curationVersion: canonicalEvent.curationVersion,
    canonicalFingerprint: canonicalEvent.canonicalFingerprint,
    dedupeStatus: canonicalEvent.dedupeStatus,
    duplicateOfEventId: canonicalEvent.duplicateOfEventId,
    warnings: json(canonicalEvent.warnings),
    publishabilityReasons: json(canonicalEvent.publishabilityReasons),
  });
}

function eventChildrenCreateData(canonicalEvent: CanonicalRaceEvent) {
  return {
    distances: {
      create: distanceCreateData(canonicalEvent),
    },
    prices: {
      create: priceCreateData(canonicalEvent),
    },
    kits: {
      create: kitCreateData(canonicalEvent),
    },
    kitPickups: {
      create: kitPickupCreateData(canonicalEvent),
    },
    schedule: {
      create: scheduleCreateData(canonicalEvent),
    },
    rules: {
      create: ruleCreateData(canonicalEvent),
    },
    images: {
      create: imageCreateData(canonicalEvent),
    },
  };
}

async function replaceEventChildren(tx: any, eventId: string, canonicalEvent: CanonicalRaceEvent) {
  await tx.eventDistance.deleteMany({ where: { eventId } });
  await tx.eventPrice.deleteMany({ where: { eventId } });
  await tx.eventKit.deleteMany({ where: { eventId } });
  await tx.eventKitPickup.deleteMany({ where: { eventId } });
  await tx.eventSchedule.deleteMany({ where: { eventId } });
  await tx.eventRule.deleteMany({ where: { eventId } });
  await tx.eventImage.deleteMany({ where: { eventId } });

  await createManyIfAny(tx.eventDistance, distanceCreateData(canonicalEvent).map((item) => ({ ...item, eventId })));
  await createManyIfAny(tx.eventPrice, priceCreateData(canonicalEvent).map((item) => ({ ...item, eventId })));
  await createManyIfAny(tx.eventKit, kitCreateData(canonicalEvent).map((item) => ({ ...item, eventId })));
  await createManyIfAny(tx.eventKitPickup, kitPickupCreateData(canonicalEvent).map((item) => ({ ...item, eventId })));
  await createManyIfAny(tx.eventSchedule, scheduleCreateData(canonicalEvent).map((item) => ({ ...item, eventId })));
  await createManyIfAny(tx.eventRule, ruleCreateData(canonicalEvent).map((item) => ({ ...item, eventId })));
  await createManyIfAny(tx.eventImage, imageCreateData(canonicalEvent).map((item) => ({ ...item, eventId })));
}

async function createManyIfAny(model: { createMany: (input: { data: unknown[] }) => Promise<unknown> }, data: unknown[]) {
  if (data.length) await model.createMany({ data });
}

function distanceCreateData(canonicalEvent: CanonicalRaceEvent) {
  return canonicalEvent.distances.map((distance) => ({
    label: distance.label,
    distanceKm: distance.distanceKm,
    modality: distance.modality,
    startTime: distance.startTime,
    elevationGain: distance.elevationGain,
    sourceText: distance.sourceText,
    confidence: distance.confidence,
  }));
}

function priceCreateData(canonicalEvent: CanonicalRaceEvent) {
  return canonicalEvent.prices.map((price) => ({
    name: price.name,
    price: price.price,
    currency: price.currency,
    startDate: price.startDate ? new Date(`${price.startDate}T00:00:00.000Z`) : null,
    endDate: price.endDate ? new Date(`${price.endDate}T00:00:00.000Z`) : null,
    status: price.status,
    isCurrent: price.isCurrent,
    sourceText: price.sourceText,
    confidence: price.confidence,
  }));
}

function kitCreateData(canonicalEvent: CanonicalRaceEvent) {
  return canonicalEvent.kits.map((kit) => ({
    name: kit.name,
    items: json(kit.items),
    price: kit.price,
    sourceText: kit.sourceText,
    confidence: kit.confidence,
  }));
}

function kitPickupCreateData(canonicalEvent: CanonicalRaceEvent) {
  return canonicalEvent.kitPickup
    ? [
        {
          location: canonicalEvent.kitPickup.location,
          address: canonicalEvent.kitPickup.address,
          date: canonicalEvent.kitPickup.date ? new Date(`${canonicalEvent.kitPickup.date}T00:00:00.000Z`) : null,
          startTime: canonicalEvent.kitPickup.startTime,
          endTime: canonicalEvent.kitPickup.endTime,
          requiredDocuments: json(canonicalEvent.kitPickup.requiredDocuments),
          sourceText: canonicalEvent.kitPickup.sourceText,
          confidence: canonicalEvent.kitPickup.confidence,
        },
      ]
    : [];
}

function scheduleCreateData(canonicalEvent: CanonicalRaceEvent) {
  return canonicalEvent.schedule.map((item) => ({
    date: item.date ? new Date(`${item.date}T00:00:00.000Z`) : null,
    time: item.time,
    activity: item.activity,
    location: item.location,
    sourceText: item.sourceText,
    confidence: item.confidence,
  }));
}

function ruleCreateData(canonicalEvent: CanonicalRaceEvent) {
  return canonicalEvent.rules.map((rule) => ({
    category: rule.category,
    text: rule.text,
    sourceText: rule.sourceText,
    confidence: rule.confidence,
  }));
}

function imageCreateData(canonicalEvent: CanonicalRaceEvent) {
  return canonicalEvent.images.map((url, sortOrder) => ({ url, sortOrder }));
}

function eventVersionData(canonicalEvent: CanonicalRaceEvent) {
  return {
    schemaVersion: process.env.CANONICAL_SCHEMA_VERSION ?? "1.0.0",
    curationVersion: canonicalEvent.curationVersion ?? process.env.CURATION_PIPELINE_VERSION ?? "1.2.0",
    snapshot: json(canonicalEvent),
  };
}

export async function completeExtractionJob(input: {
  jobId: string;
  eventId?: string | null;
  provider?: string | null;
  model?: string | null;
  adapter?: string | null;
  adapterVersion?: string | null;
  schemaVersion?: string | null;
  curationVersion?: string | null;
  inputHash?: string | null;
  status: "success" | "validation_failed" | "provider_failed" | "manual_review";
  rawInput?: unknown;
  rawOutput?: unknown;
  validatedJson?: unknown;
  normalizedJson?: unknown;
  confidence?: number | null;
  warnings?: string[];
  reasons?: string[];
  errorMessage?: string | null;
}) {
  const data = withoutUndefined({
    eventId: input.eventId ?? null,
    provider: input.provider,
    model: input.model,
    adapter: input.adapter,
    adapterVersion: input.adapterVersion,
    schemaVersion: input.schemaVersion,
    curationVersion: input.curationVersion,
    inputHash: input.inputHash,
    status: input.status,
    rawInput: jsonOrUndefined(input.rawInput),
    rawOutput: jsonOrUndefined(input.rawOutput),
    validatedJson: jsonOrUndefined(input.validatedJson),
    normalizedJson: jsonOrUndefined(input.normalizedJson),
    confidence: input.confidence,
    warnings: json(input.warnings ?? []),
    reasons: json(input.reasons ?? []),
    errorMessage: input.errorMessage,
    startedAt: new Date(),
    finishedAt: new Date(),
  });

  return prisma.extractionJob.update({
    where: { id: input.jobId },
    data,
  });
}

export type SaveCurationJobInput = {
  id?: string;
  eventId?: string | null | undefined;
  rawSourceExtractionId?: string | null | undefined;
  provider: string;
  model: string;
  status: CurationJobStatus;
  contentHash: string;
  schemaVersion: string;
  curationVersion: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  validatedJson?: unknown;
  normalizedJson?: unknown;
  appliedChanges?: unknown;
  warnings?: string[];
  confidence?: number | null;
  isDryRun?: boolean;
  errorMessage?: string | null;
  finishedAt?: Date | null;
};

export async function saveCurationJob(input: SaveCurationJobInput) {
  return prisma.curationJob.create({
    data: withoutUndefined({
      id: input.id ?? prefixedId("cur"),
      eventId: input.eventId ?? null,
      rawSourceExtractionId: input.rawSourceExtractionId ?? null,
      provider: input.provider,
      model: input.model,
      status: input.status,
      contentHash: input.contentHash,
      schemaVersion: input.schemaVersion,
      curationVersion: input.curationVersion,
      rawInput: jsonOrUndefined(input.rawInput),
      rawOutput: jsonOrUndefined(input.rawOutput),
      validatedJson: jsonOrUndefined(input.validatedJson),
      normalizedJson: jsonOrUndefined(input.normalizedJson),
      appliedChanges: jsonOrUndefined(input.appliedChanges),
      warnings: json(input.warnings ?? []),
      confidence: input.confidence,
      isDryRun: input.isDryRun ?? false,
      errorMessage: input.errorMessage,
      finishedAt: input.finishedAt ?? new Date(),
    }),
  });
}

export async function findSuccessfulCurationJob(input: {
  provider: string;
  model: string;
  contentHash: string;
  schemaVersion: string;
  curationVersion: string;
}) {
  return prisma.curationJob.findFirst({
    where: {
      provider: input.provider,
      model: input.model,
      contentHash: input.contentHash,
      schemaVersion: input.schemaVersion,
      curationVersion: input.curationVersion,
      status: "success",
      isDryRun: false,
    },
    orderBy: { finishedAt: "desc" },
  });
}

export async function updateEventCurationMetadata(input: {
  eventId: string;
  curationStatus: CurationStatus;
  curatedAt?: Date | null;
  provider?: string | null;
  model?: string | null;
  curationVersion?: string | null;
}) {
  return prisma.$transaction(async tx => {
    await assertTaskLease(tx);
    return tx.event.update({
    where: { id: input.eventId },
    data: withoutUndefined({
      curationStatus: input.curationStatus,
      curatedAt: input.curatedAt,
      curationProvider: input.provider,
      curationModel: input.model,
      curationVersion: input.curationVersion,
    }),
    });
  });
}

export async function getLatestRawExtractionForEvent(eventId: string) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event?.sourceId) return null;
  return prisma.rawSourceExtraction.findFirst({
    where: { sourceId: event.sourceId },
    orderBy: { createdAt: "desc" },
  });
}

export async function listEventsForCuration(input: { only?: string; limit: number }) {
  const where =
    input.only === "published"
      ? { publicationStatus: "published" as const }
      : input.only === "pending_review"
        ? { publicationStatus: "pending_review" as const }
        : input.only === "failed"
          ? { curationStatus: "failed" as const }
          : input.only === "not_curated"
            ? { curationStatus: "not_curated" as const }
            : {};
  return prisma.event.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(input.limit, 1), 100),
  });
}

export async function getCurationSummary() {
  const [eventsByStatus, jobsByStatus, latestJobs] = await Promise.all([
    prisma.event.groupBy({ by: ["curationStatus"], _count: { _all: true } }),
    prisma.curationJob.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.curationJob.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  return {
    eventsByStatus: Object.fromEntries(eventsByStatus.map((row) => [row.curationStatus, row._count._all])),
    jobsByStatus: Object.fromEntries(jobsByStatus.map((row) => [row.status, row._count._all])),
    latestJobs,
  };
}

export async function markSourceChecked(sourceId: string, contentHash: string, success: boolean) {
  return prisma.source.update({
    where: { id: sourceId },
    data: withoutUndefined({
      status: success ? "active" : "error",
      lastHash: contentHash,
      lastCheckedAt: new Date(),
      lastSuccessAt: success ? new Date() : undefined,
    }),
  });
}

export async function markSourceFailed(sourceId: string) {
  return prisma.source.update({
    where: { id: sourceId },
    data: {
      status: "error",
      lastCheckedAt: new Date(),
    },
  });
}

export function dateToIsoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function sourcePriority(sourceType: string | null | undefined): number {
  if (sourceType === "ticketsports") return 100;
  if (sourceType === "official") return 80;
  if (sourceType === "corridasbr") return 50;
  return 10;
}

function existingPrices(prices: any[]): CanonicalRaceEvent["prices"] {
  return prices.map((price) => ({
    name: price.name,
    price: price.price,
    currency: price.currency,
    startDate: dateToIsoDate(price.startDate),
    endDate: dateToIsoDate(price.endDate),
    status: price.status,
    isCurrent: price.isCurrent,
    sourceText: price.sourceText,
    confidence: price.confidence,
  }));
}

function existingKits(kits: any[]): CanonicalRaceEvent["kits"] {
  return kits.map((kit) => ({
    name: kit.name,
    items: jsonArray(kit.items),
    price: kit.price,
    sourceText: kit.sourceText,
    confidence: kit.confidence,
  }));
}

function existingSchedule(schedule: any[]): CanonicalRaceEvent["schedule"] {
  return schedule.map((item) => ({
    date: dateToIsoDate(item.date),
    time: item.time,
    activity: item.activity,
    location: item.location,
    sourceText: item.sourceText,
    confidence: item.confidence,
  }));
}

function existingRules(rules: any[]): CanonicalRaceEvent["rules"] {
  return rules.map((rule) => ({
    category: rule.category,
    text: rule.text,
    sourceText: rule.sourceText,
    confidence: rule.confidence,
  }));
}

function existingKitPickup(pickup: any | undefined): CanonicalRaceEvent["kitPickup"] {
  if (!pickup) return null;
  return {
    location: pickup.location,
    address: pickup.address,
    date: dateToIsoDate(pickup.date),
    startTime: pickup.startTime,
    endTime: pickup.endTime,
    requiredDocuments: jsonArray(pickup.requiredDocuments),
    sourceText: pickup.sourceText,
    confidence: pickup.confidence,
  };
}

function ticketSportsIdFromEvent(event: CanonicalRaceEvent): string | null {
  for (const value of [event.registrationUrl, event.officialUrl, event.sourceUrl]) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!parsed.hostname.includes("ticketsports.com.br")) continue;
      const id = parsed.searchParams.get("eventId") ?? parsed.pathname.match(/(\d{3,})(?:\D*)$/)?.[1];
      if (id) return id;
    } catch {
      // Ignore malformed optional URLs.
    }
  }
  return null;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeEventText(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeEventText(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return Number((intersection / union).toFixed(4));
}

function normalizeEventText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(da|de|do|das|dos|e|etapa|edicao)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function uniqueSlug(baseSlug: string): Promise<string> {
  let slug = baseSlug;
  for (let index = 2; await prisma.event.findUnique({ where: { slug } }); index += 1) {
    slug = `${baseSlug}-${index}`;
  }
  return slug;
}

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function json(value: unknown): any {
  return value;
}

function jsonOrUndefined(value: unknown | undefined): any {
  return value;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): any {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
