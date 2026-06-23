import { createAIProviderFromEnv, type AIProvider } from "@race-calendar/ai";
import {
  completeExtractionJob,
  createExtractionJob,
  getSource,
  markSourceChecked,
  markSourceFailed,
  saveCanonicalEvent,
  saveRawSourceExtraction,
} from "@race-calendar/database";
import {
  canonicalRaceEventSchema,
  type CanonicalRaceEvent,
  type PublicationStatus,
  type RaceEventExtraction,
  type RawSourceExtraction,
} from "@race-calendar/schemas";
import { SourceAdapterRegistry } from "@race-calendar/sources";
import {
  absolutizeUrl,
  CANONICAL_SCHEMA_VERSION,
  cleanText,
  CURATION_PIPELINE_VERSION,
  generateEventFingerprint,
  normalizeDate,
  normalizePrice,
  normalizeTime,
  slugify,
} from "@race-calendar/utils";

export type PublishabilityResult = {
  canPublish: boolean;
  publicationStatus: PublicationStatus;
  reasons: string[];
};

export type CurateSourceExtractionResult = {
  extraction: RaceEventExtraction;
  normalizedEvent: CanonicalRaceEvent;
  publishability: PublishabilityResult;
  schemaVersion: string;
  curationVersion: string;
};

export type SourceCheckJobResult = {
  jobId: string;
  status: "success" | "validation_failed" | "provider_failed" | "manual_review";
  eventId: string | null;
  sourceId: string;
  createdAt: string;
  finishedAt: string | null;
  reasons: string[];
};

export async function runSourceCheck(sourceId: string, registry = new SourceAdapterRegistry()): Promise<SourceCheckJobResult> {
  const source = await getSource(sourceId);
  if (!source) throw new Error(`Source not found: ${sourceId}`);
  const job = await createExtractionJob(source.id);
  const createdAt = job.createdAt.toISOString();

  try {
    const adapter = registry.findForUrl(source.url);
    if (!adapter) throw new Error(`No source adapter can handle URL: ${source.url}`);
    const raw = await adapter.fetchAndExtract({
      sourceId: source.id,
      url: source.url,
      sourceExternalId: source.externalId,
      metadata: (source.metadata as Record<string, unknown> | null) ?? {},
    });
    if (source.lastHash === raw.contentHash) {
      await markSourceChecked(source.id, raw.contentHash, true);
      const completed = await completeExtractionJob({
        jobId: job.id,
        provider: null,
        model: null,
        adapter: raw.adapter,
        adapterVersion: raw.adapterVersion,
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        curationVersion: CURATION_PIPELINE_VERSION,
        inputHash: raw.contentHash,
        status: "success",
        rawInput: raw,
        reasons: ["unchanged_content"],
      });
      return {
        jobId: completed.id,
        status: completed.status as SourceCheckJobResult["status"],
        eventId: null,
        sourceId: source.id,
        createdAt,
        finishedAt: completed.finishedAt?.toISOString() ?? null,
        reasons: ["unchanged_content"],
      };
    }

    await saveRawSourceExtraction(raw);

    const provider = createAIProviderFromEnv();
    const result = await curateSourceExtraction(raw, provider);
    const saved = await saveCanonicalEvent(result.normalizedEvent);
    await markSourceChecked(source.id, raw.contentHash, true);

    const reasons = saved.canonicalEvent.publishabilityReasons;
    const status = saved.canonicalEvent.publicationStatus === "published" ? "success" : "manual_review";
    const completed = await completeExtractionJob({
      jobId: job.id,
      eventId: saved.event.id,
      provider: provider.name,
      model: provider.model,
      adapter: raw.adapter,
      adapterVersion: raw.adapterVersion,
      schemaVersion: result.schemaVersion,
      curationVersion: result.curationVersion,
      inputHash: raw.contentHash,
      status,
      rawInput: raw,
      rawOutput: result.extraction,
      validatedJson: result.extraction,
      normalizedJson: saved.canonicalEvent,
      confidence: saved.canonicalEvent.confidence,
      warnings: saved.canonicalEvent.warnings,
      reasons,
    });

    return {
      jobId: completed.id,
      status: completed.status as SourceCheckJobResult["status"],
      eventId: saved.event.id,
      sourceId: source.id,
      createdAt,
      finishedAt: completed.finishedAt?.toISOString() ?? null,
      reasons,
    };
  } catch (error) {
    await markSourceFailed(source.id);
    const failedStatus = error instanceof Error && error.name === "ZodError" ? "validation_failed" : "provider_failed";
    const completed = await completeExtractionJob({
      jobId: job.id,
      status: failedStatus,
      errorMessage: error instanceof Error ? error.message : String(error),
      reasons: ["source_check_failed"],
    });
    return {
      jobId: completed.id,
      status: completed.status as SourceCheckJobResult["status"],
      eventId: null,
      sourceId: source.id,
      createdAt,
      finishedAt: completed.finishedAt?.toISOString() ?? null,
      reasons: ["source_check_failed"],
    };
  }
}

