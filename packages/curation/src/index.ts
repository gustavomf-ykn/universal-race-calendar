import { randomUUID } from "node:crypto";
import { createAIProviderFromEnv, type AIProvider } from "@race-calendar/ai";
import {
  completeExtractionJob,
  createExtractionJob,
  getSource,
  markSourceChecked,
  markSourceFailed,
  saveCanonicalEvent,
  saveRawSourceExtraction,
  upsertSourceByAdapterExternalId,
} from "@race-calendar/database";
import {
  canonicalRaceEventSchema,
  type CanonicalRaceEvent,
  type PublicationStatus,
  type RaceEventExtraction,
  type RawSourceExtraction,
} from "@race-calendar/schemas";
import {
  discoverTicketSportsEvents,
  SourceAdapterRegistry,
  type DiscoverTicketSportsEventsOptions,
  type TicketSportsDiscoveredEvent,
} from "@race-calendar/sources";
import {
  absolutizeUrl,
  CANONICAL_SCHEMA_VERSION,
  cleanText,
  CURATION_PIPELINE_VERSION,
  generateEventFingerprint,
  normalizeDate,
  normalizeDistanceKm,
  normalizePrice,
  normalizeTime,
  slugify,
  unique,
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

export type TicketSportsImportResult = {
  jobId: string;
  status: "success" | "partial_success";
  source: "ticketsports";
  quickFilter: string;
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

export type ImportTicketSportsEventsOptions = DiscoverTicketSportsEventsOptions & {
  concurrency?: number;
  delayMs?: number;
  registry?: SourceAdapterRegistry;
  discoverEvents?: () => Promise<TicketSportsDiscoveredEvent[]>;
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

    const provider = raw.sourceType === "ticketsports" ? null : createAIProviderFromEnv();
    const result = provider ? await curateSourceExtraction(raw, provider) : await curateTicketSportsSourceExtraction(raw);
    const saved = await saveCanonicalEvent(result.normalizedEvent);
    await markSourceChecked(source.id, raw.contentHash, true);

    const reasons = saved.canonicalEvent.publishabilityReasons;
    const status = saved.canonicalEvent.publicationStatus === "published" ? "success" : "manual_review";
    const completed = await completeExtractionJob({
      jobId: job.id,
      eventId: saved.event.id,
      provider: provider?.name ?? "deterministic",
      model: provider?.model ?? "ticketsports-v1",
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

export async function importTicketSportsEvents(options: ImportTicketSportsEventsOptions = {}): Promise<TicketSportsImportResult> {
  const startedAt = new Date();
  const quickFilter = cleanText(options.quickFilter ?? process.env.TICKETSPORTS_IMPORT_QUICK_FILTER ?? "corrida-de-rua");
  const quantity = positiveInt(options.quantity, Number(process.env.TICKETSPORTS_IMPORT_QUANTITY ?? 1000));
  const concurrency = Math.max(1, Math.min(positiveInt(options.concurrency, Number(process.env.TICKETSPORTS_IMPORT_CONCURRENCY ?? 3)), 10));
  const delayMs = nonNegativeInt(options.delayMs, Number(process.env.TICKETSPORTS_IMPORT_DELAY_MS ?? 300));
  const registry = options.registry ?? new SourceAdapterRegistry();
  const discoverOptions: DiscoverTicketSportsEventsOptions = { quantity, quickFilter };
  if (options.client) discoverOptions.client = options.client;
  const discovered = options.discoverEvents ? await options.discoverEvents() : await discoverTicketSportsEvents(discoverOptions);
  const failures: TicketSportsImportResult["failures"] = [];
  let processedCount = 0;
  let publishedEvents = 0;
  let manualReviewEvents = 0;
  let unchangedEvents = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const item = discovered[cursor];
      cursor += 1;
      if (!item) return;
      try {
        const source = await upsertSourceByAdapterExternalId({
          name: item.name,
          url: item.url,
          type: "registration_page",
          country: item.country,
          state: item.state,
          city: item.city,
          adapter: item.adapter,
          externalId: item.externalId,
          metadata: item.metadata,
          checkIntervalMinutes: null,
        });
        if (delayMs) await wait(delayMs);
        const result = await runSourceCheck(source.id, registry);
        processedCount += 1;
        if (result.status === "success" && result.eventId) publishedEvents += 1;
        if (result.status === "success" && !result.eventId) unchangedEvents += 1;
        if (result.status === "manual_review") manualReviewEvents += 1;
      } catch (error) {
        failures.push({
          externalId: item.externalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, discovered.length) }, () => worker()));
  return {
    jobId: `import_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    status: failures.length ? "partial_success" : "success",
    source: "ticketsports",
    quickFilter,
    discoveredCount: discovered.length,
    processedCount,
    publishedEvents,
    manualReviewEvents,
    unchangedEvents,
    failedCount: failures.length,
    failures,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
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

export async function curateTicketSportsSourceExtraction(raw: RawSourceExtraction): Promise<CurateSourceExtractionResult> {
  const extraction = ticketSportsExtractionFromRaw(raw);
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

function ticketSportsExtractionFromRaw(raw: RawSourceExtraction): RaceEventExtraction {
  const record = asRecord(raw.rawSourceData);
  const address = cleanText(stringValue(record.address));
  const location = parseTicketSportsLocation(address);
  const title = cleanText(stringValue(record.title) ?? raw.title ?? "Evento TicketSports");
  const realDate = stringValue(record.realDate);
  const date = realDate ?? stringValue(record.date);
  const registrationUrl = stringValue(record.uri) ?? raw.url;
  const images = unique([stringValue(record.headerImageSource), stringValue(record.logoImageSource)].filter(isStringUrl));
  const text = cleanText([title, date, address, stringValue(record.organizer), stringValue(record.status), raw.importantText].filter(Boolean).join(" "));
  const warnings: string[] = [];
  if (!normalizeDate(date)) warnings.push("missing_date");
  if (!location.city) warnings.push("missing_city");
  if (!location.state) warnings.push("missing_state");
  if (!registrationUrl) warnings.push("missing_registration_url");
  const confidence = warnings.length ? 0.72 : 0.92;

  return {
    name: evidence(title, 0.95),
    description: evidence(raw.importantText || title, 0.75),
    date: evidence(date, date ? 0.92 : 0),
    startTime: evidence(realDate ? normalizeTime(realDate) : normalizeTime(text), realDate ? 0.82 : 0.55),
    endTime: evidence(null, 0),
    city: evidence(location.city, location.city ? 0.9 : 0),
    state: evidence(location.state, location.state ? 0.9 : 0),
    country: evidence(location.country ?? "BR", 0.85),
    locationName: evidence(location.locationName, location.locationName ? 0.7 : 0),
    address: evidence(address, address ? 0.88 : 0),
    latitude: numberOrNull(record.latitude),
    longitude: numberOrNull(record.longitude),
    modality: modalityFromTicketSportsText(text),
    distances: distancesFromText(text),
    prices: pricesFromText(text),
    kits: [],
    schedule: [],
    rules: [],
    kitPickup: null,
    registrationUrl: evidence(registrationUrl, registrationUrl ? 0.95 : 0),
    officialUrl: evidence(raw.url, 0.85),
    regulationUrl: evidence(findRegulationUrl(raw.extractedLinks), 0.6),
    organizerName: evidence(stringValue(record.organizer), stringValue(record.organizer) ? 0.9 : 0),
    organizerUrl: evidence(null, 0),
    images,
    eventStatus: eventStatusFromTicketSports(stringValue(record.status), text),
    confidence,
    warnings,
  };
}

function evidence(value: string | null | undefined, confidence: number) {
  return {
    value: cleanText(value) || null,
    confidence,
    sourceText: cleanText(value) || null,
  };
}

function parseTicketSportsLocation(address: string): {
  city: string | null;
  state: string | null;
  country: string | null;
  locationName: string | null;
} {
  const text = cleanText(address);
  if (!text) return { city: null, state: null, country: "BR", locationName: null };
  const state = text.match(/,\s*([A-Z]{2})(?:,|\b)/)?.[1]?.toUpperCase() ?? null;
  const country = /,\s*(Brasil|BR)\b/i.test(text) ? "BR" : "BR";
  const locationName = cleanText(text.split(":")[0]) || null;
  if (!state) return { city: locationName, state: null, country, locationName };
  const beforeState = text.split(new RegExp(`,\\s*${state}\\b`, "i"))[0] ?? "";
  const city = locationName && text.includes(":") ? locationName : cleanText(beforeState.split(",").at(-1));
  return { city: city || null, state, country, locationName };
}

function distancesFromText(text: string): RaceEventExtraction["distances"] {
  return unique(text.match(/\b(?:[1-9]\d?(?:[,.]\d+)?)\s*(?:km|k)\b/gi) ?? [])
    .map((label) => {
      const distanceKm = normalizeDistanceKm(label);
      return {
        label: cleanText(label.replace(",", ".")),
        distanceKm,
        modality: "road" as const,
        startTime: null,
        elevationGain: null,
        sourceText: label,
        confidence: distanceKm ? 0.82 : 0.4,
      };
    })
    .filter((distance) => distance.distanceKm != null && distance.distanceKm <= 100);
}

function pricesFromText(text: string): RaceEventExtraction["prices"] {
  return unique(text.match(/R\$\s*\d+(?:\.\d{3})*(?:[.,]\d{2})?/gi) ?? []).map((rawPrice, index) => ({
    name: index === 0 ? "Inscricao" : `Lote ${index + 1}`,
    price: normalizePrice(rawPrice),
    currency: "BRL",
    startDate: null,
    endDate: null,
    status: "unknown" as const,
    sourceText: rawPrice,
    confidence: 0.78,
  }));
}

function eventStatusFromTicketSports(status: string | null, text: string): RaceEventExtraction["eventStatus"] {
  const statusText = cleanText(status).toLowerCase();
  const value = cleanText([status, text].filter(Boolean).join(" ")).toLowerCase();
  if (/cancelad|cancelled/.test(value)) return "cancelled";
  if (/adiad|postponed/.test(value)) return "postponed";
  if (/esgotad|sold out/.test(value)) return "sold_out";
  if (/encerrad|finalizad|finished|realizad/.test(statusText)) return "finished";
  if (/abert|agendad|scheduled|inscri/.test(value)) return "scheduled";
  return "unknown";
}

function modalityFromTicketSportsText(text: string): RaceEventExtraction["modality"] {
  const lower = text.toLowerCase();
  if (lower.includes("trail")) return "trail";
  if (lower.includes("kids") || lower.includes("infantil")) return "kids";
  if (lower.includes("caminhada")) return "walk";
  return "road";
}

function findRegulationUrl(urls: string[]): string | null {
  return urls.find((url) => /regulamento|regulation|pdf/i.test(url)) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isStringUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
