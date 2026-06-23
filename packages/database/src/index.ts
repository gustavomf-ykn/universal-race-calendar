import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { CanonicalRaceEvent, RawSourceExtraction } from "@race-calendar/schemas";

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

export async function saveCanonicalEvent(event: CanonicalRaceEvent): Promise<{
  event: { id: string };
  canonicalEvent: CanonicalRaceEvent;
  duplicateOfEventId: string | null;
}> {
  const duplicate = await prisma.event.findFirst({
    where: {
      canonicalFingerprint: event.canonicalFingerprint,
      publicationStatus: { not: "rejected" },
    },
    orderBy: { createdAt: "asc" },
  });
  const dedupeStatus = duplicate ? "possible_duplicate" : event.dedupeStatus;
  const duplicateOfEventId = duplicate?.id ?? null;
  const publicationStatus = duplicate ? "pending_review" : event.publicationStatus;
  const slug = await uniqueSlug(event.slug);
  const canonicalEvent: CanonicalRaceEvent = {
    ...event,
    slug,
    publicationStatus,
    dedupeStatus,
    duplicateOfEventId,
    publishabilityReasons: duplicate ? [...event.publishabilityReasons, "possible_duplicate"] : event.publishabilityReasons,
  };

  const saved = await prisma.event.create({
    data: {
      id: prefixedId("evt"),
      slug,
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
      publicationStatus,
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
      canonicalFingerprint: canonicalEvent.canonicalFingerprint,
      dedupeStatus,
      duplicateOfEventId,
      warnings: json(canonicalEvent.warnings),
      publishabilityReasons: json(canonicalEvent.publishabilityReasons),
      publishedAt: publicationStatus === "published" ? new Date() : null,
      distances: {
        create: canonicalEvent.distances.map((distance) => ({
          label: distance.label,
          distanceKm: distance.distanceKm,
          modality: distance.modality,
          startTime: distance.startTime,
          elevationGain: distance.elevationGain,
          sourceText: distance.sourceText,
          confidence: distance.confidence,
        })),
      },
      prices: {
        create: canonicalEvent.prices.map((price) => ({
          name: price.name,
          price: price.price,
          currency: price.currency,
          startDate: price.startDate ? new Date(`${price.startDate}T00:00:00.000Z`) : null,
          endDate: price.endDate ? new Date(`${price.endDate}T00:00:00.000Z`) : null,
          status: price.status,
          sourceText: price.sourceText,
          confidence: price.confidence,
        })),
      },
      kits: {
        create: canonicalEvent.kits.map((kit) => ({
          name: kit.name,
          items: json(kit.items),
          price: kit.price,
          sourceText: kit.sourceText,
          confidence: kit.confidence,
        })),
      },
      kitPickups: {
        create: canonicalEvent.kitPickup
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
          : [],
      },
      schedule: {
        create: canonicalEvent.schedule.map((item) => ({
          date: item.date ? new Date(`${item.date}T00:00:00.000Z`) : null,
          time: item.time,
          activity: item.activity,
          location: item.location,
          sourceText: item.sourceText,
          confidence: item.confidence,
        })),
      },
      rules: {
        create: canonicalEvent.rules.map((rule) => ({
          category: rule.category,
          text: rule.text,
          sourceText: rule.sourceText,
          confidence: rule.confidence,
        })),
      },
      images: {
        create: canonicalEvent.images.map((url, sortOrder) => ({ url, sortOrder })),
      },
      versions: {
        create: {
          schemaVersion: process.env.CANONICAL_SCHEMA_VERSION ?? "1.0.0",
          curationVersion: process.env.CURATION_PIPELINE_VERSION ?? "1.0.0",
          snapshot: json(canonicalEvent),
        },
      },
    },
  });

  return { event: saved, canonicalEvent, duplicateOfEventId };
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
