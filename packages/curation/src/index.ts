import { randomUUID } from "node:crypto";
import { createAIProviderFromEnv, type AIProvider } from "@race-calendar/ai";
import {
  completeExtractionJob,
  createExtractionJob,
  findSuccessfulCurationJob,
  getCurationSummary,
  getLatestRawExtractionForEvent,
  getSource,
  listEventsForCuration,
  prisma,
  saveImportRun,
  saveCurationJob,
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
  raceEventExtractionSchema,
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
  providerName?: string;
  providerModel?: string;
  curationJobId?: string;
  appliedChanges?: CurationDiff[];
  curationJobStatus?: "success" | "validation_failed" | "provider_failed" | "skipped_cached" | "manual_review";
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

export type RunSourceCheckOptions = {
  force?: boolean;
};

export type TicketSportsImportResult = {
  jobId: string;
  status: "success" | "partial_success";
  source: "ticketsports";
  quickFilter: string;
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

export type ImportTicketSportsEventsOptions = DiscoverTicketSportsEventsOptions & {
  concurrency?: number;
  delayMs?: number;
  offset?: number;
  force?: boolean;
  registry?: SourceAdapterRegistry;
  discoverEvents?: () => Promise<TicketSportsDiscoveredEvent[]>;
};

export type CurationDiff = {
  field: string;
  from: unknown;
  to: unknown;
  confidence: number | null;
  warnings: string[];
};

export type RunAICurationOptions = {
  eventId?: string;
  limit?: number;
  only?: "not_curated" | "published" | "pending_review" | "failed" | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
  provider?: AIProvider | undefined;
};

export type AICurationRunResult = {
  eventId: string | null;
  curationJobId: string | null;
  provider: string | null;
  model: string | null;
  status: "success" | "validation_failed" | "provider_failed" | "skipped_cached" | "manual_review";
  dryRun: boolean;
  appliedChanges: CurationDiff[];
  warnings: string[];
  confidence: number | null;
};

export async function runSourceCheck(
  sourceId: string,
  registry = new SourceAdapterRegistry(),
  options: RunSourceCheckOptions = {},
): Promise<SourceCheckJobResult> {
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
    if (!options.force && source.lastHash === raw.contentHash) {
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

    const rawRecord = await saveRawSourceExtraction(raw);

    const aiEnabled = shouldRunAICuration();
    const provider = aiEnabled || raw.sourceType !== "ticketsports" ? createAIProviderFromEnv() : undefined;
    const result = aiEnabled
      ? await curateRawExtractionWithAI(raw, { force: options.force, rawSourceExtractionId: rawRecord.id, provider })
      : provider
        ? await curateSourceExtraction(raw, provider)
        : await curateTicketSportsSourceExtraction(raw);
    if (!shouldPersistCanonicalEvent(result.normalizedEvent)) {
      await markSourceChecked(source.id, raw.contentHash, true);
      const completed = await completeExtractionJob({
        jobId: job.id,
        provider: result.providerName ?? provider?.name ?? "deterministic",
        model: result.providerModel ?? provider?.model ?? "ticketsports-v1",
        adapter: raw.adapter,
        adapterVersion: raw.adapterVersion,
        schemaVersion: result.schemaVersion,
        curationVersion: result.curationVersion,
        inputHash: raw.contentHash,
        status: "success",
        rawInput: raw,
        rawOutput: result.extraction,
        validatedJson: result.extraction,
        normalizedJson: result.normalizedEvent,
        confidence: result.normalizedEvent.confidence,
        warnings: result.normalizedEvent.warnings,
        reasons: ["non_brazil_event"],
      });
      return {
        jobId: completed.id,
        status: completed.status as SourceCheckJobResult["status"],
        eventId: null,
        sourceId: source.id,
        createdAt,
        finishedAt: completed.finishedAt?.toISOString() ?? null,
        reasons: ["non_brazil_event"],
      };
    }
    const saved = await saveCanonicalEvent(result.normalizedEvent);
    if (result.curationJobId) {
      await prisma.curationJob.update({ where: { id: result.curationJobId }, data: { eventId: saved.event.id } });
    }
    await markSourceChecked(source.id, raw.contentHash, true);

    const reasons = saved.canonicalEvent.publishabilityReasons;
    const status = saved.canonicalEvent.publicationStatus === "published" ? "success" : "manual_review";
    const completed = await completeExtractionJob({
      jobId: job.id,
      eventId: saved.event.id,
      provider: result.providerName ?? provider?.name ?? "deterministic",
      model: result.providerModel ?? provider?.model ?? "ticketsports-v1",
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
  const offset = nonNegativeInt(options.offset, Number(process.env.TICKETSPORTS_IMPORT_OFFSET ?? 0));
  const concurrency = Math.max(1, Math.min(positiveInt(options.concurrency, Number(process.env.TICKETSPORTS_IMPORT_CONCURRENCY ?? 3)), 10));
  const delayMs = nonNegativeInt(options.delayMs, Number(process.env.TICKETSPORTS_IMPORT_DELAY_MS ?? 300));
  const registry = options.registry ?? new SourceAdapterRegistry();
  const discoverOptions: DiscoverTicketSportsEventsOptions = { quantity: quantity + offset, quickFilter };
  if (options.client) discoverOptions.client = options.client;
  const allDiscovered = options.discoverEvents ? await options.discoverEvents() : await discoverTicketSportsEvents(discoverOptions);
  const discovered = allDiscovered.slice(offset, offset + quantity);
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
        const result = await runSourceCheck(source.id, registry, { force: options.force === true });
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
  const result: TicketSportsImportResult = {
    jobId: `import_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    status: failures.length ? "partial_success" : "success",
    source: "ticketsports",
    quickFilter,
    requestedQuantity: quantity,
    offset,
    discoveredCount: allDiscovered.length,
    processedCount,
    publishedEvents,
    manualReviewEvents,
    unchangedEvents,
    failedCount: failures.length,
    failures,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
  await saveImportRun({
    id: result.jobId,
    source: result.source,
    quickFilter: result.quickFilter,
    status: result.status,
    requestedQuantity: result.requestedQuantity,
    offset: result.offset,
    discoveredCount: result.discoveredCount,
    processedCount: result.processedCount,
    publishedEvents: result.publishedEvents,
    manualReviewEvents: result.manualReviewEvents,
    unchangedEvents: result.unchangedEvents,
    failedCount: result.failedCount,
    failures: result.failures,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  });
  return result;
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

export async function curateRawExtractionWithAI(
  raw: RawSourceExtraction,
  options: {
    force?: boolean | undefined;
    dryRun?: boolean | undefined;
    rawSourceExtractionId?: string | null | undefined;
    eventId?: string | null | undefined;
    currentEvent?: unknown;
    provider?: AIProvider | undefined;
  } = {},
): Promise<CurateSourceExtractionResult> {
  const provider = options.provider ?? createAIProviderFromEnv();
  const schemaVersion = CANONICAL_SCHEMA_VERSION;
  const curationVersion = CURATION_PIPELINE_VERSION;
  const dryRun = options.dryRun === true;
  const cached =
    !options.force && !dryRun
      ? await findSuccessfulCurationJob({
          provider: provider.name,
          model: provider.model,
          contentHash: raw.contentHash,
          schemaVersion,
          curationVersion,
        })
      : null;

  if (cached?.validatedJson) {
    const extraction = raceEventExtractionSchema.parse(cached.validatedJson);
    const result = applyRaceEventExtraction(raw, extraction, {
      providerName: provider.name,
      providerModel: provider.model,
      curationStatus: "skipped_cached",
      currentEvent: options.currentEvent,
    });
    const job = await saveCurationJob({
      eventId: options.eventId,
      rawSourceExtractionId: options.rawSourceExtractionId,
      provider: provider.name,
      model: provider.model,
      status: "skipped_cached",
      contentHash: raw.contentHash,
      schemaVersion,
      curationVersion,
      rawInput: raw,
      rawOutput: cached.rawOutput,
      validatedJson: extraction,
      normalizedJson: result.normalizedEvent,
      appliedChanges: result.appliedChanges,
      warnings: result.normalizedEvent.warnings,
      confidence: result.normalizedEvent.confidence,
      isDryRun: false,
    });
    return { ...result, schemaVersion, curationVersion, providerName: provider.name, providerModel: provider.model, curationJobId: job.id, curationJobStatus: "skipped_cached" };
  }

  try {
    const extraction = await provider.extractRaceEvent({ raw, currentEvent: options.currentEvent });
    const result = applyRaceEventExtraction(raw, extraction, {
      providerName: provider.name,
      providerModel: provider.model,
      curationStatus: "curated",
      currentEvent: options.currentEvent,
    });
    const status = result.normalizedEvent.publicationStatus === "published" ? "success" : "manual_review";
    const job = await saveCurationJob({
      eventId: options.eventId,
      rawSourceExtractionId: options.rawSourceExtractionId,
      provider: provider.name,
      model: provider.model,
      status,
      contentHash: raw.contentHash,
      schemaVersion,
      curationVersion,
      rawInput: raw,
      rawOutput: extraction,
      validatedJson: extraction,
      normalizedJson: result.normalizedEvent,
      appliedChanges: result.appliedChanges,
      warnings: result.normalizedEvent.warnings,
      confidence: result.normalizedEvent.confidence,
      isDryRun: dryRun,
    });
    return { ...result, schemaVersion, curationVersion, providerName: provider.name, providerModel: provider.model, curationJobId: job.id, curationJobStatus: status };
  } catch (error) {
    const status = error instanceof Error && error.name === "ZodError" ? "validation_failed" : "provider_failed";
    const job = await saveCurationJob({
      eventId: options.eventId,
      rawSourceExtractionId: options.rawSourceExtractionId,
      provider: provider.name,
      model: provider.model,
      status,
      contentHash: raw.contentHash,
      schemaVersion,
      curationVersion,
      rawInput: raw,
      warnings: ["ai_curation_failed"],
      confidence: null,
      isDryRun: dryRun,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    const fallback = await curateTicketSportsSourceExtraction(raw, ["ai_curation_failed"]);
    if (isAICurationRequired()) {
      fallback.normalizedEvent.publicationStatus = "pending_review";
      fallback.normalizedEvent.publishabilityReasons = [...new Set([...fallback.normalizedEvent.publishabilityReasons, "ai_curation_required"])];
      fallback.normalizedEvent.curationStatus = "failed";
    }
    return {
      ...fallback,
      providerName: provider.name,
      providerModel: provider.model,
      curationJobId: job.id,
      curationJobStatus: status,
      appliedChanges: diffCanonicalEvents(options.currentEvent, fallback.normalizedEvent),
    };
  }
}

export function applyRaceEventExtraction(
  raw: RawSourceExtraction,
  extraction: RaceEventExtraction,
  options: { providerName: string; providerModel: string; curationStatus: "curated" | "skipped_cached"; currentEvent?: unknown },
): CurateSourceExtractionResult & { appliedChanges: CurationDiff[] } {
  const aiParsed = raceEventExtractionSchema.parse(withCompatibleLots(extraction));
  const parsed = raw.sourceType === "ticketsports" ? mergeRaceEventExtractionFallbacks(aiParsed, ticketSportsExtractionFromRaw(raw)) : aiParsed;
  const normalizedEvent = normalizeRaceEventExtraction(parsed, raw);
  const publishability = evaluatePublishability(normalizedEvent);
  const finalEvent = canonicalRaceEventSchema.parse({
    ...normalizedEvent,
    publicationStatus: publishability.publicationStatus,
    publishabilityReasons: publishability.reasons,
    curationStatus: publishability.publicationStatus === "published" ? options.curationStatus : "manual_review",
    curatedAt: new Date().toISOString(),
    curationProvider: options.providerName,
    curationModel: options.providerModel,
    curationVersion: CURATION_PIPELINE_VERSION,
  });
  return {
    extraction: parsed,
    normalizedEvent: finalEvent,
    publishability,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    curationVersion: CURATION_PIPELINE_VERSION,
    providerName: options.providerName,
    providerModel: options.providerModel,
    appliedChanges: diffCanonicalEvents(options.currentEvent, finalEvent),
  };
}

export async function curateTicketSportsSourceExtraction(raw: RawSourceExtraction, extraWarnings: string[] = []): Promise<CurateSourceExtractionResult> {
  const extraction = ticketSportsExtractionFromRaw(raw);
  if (extraWarnings.length) extraction.warnings = [...new Set([...extraction.warnings, ...extraWarnings])];
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

export async function runAICurationForEvent(eventId: string, options: RunAICurationOptions = {}): Promise<AICurationRunResult> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { distances: true, prices: true, images: true },
  });
  if (!event) throw new Error(`Event not found: ${eventId}`);
  const rawRecord = await getLatestRawExtractionForEvent(eventId);
  if (!rawRecord) throw new Error(`Raw extraction not found for event: ${eventId}`);
  const raw = rawSourceExtractionFromRecord(rawRecord);
  const result = await curateRawExtractionWithAI(raw, {
    eventId,
    rawSourceExtractionId: rawRecord.id,
    dryRun: options.dryRun,
    force: options.force,
    currentEvent: event,
    provider: options.provider,
  });
  if (!options.dryRun && shouldPersistCanonicalEvent(result.normalizedEvent)) {
    const saved = await saveCanonicalEvent(result.normalizedEvent);
    if (result.curationJobId) await prisma.curationJob.update({ where: { id: result.curationJobId }, data: { eventId: saved.event.id } });
  }
  const warnings = shouldPersistCanonicalEvent(result.normalizedEvent)
    ? result.normalizedEvent.warnings
    : [...new Set([...result.normalizedEvent.warnings, "non_brazil_event"])];
  return {
    eventId,
    curationJobId: result.curationJobId ?? null,
    provider: result.providerName ?? null,
    model: result.providerModel ?? null,
    status: shouldPersistCanonicalEvent(result.normalizedEvent) ? (result.curationJobStatus ?? "success") : "manual_review",
    dryRun: options.dryRun === true,
    appliedChanges: result.appliedChanges ?? [],
    warnings,
    confidence: result.normalizedEvent.confidence,
  };
}

export async function runAICurationBatch(options: RunAICurationOptions = {}) {
  const limit = positiveInt(options.limit, 10);
  const rows = await listEventsForCuration({ only: options.only ?? "not_curated", limit });
  const results: AICurationRunResult[] = [];
  const failures: Array<{ eventId: string; error: string }> = [];
  for (const event of rows) {
    try {
      results.push(await runAICurationForEvent(event.id, options));
    } catch (error) {
      failures.push({ eventId: event.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    status: failures.length ? "partial_success" : "success",
    requestedLimit: limit,
    processedCount: results.length,
    failedCount: failures.length,
    dryRun: options.dryRun === true,
    results,
    failures,
  };
}

export async function auditCuration() {
  return getCurationSummary();
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
  const locationName = cleanText(extraction.locationName?.value) || null;
  const description = cleanText(extraction.description?.value) || cleanText(raw.importantText).slice(0, 2000) || null;
  const startTime = normalizeTime(extraction.startTime?.value) ?? normalizeTime(extraction.date.sourceText);
  const distances = extraction.distances.map((distance) => ({
    ...distance,
    distanceKm: distance.distanceKm,
    startTime: normalizeTime(distance.startTime),
  }));
  const prices = withCompatibleLots(extraction).prices.map((price) => ({
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
  const warnings = normalizeCurationWarnings(extraction.warnings, { city, state, country, locationName });
  const confidence = normalizeCurationConfidence(extraction, {
    name,
    date,
    city,
    country,
    registrationUrl,
    officialUrl,
    warnings,
  });
  const canonicalFingerprint = generateEventFingerprint({ name, date, city, state, country });

  return canonicalRaceEventSchema.parse({
    slug: slugify([name, city, date].filter(Boolean).join(" ")),
    name,
    description,
    date,
    startTime,
    endTime: normalizeTime(extraction.endTime?.value),
    city,
    state,
    country,
    locationName,
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
    confidence,
    canonicalFingerprint,
    dedupeStatus: "unique",
    duplicateOfEventId: null,
    warnings,
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
  if (!hasPublishableLocation(normalizedEvent)) {
    reasons.push("missing_location");
  }
  if (!normalizedEvent.registrationUrl && !normalizedEvent.officialUrl) reasons.push("missing_registration_or_official_url");
  if (normalizedEvent.confidence < autoPublishMinConfidence) reasons.push("low_confidence");
  if (normalizedEvent.warnings.some((warning) => criticalWarnings.has(warning))) reasons.push("critical_warning");

  if (!reasons.length) return { canPublish: true, publicationStatus: "published", reasons };
  if (normalizedEvent.confidence < reviewMinConfidence) return { canPublish: false, publicationStatus: "pending_review", reasons };
  return { canPublish: false, publicationStatus: "pending_review", reasons };
}

const criticalWarnings = new Set(["missing_date", "conflicting_date", "conflicting_location", "suspicious_city"]);

export function shouldPersistCanonicalEvent(event: Pick<CanonicalRaceEvent, "country">): boolean {
  return event.country?.toUpperCase() === "BR";
}

function hasPublishableLocation(
  event: Pick<CanonicalRaceEvent, "city" | "state" | "country" | "locationName">,
): boolean {
  if (cleanText(event.locationName)) return true;
  if (!(cleanText(event.city) && cleanText(event.country))) return false;
  return event.country?.toUpperCase() !== "BR" || Boolean(cleanText(event.state));
}

function normalizeCurationWarnings(
  warnings: string[],
  location: { city: string | null; state: string | null; country: string | null; locationName: string | null },
): string[] {
  const country = location.country?.toUpperCase() ?? null;
  return unique(warnings).filter((warning) => {
    if (warning === "missing_state" && country && country !== "BR" && (location.city || location.locationName)) return false;
    return true;
  });
}

function normalizeCurationConfidence(
  extraction: RaceEventExtraction,
  context: {
    name: string | null;
    date: string | null;
    city: string | null;
    country: string | null;
    registrationUrl: string | null;
    officialUrl: string | null;
    warnings: string[];
  },
): number {
  if (extraction.confidence > 0) return extraction.confidence;
  const evidenceScores = [
    extraction.name.confidence,
    extraction.date.confidence,
    extraction.city.confidence,
    extraction.country.confidence,
    extraction.registrationUrl?.confidence,
    extraction.officialUrl?.confidence,
  ].filter((value): value is number => typeof value === "number" && value > 0);
  const evidenceAverage = evidenceScores.length ? evidenceScores.reduce((sum, value) => sum + value, 0) / evidenceScores.length : 0;
  const essentialScore =
    (context.name ? 0.18 : 0) +
    (context.date ? 0.18 : 0) +
    (context.city || context.country ? 0.18 : 0) +
    (context.registrationUrl || context.officialUrl ? 0.18 : 0);
  const warningPenalty = context.warnings.some((warning) => criticalWarnings.has(warning)) ? 0.2 : 0;
  return Math.max(0, Math.min(0.82, Number(Math.max(evidenceAverage, essentialScore + 0.1 - warningPenalty).toFixed(2))));
}

function mergeRaceEventExtractionFallbacks(primary: RaceEventExtraction, fallback: RaceEventExtraction): RaceEventExtraction {
  const merged = raceEventExtractionSchema.parse({
    ...primary,
    description: mergeEvidence(primary.description, fallback.description),
    startTime: mergeEvidence(primary.startTime, fallback.startTime),
    endTime: mergeEvidence(primary.endTime, fallback.endTime),
    locationName: mergeEvidence(primary.locationName, fallback.locationName),
    address: mergeEvidence(primary.address, fallback.address),
    registrationUrl: mergeEvidence(primary.registrationUrl, fallback.registrationUrl),
    officialUrl: mergeEvidence(primary.officialUrl, fallback.officialUrl),
    regulationUrl: mergeEvidence(primary.regulationUrl, fallback.regulationUrl),
    organizerName: mergeEvidence(primary.organizerName, fallback.organizerName),
    organizerUrl: mergeEvidence(primary.organizerUrl, fallback.organizerUrl),
    modality: primary.modality === "unknown" ? fallback.modality : primary.modality,
    eventStatus: primary.eventStatus === "unknown" ? fallback.eventStatus : primary.eventStatus,
    distances: primary.distances.length ? primary.distances : fallback.distances,
    prices: primary.prices.length ? primary.prices : fallback.prices,
    lots: primary.lots.length ? primary.lots : fallback.lots,
    currentLot: primary.currentLot ?? fallback.currentLot,
    kits: primary.kits.length ? primary.kits : fallback.kits,
    schedule: primary.schedule.length ? primary.schedule : fallback.schedule,
    rules: primary.rules.length ? primary.rules : fallback.rules,
    kitPickup: primary.kitPickup ?? fallback.kitPickup,
    images: primary.images.length ? primary.images : fallback.images,
    warnings: unique([...primary.warnings, ...fallback.warnings]),
  });
  const compatible = withCompatibleLots(merged);
  return raceEventExtractionSchema.parse({
    ...compatible,
    warnings: compatible.warnings.filter((warning) => {
      if (warning === "no_distances_found" && compatible.distances.length) return false;
      if ((warning === "no_lots_found" || warning === "no_prices_found") && compatible.prices.length) return false;
      return true;
    }),
  });
}

function mergeEvidence<T extends { value: string | null; confidence: number; sourceText: string | null } | undefined>(
  primary: T,
  fallback: T,
): T {
  if (primary && cleanText(primary.value)) return primary;
  return fallback ?? primary;
}

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
  if (location.suspiciousCity) warnings.push("suspicious_city");
  if (!registrationUrl) warnings.push("missing_registration_url");
  const confidence = warnings.length ? 0.72 : 0.92;

  return raceEventExtractionSchema.parse({
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
    modality: modalityFromTicketSportsText(title, text),
    distances: distancesFromText(text),
    prices: pricesFromText(text),
    lots: pricesFromText(text),
    currentLot: pricesFromText(text)[0] ?? null,
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
    fieldConfidences: {
      name: 0.95,
      date: date ? 0.92 : 0,
      city: location.city ? 0.9 : 0,
      state: location.state ? 0.9 : 0,
      registrationUrl: registrationUrl ? 0.95 : 0,
    },
    unstructuredNotes: [],
    warnings,
  });
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
  suspiciousCity: boolean;
} {
  const text = cleanText(address);
  if (!text) return { city: null, state: null, country: "BR", locationName: null, suspiciousCity: false };
  const state = text.match(/,\s*([A-Z]{2})(?:,|\b)/)?.[1]?.toUpperCase() ?? null;
  const country = /,\s*(Brasil|BR)\b/i.test(text) ? "BR" : "BR";
  const locationName = cleanText(text.split(":")[0]) || null;
  if (!state) {
    const city = looksLikeVenueOrStreet(locationName) ? null : locationName;
    return { city, state: null, country, locationName, suspiciousCity: Boolean(locationName && !city) };
  }
  const beforeState = text.split(new RegExp(`,\\s*${state}\\b`, "i"))[0] ?? "";
  const explicitBeforeDash = cleanText(beforeState.match(/,\s*([^,]+?)\s*-\s*[A-Z]{2}\b/i)?.[1]);
  const candidates = [
    cleanText(text.match(new RegExp(`,\\s*([^,]+?)\\s*,\\s*${state}\\b`, "i"))?.[1]),
    explicitBeforeDash,
    locationName && text.includes(":") ? locationName : null,
    cleanText(beforeState.split(",").at(-1)),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const city = candidates.find((candidate) => !looksLikeVenueOrStreet(candidate)) ?? null;
  return { city, state, country, locationName, suspiciousCity: !city };
}

function distancesFromText(text: string): RaceEventExtraction["distances"] {
  const byDistanceKm = new Map<number, RaceEventExtraction["distances"][number]>();
  for (const label of unique(text.match(/\b(?:[1-9]\d?(?:[,.]\d+)?)\s*(?:km|k)\b/gi) ?? [])) {
    const distanceKm = normalizeDistanceKm(label);
    if (distanceKm == null || distanceKm > 100) continue;
    const key = Number(distanceKm.toFixed(3));
    if (byDistanceKm.has(key)) continue;
    byDistanceKm.set(key, {
      label: formatDistanceLabel(distanceKm),
      distanceKm,
      modality: "road" as const,
      startTime: null,
      elevationGain: null,
      sourceText: label,
      confidence: 0.82,
    });
  }
  return Array.from(byDistanceKm.values()).sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
}

function formatDistanceLabel(distanceKm: number): string {
  return `${Number.isInteger(distanceKm) ? distanceKm : Number(distanceKm.toFixed(2))} km`;
}

function looksLikeVenueOrStreet(value: string | null): boolean {
  const text = cleanText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (!text) return false;
  const venuePrefixes = [
    "av ",
    "av.",
    "avenida ",
    "rua ",
    "rodovia ",
    "estrada ",
    "praca ",
    "parque ",
    "shopping ",
    "estadio ",
    "ginasio ",
    "centro ",
    "arena ",
    "complexo ",
    "campus ",
    "represa ",
    "lagoa ",
    "orla ",
    "posto ",
    "km ",
  ];
  return venuePrefixes.some((prefix) => text.startsWith(prefix));
}

function pricesFromText(text: string): RaceEventExtraction["prices"] {
  return unique(text.match(/R\$\s*\d+(?:\.\d{3})*(?:[.,]\d{2})?/gi) ?? []).map((rawPrice, index) => ({
    name: index === 0 ? "Inscricao" : `Lote ${index + 1}`,
    price: normalizePrice(rawPrice),
    currency: "BRL",
    startDate: null,
    endDate: null,
    status: "unknown" as const,
    isCurrent: index === 0,
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

function modalityFromTicketSportsText(title: string, text: string): RaceEventExtraction["modality"] {
  const titleText = title.toLowerCase();
  const fullText = text.toLowerCase();
  if (titleText.includes("trail")) return "trail";
  if (/\b(kids?|infantil)\b/.test(titleText)) return "kids";
  if (titleText.includes("caminhada") && !/(corrida|maratona|meia|desafio|circuito)/.test(titleText)) return "walk";
  if (/(corrida|maratona|meia|desafio|circuito|run)\b/.test(titleText)) return "road";
  if (fullText.includes("trail")) return "trail";
  if (fullText.includes("caminhada") && !/(corrida|maratona|meia)/.test(fullText)) return "walk";
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

function shouldRunAICuration(): boolean {
  return process.env.AI_CURATION_ENABLED === "true";
}

function isAICurationRequired(): boolean {
  return process.env.AI_CURATION_REQUIRED === "true";
}

function withCompatibleLots(extraction: RaceEventExtraction): RaceEventExtraction {
  const parsed = raceEventExtractionSchema.parse(extraction);
  const merged = new Map<string, RaceEventExtraction["prices"][number]>();
  for (const price of [...parsed.prices, ...parsed.lots, ...(parsed.currentLot ? [parsed.currentLot] : [])]) {
    const key = [price.name ?? "", price.price ?? "", price.currency, price.startDate ?? "", price.endDate ?? ""].join("|");
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, isCurrent: existing.isCurrent || price.isCurrent } : price);
  }
  const prices = Array.from(merged.values());
  if (parsed.currentLot && !prices.some((price) => price.isCurrent)) {
    prices.unshift({ ...parsed.currentLot, isCurrent: true });
  }
  const firstPrice = prices[0];
  if (firstPrice && !prices.some((price) => price.isCurrent)) prices[0] = { ...firstPrice, isCurrent: true };
  return {
    ...parsed,
    prices,
    lots: parsed.lots.length ? parsed.lots : prices,
    currentLot: parsed.currentLot ?? prices.find((price) => price.isCurrent) ?? null,
  };
}

function diffCanonicalEvents(currentEvent: unknown, next: CanonicalRaceEvent): CurationDiff[] {
  const current = asRecord(currentEvent);
  const fields: Array<keyof CanonicalRaceEvent> = [
    "name",
    "description",
    "date",
    "startTime",
    "city",
    "state",
    "country",
    "locationName",
    "address",
    "modality",
    "eventStatus",
    "registrationUrl",
    "officialUrl",
    "organizerName",
    "confidence",
  ];
  return fields.flatMap((field) => {
    const from = serializeComparable(current[field as string]);
    const to = serializeComparable(next[field]);
    if (JSON.stringify(from) === JSON.stringify(to)) return [];
    return [
      {
        field,
        from,
        to,
        confidence: next.confidence,
        warnings: next.warnings,
      },
    ];
  });
}

function serializeComparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value ?? null;
}

function rawSourceExtractionFromRecord(record: NonNullable<Awaited<ReturnType<typeof getLatestRawExtractionForEvent>>>): RawSourceExtraction {
  return {
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    sourceExternalId: record.sourceExternalId,
    url: record.url,
    title: record.title,
    importantHtml: record.importantHtml,
    importantText: record.importantText,
    rawSourceData: asRecord(record.rawSourceData),
    extractedLinks: Array.isArray(record.extractedLinks) ? record.extractedLinks.filter((value): value is string => typeof value === "string") : [],
    fetchedAt: record.fetchedAt.toISOString(),
    contentHash: record.contentHash,
    adapter: record.adapter,
    adapterVersion: record.adapterVersion,
  };
}