export async function curateSourceExtraction(
  raw: RawSourceExtraction,
  provider: AIProvider = createAIProviderFromEnv(),
): Promise<CurateSourceExtractionResult> {
  const extraction = await provider.extractRaceEvent({ raw });
  const normalizedEvent = normalizeRaceEventExtraction(extraction, raw);
  const publishability = evaluatePublishability(normalizedEvent);
  const finalEvent = {
    ...normalizedEvent,
    publicationStatus: publishability.publicationStatus,
    publishabilityReasons: publishability.reasons,
  };
  return {
    extraction,
    normalizedEvent: canonicalRaceEventSchema.parse(finalEvent),
    publishability,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    curationVersion: CURATION_PIPELINE_VERSION,
  };
}

export function normalizeRaceEventExtraction(extraction: RaceEventExtraction, raw: RawSourceExtraction): CanonicalRaceEvent {
  const name = cleanText(extraction.name.value) || raw.title || "Evento sem nome";
  const date = normalizeDate(extraction.date.value);
  const city = cleanText(extraction.city.value) || null;
  const state = cleanText(extraction.state.value)?.toUpperCase() || null;
  const country = cleanText(extraction.country.value)?.toUpperCase() || "BR";
  const registrationUrl = absolutizeUrl(extraction.registrationUrl?.value, raw.url);
  const officialUrl = absolutizeUrl(extraction.officialUrl?.value, raw.url) ?? raw.url;
  const regulationUrl = absolutizeUrl(extraction.regulationUrl?.value, raw.url);
  const organizerUrl = absolutizeUrl(extraction.organizerUrl?.value, raw.url);
  const distances = extraction.distances.map((distance) => ({
    ...distance,
    distanceKm: distance.distanceKm,
    startTime: normalizeTime(distance.startTime),
  }));
  const prices = extraction.prices.map((price) => ({
    ...price,
    price: normalizePrice(price.price),
    currency: price.currency.toUpperCase(),
    startDate: normalizeDate(price.startDate),
    endDate: normalizeDate(price.endDate),
  }));
  const images = extraction.images.flatMap((url) => {
    const absolute = absolutizeUrl(url, raw.url);
    return absolute ? [absolute] : [];
  });
  const canonicalFingerprint = generateEventFingerprint({ name, date, city, state, country });

  return canonicalRaceEventSchema.parse({
    slug: slugify([name, city, date].filter(Boolean).join(" ")),
    name,
    description: cleanText(extraction.description?.value) || null,
    date,
    startTime: normalizeTime(extraction.startTime?.value),
    endTime: normalizeTime(extraction.endTime?.value),
    city,
    state,
    country,
    locationName: cleanText(extraction.locationName?.value) || null,
    address: cleanText(extraction.address?.value) || null,
    latitude: extraction.latitude,
    longitude: extraction.longitude,
    modality: extraction.modality,
    eventStatus: extraction.eventStatus,
    publicationStatus: "draft",
    registrationUrl,
    officialUrl,
    regulationUrl,
    organizerName: cleanText(extraction.organizerName?.value) || null,
    organizerUrl,
    mainImageUrl: images[0] ?? null,
    sourceId: raw.sourceId,
    sourceType: raw.sourceType,
    sourceExternalId: raw.sourceExternalId,
    sourceUrl: raw.url,
    confidence: extraction.confidence,
    canonicalFingerprint,
    dedupeStatus: "unique",
    duplicateOfEventId: null,
    warnings: extraction.warnings,
    publishabilityReasons: [],
    distances,
    prices,
    kits: extraction.kits,
    schedule: extraction.schedule.map((item) => ({
      ...item,
      date: normalizeDate(item.date),
      time: normalizeTime(item.time),
    })),
    rules: extraction.rules,
    kitPickup: extraction.kitPickup
      ? {
          ...extraction.kitPickup,
          date: normalizeDate(extraction.kitPickup.date),
          startTime: normalizeTime(extraction.kitPickup.startTime),
          endTime: normalizeTime(extraction.kitPickup.endTime),
        }
      : null,
    images,
  });
}

export function evaluatePublishability(normalizedEvent: Pick<
  CanonicalRaceEvent,
  "name" | "date" | "city" | "state" | "country" | "locationName" | "registrationUrl" | "officialUrl" | "confidence" | "warnings"
>): PublishabilityResult {
  const reasons: string[] = [];
  const autoPublishMinConfidence = Number(process.env.AUTO_PUBLISH_MIN_CONFIDENCE ?? 0.85);
  const reviewMinConfidence = Number(process.env.REVIEW_MIN_CONFIDENCE ?? 0.6);

  if (!cleanText(normalizedEvent.name)) reasons.push("missing_name");
  if (!normalizedEvent.date) reasons.push("missing_date");
  if (!(normalizedEvent.city && normalizedEvent.state && normalizedEvent.country) && !normalizedEvent.locationName) {
    reasons.push("missing_location");
  }
  if (!normalizedEvent.registrationUrl && !normalizedEvent.officialUrl) reasons.push("missing_registration_or_official_url");
  if (normalizedEvent.confidence < autoPublishMinConfidence) reasons.push("low_confidence");
  if (normalizedEvent.warnings.some((warning) => criticalWarnings.has(warning))) reasons.push("critical_warning");

  if (!reasons.length) return { canPublish: true, publicationStatus: "published", reasons };
  if (normalizedEvent.confidence < reviewMinConfidence) return { canPublish: false, publicationStatus: "pending_review", reasons };
  return { canPublish: false, publicationStatus: "pending_review", reasons };
}

const criticalWarnings = new Set(["missing_date", "conflicting_date", "conflicting_location"]);
