import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { CanonicalRaceEvent, CurationJobStatus, CurationStatus, RawSourceExtraction } from "@race-calendar/schemas";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

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

export async function saveCanonicalEvent(event: CanonicalRaceEvent): Promise<{
  event: { id: string };
  canonicalEvent: CanonicalRaceEvent;
  duplicateOfEventId: string | null;
}> {
  const existingBySource =
    event.sourceType && event.sourceExternalId
      ? await prisma.event.findFirst({
          where: {
            sourceType: event.sourceType,
            sourceExternalId: event.sourceExternalId,
          },
        })
      : null;
  const duplicate = await prisma.event.findFirst({
    where: {
      canonicalFingerprint: event.canonicalFingerprint,
      publicationStatus: { not: "rejected" },
      ...(existingBySource ? { id: { not: existingBySource.id } } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
  const dedupeStatus = duplicate ? "possible_duplicate" : event.dedupeStatus;
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
    return { event: saved, canonicalEvent, duplicateOfEventId };
  }

  const saved = await prisma.event.create({
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

  return { event: saved, canonicalEvent, duplicateOfEventId };
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
  return prisma.event.update({
    where: { id: input.eventId },
    data: withoutUndefined({
      curationStatus: input.curationStatus,
      curatedAt: input.curatedAt,
      curationProvider: input.provider,
      curationModel: input.model,
      curationVersion: input.curationVersion,
    }),
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
