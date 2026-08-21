import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createAIProviderFromEnv, type AIProvider } from "@race-calendar/ai";
import {
  completeExtractionJob,
  createExtractionJob,
  findSuccessfulCurationJob,
  findCanonicalEventMatch,
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
  discoverCorridasBREvents,
  discoverTicketSportsEvents,
  SourceAdapterRegistry,
  type CorridasBRDiscoveredEvent,
  type DiscoverCorridasBREventsOptions,
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
  status: "success" | "partial_success" | "time_limit_reached";
  source: "ticketsports";
  quickFilter: string;
  requestedQuantity: number;
  offset: number;
  nextOffset: number;
  maxDurationMs: number | null;
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

export type CorridasBRImportResult = {
  jobId: string;
  status: "success" | "partial_success" | "time_limit_reached";
  source: "corridasbr";
  states: string[];
  requestedQuantity: number;
  offset: number;
  nextOffset: number;
  maxDurationMs: number | null;
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
  maxDurationMs?: number;
  registry?: SourceAdapterRegistry;
  discoverEvents?: () => Promise<TicketSportsDiscoveredEvent[]>;
};

export type ImportCorridasBREventsOptions = DiscoverCorridasBREventsOptions & {
  quantity?: number;
  offset?: number;
  delayMs?: number;
  force?: boolean;
  maxDurationMs?: number;
  registry?: SourceAdapterRegistry;
  discoverEvents?: () => Promise<CorridasBRDiscoveredEvent[]>;
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
    if (!options.force && source.lastHash === raw.contentHash && (await hasCurrentCurationForRaw(raw))) {
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
    const deterministicSource = raw.sourceType === "ticketsports" || raw.sourceType === "corridasbr";
    const provider = aiEnabled || !deterministicSource ? createAIProviderFromEnv() : undefined;
    const result = aiEnabled
      ? await curateRawExtractionWithAI(raw, { force: options.force, rawSourceExtractionId: rawRecord.id, provider })
      : provider
        ? await curateSourceExtraction(raw, provider)
        : raw.sourceType === "corridasbr"
          ? await curateCorridasBRSourceExtraction(raw)
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
    const saved = await saveCanonicalEvent(result.normalizedEvent, { contentHash: raw.contentHash });
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
  const maxDurationMs =
    options.maxDurationMs == null
      ? null
      : Math.max(1_000, Math.min(nonNegativeInt(options.maxDurationMs, 0), 30 * 60 * 1_000));
  const registry = options.registry ?? new SourceAdapterRegistry();
  const discoverOptions: DiscoverTicketSportsEventsOptions = { quantity: quantity + offset, quickFilter };
  if (options.client) discoverOptions.client = options.client;
  const allDiscovered = options.discoverEvents ? await options.discoverEvents() : await discoverTicketSportsEvents(discoverOptions);
  const brazilianDiscovered = allDiscovered.filter((event) => event.country.toUpperCase() === "BR");
  const discovered = brazilianDiscovered.slice(offset, offset + quantity);
  const failures: TicketSportsImportResult["failures"] = [];
  let processedCount = 0;
  let publishedEvents = 0;
  let manualReviewEvents = 0;
  let unchangedEvents = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (maxDurationMs != null && Date.now() - startedAt.getTime() >= maxDurationMs) return;
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
        if (result.status === "provider_failed" || result.status === "validation_failed") {
          failures.push({ externalId: item.externalId, error: result.reasons.join(", ") || result.status });
          continue;
        }
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
  const nextOffset = offset + Math.min(cursor, discovered.length);
  const reachedTimeLimit = maxDurationMs != null && processedCount < discovered.length && Date.now() - startedAt.getTime() >= maxDurationMs;
  const result: TicketSportsImportResult = {
    jobId: `import_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    status: reachedTimeLimit ? "time_limit_reached" : failures.length ? "partial_success" : "success",
    source: "ticketsports",
    quickFilter,
    requestedQuantity: quantity,
    offset,
    nextOffset,
    maxDurationMs,
    discoveredCount: brazilianDiscovered.length,
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

export async function importCorridasBREvents(options: ImportCorridasBREventsOptions = {}): Promise<CorridasBRImportResult> {
  const startedAt = new Date();
  const states = (options.states?.length
    ? options.states
    : (process.env.CORRIDASBR_IMPORT_STATES ?? "AC,AL,AM,AP,BA,CE,DF,ES,GO,MA,MG,MS,MT,PA,PB,PE,PI,PR,RJ,RN,RO,RR,RS,SC,SE,SP,TO").split(","))
    .map((state) => cleanText(state).toUpperCase())
    .filter(Boolean);
  const quantity = positiveInt(options.quantity, Number(process.env.CORRIDASBR_IMPORT_QUANTITY ?? 5000));
  const offset = nonNegativeInt(options.offset, Number(process.env.CORRIDASBR_IMPORT_OFFSET ?? 0));
  const concurrency = Math.max(
    1,
    Math.min(positiveInt(options.concurrency, Number(process.env.CORRIDASBR_IMPORT_CONCURRENCY ?? 2)), 5),
  );
  const delayMs = nonNegativeInt(options.delayMs, Number(process.env.CORRIDASBR_IMPORT_DELAY_MS ?? 500));
  const maxDurationMs =
    options.maxDurationMs == null
      ? null
      : Math.max(1_000, Math.min(nonNegativeInt(options.maxDurationMs, 0), 30 * 60 * 1_000));
  const registry = options.registry ?? new SourceAdapterRegistry();
  const discoverOptions: DiscoverCorridasBREventsOptions = { states, concurrency };
  if (options.client) discoverOptions.client = options.client;
  const allDiscovered = options.discoverEvents ? await options.discoverEvents() : await discoverCorridasBREvents(discoverOptions);
  const today = new Date().toISOString().slice(0, 10);
  const futureDiscovered = allDiscovered.filter((event) => !event.date || event.date >= today);
  const discovered = futureDiscovered.slice(offset, offset + quantity);
  const failures: CorridasBRImportResult["failures"] = [];
  let processedCount = 0;
  let publishedEvents = 0;
  let manualReviewEvents = 0;
  let unchangedEvents = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (maxDurationMs != null && Date.now() - startedAt.getTime() >= maxDurationMs) return;
      const item = discovered[cursor];
      cursor += 1;
      if (!item) return;
      try {
        const source = await upsertSourceByAdapterExternalId({
          name: item.name,
          url: item.url,
          type: "aggregator",
          country: item.country,
          state: item.state,
          city: item.city,
          adapter: item.adapter,
          externalId: item.externalId,
          metadata: item.metadata,
          checkIntervalMinutes: null,
        });
        if (delayMs) await wait(delayMs);
        const check = await runSourceCheck(source.id, registry, { force: options.force === true });
        processedCount += 1;
        if (check.status === "provider_failed" || check.status === "validation_failed") {
          failures.push({ externalId: item.externalId, error: check.reasons.join(", ") || check.status });
          continue;
        }
        if (check.status === "success" && check.eventId) publishedEvents += 1;
        if (check.status === "success" && !check.eventId) unchangedEvents += 1;
        if (check.status === "manual_review") manualReviewEvents += 1;
      } catch (error) {
        failures.push({ externalId: item.externalId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, discovered.length) }, () => worker()));
  const nextOffset = offset + Math.min(cursor, discovered.length);
  const reachedTimeLimit =
    maxDurationMs != null && processedCount < discovered.length && Date.now() - startedAt.getTime() >= maxDurationMs;
  const result: CorridasBRImportResult = {
    jobId: `import_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    status: reachedTimeLimit ? "time_limit_reached" : failures.length ? "partial_success" : "success",
    source: "corridasbr",
    states,
    requestedQuantity: quantity,
    offset,
    nextOffset,
    maxDurationMs,
    discoveredCount: futureDiscovered.length,
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
    quickFilter: states.join(","),
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

export type CatalogImportRunInput = {
  mode?: "simulate" | "apply";
  sources?: Array<"ticketsports" | "corridasbr">;
  states?: string[];
  from?: string | null;
  to?: string | null;
  candidateLimit?: number | null;
  force?: boolean;
  enrichOfficialPages?: boolean;
};

export async function createCatalogImportRun(input: CatalogImportRunInput = {}) {
  const mode = input.mode === "apply" ? "apply" : "simulate";
  const sources: Array<"ticketsports" | "corridasbr"> = input.sources?.length
    ? unique(input.sources)
    : ["ticketsports", "corridasbr"];
  const states = input.states?.map((state) => state.toUpperCase()).filter(Boolean) ?? [];
  const from = input.from === "today" || !input.from ? new Date().toISOString().slice(0, 10) : normalizeDate(input.from);
  const to = input.to ? normalizeDate(input.to) : null;
  const defaultLimit = mode === "simulate" ? 100 : Number(process.env.CATALOG_IMPORT_QUANTITY ?? 5000);
  const maximumLimit = mode === "simulate" ? Number(process.env.IMPORT_SIMULATION_MAX_CANDIDATES ?? 200) : 10_000;
  const candidateLimit = Math.min(Math.max(input.candidateLimit ?? defaultLimit, 1), maximumLimit);
  const discovered: Array<{
    sourceType: "ticketsports" | "corridasbr";
    adapter: string;
    externalId: string;
    name: string;
    url: string;
    country: string;
    state: string | null;
    city: string | null;
    date: string | null;
    metadata: Record<string, unknown>;
  }> = [];

  if (sources.includes("ticketsports")) {
    const rows = await discoverTicketSportsEvents({
      quantity: Number(process.env.TICKETSPORTS_IMPORT_QUANTITY ?? 2000),
      quickFilter: process.env.TICKETSPORTS_IMPORT_QUICK_FILTER ?? "corrida-de-rua",
    });
    discovered.push(
      ...rows.map((row) => {
        const listItem = asRecord(row.metadata.listItem);
        return { ...row, date: normalizeDate(stringValue(listItem.realDate) ?? stringValue(listItem.date)) };
      }),
    );
  }
  if (sources.includes("corridasbr")) {
    discovered.push(...(await discoverCorridasBREvents(states.length ? { states } : {})));
  }

  const filtered = discovered
    .filter((row) => !states.length || (row.state && states.includes(row.state)))
    .filter((row) => !from || !row.date || row.date >= from)
    .filter((row) => !to || !row.date || row.date <= to)
    .sort((left, right) => (left.date ?? "9999-12-31").localeCompare(right.date ?? "9999-12-31"))
    .slice(0, candidateLimit);
  const runId = `${mode === "simulate" ? "sim" : "import"}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const now = new Date();
  await prisma.importRun.create({
    data: {
      id: runId,
      source: sources.join(","),
      quickFilter: sources.includes("ticketsports") ? "corrida-de-rua" : states.join(","),
      status: "ready",
      requestedQuantity: candidateLimit,
      offset: 0,
      discoveredCount: filtered.length,
      processedCount: 0,
      publishedEvents: 0,
      manualReviewEvents: 0,
      unchangedEvents: 0,
      failedCount: 0,
      failures: [],
      startedAt: now,
      finishedAt: now,
      mode,
      cursor: 0,
      candidateLimit,
      options: jsonValue(input),
      candidates: {
        create: filtered.map((row) => ({
          sourceType: row.sourceType,
          sourceExternalId: row.externalId,
          sourceUrl: row.url,
          name: row.name,
          date: row.date ? new Date(`${row.date}T00:00:00.000Z`) : null,
          city: row.city,
          state: row.state,
          status: "pending" as const,
          action: "create" as const,
          provenance: jsonValue({
            discovery: row.sourceType,
            adapter: row.adapter,
            metadata: { ...row.metadata, enrichOfficialPages: input.enrichOfficialPages !== false },
          }),
          warnings: [],
        })),
      },
    },
  });
  return getCatalogImportRun(runId);
}

export async function processCatalogImportRun(
  runId: string,
  requestedLimit = 25,
  registry = new SourceAdapterRegistry(),
) {
  const run = await prisma.importRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Import run not found: ${runId}`);
  const limit = Math.min(Math.max(requestedLimit, 1), 25);
  const candidates = await prisma.importCandidate.findMany({
    where: { importRunId: runId, status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  await prisma.importRun.update({ where: { id: runId }, data: { status: "processing" } });
  const failures: Array<{ externalId: string; error: string }> = [];
  let publishedEvents = 0;
  let manualReviewEvents = 0;
  let unchangedEvents = 0;

  for (const candidate of candidates) {
    try {
      if (run.mode === "apply") {
        const priorReference = await prisma.eventSourceReference.findUnique({
          where: {
            sourceType_sourceExternalId: {
              sourceType: candidate.sourceType,
              sourceExternalId: candidate.sourceExternalId,
            },
          },
          include: { event: { select: { id: true, sourceType: true } } },
        });
        const source = await upsertSourceByAdapterExternalId({
          name: candidate.name,
          url: candidate.sourceUrl,
          type: candidate.sourceType === "ticketsports" ? "registration_page" : "aggregator",
          country: "BR",
          state: candidate.state,
          city: candidate.city,
          adapter: candidate.sourceType,
          externalId: candidate.sourceExternalId,
          metadata: asRecord(asRecord(candidate.provenance).metadata),
          checkIntervalMinutes: null,
        });
        const result = await runSourceCheck(source.id, registry, { force: Boolean(asRecord(run.options).force) });
        if (result.status === "provider_failed" || result.status === "validation_failed") {
          const error = result.reasons.join(", ") || result.status;
          failures.push({ externalId: candidate.sourceExternalId, error });
          await prisma.importCandidate.update({
            where: { id: candidate.id },
            data: { status: "failed", action: "review", errorMessage: error, warnings: result.reasons },
          });
          continue;
        }
        const savedReference = result.eventId
          ? await prisma.eventSourceReference.findUnique({
              where: {
                sourceType_sourceExternalId: {
                  sourceType: candidate.sourceType,
                  sourceExternalId: candidate.sourceExternalId,
                },
              },
              include: { event: { select: { sourceType: true } } },
            })
          : null;
        const action = result.reasons.includes("unchanged_content")
          ? "skip"
          : !result.eventId
            ? "review"
            : priorReference
              ? "update"
              : savedReference?.event.sourceType === candidate.sourceType
                ? "create"
                : "link";
        if (result.status === "success" && result.eventId) publishedEvents += 1;
        if (result.status === "manual_review") manualReviewEvents += 1;
        if (action === "skip") unchangedEvents += 1;
        await prisma.importCandidate.update({
          where: { id: candidate.id },
          data: { status: "processed", action, matchEventId: result.eventId ?? priorReference?.event.id ?? null, warnings: result.reasons },
        });
        continue;
      }

      const adapter = registry.findForUrl(candidate.sourceUrl);
      if (!adapter) throw new Error(`No adapter for ${candidate.sourceUrl}`);
      const raw = await adapter.fetchAndExtract({
        sourceId: "simulation",
        sourceExternalId: candidate.sourceExternalId,
        url: candidate.sourceUrl,
        metadata: asRecord(asRecord(candidate.provenance).metadata),
      });
      const curated =
        raw.sourceType === "ticketsports"
          ? await curateTicketSportsSourceExtraction(raw)
          : await curateCorridasBRSourceExtraction(raw);
      const match = await findCanonicalEventMatch(curated.normalizedEvent);
      const action = match?.sameSource ? "update" : match?.automatic ? "link" : match?.score && match.score >= 0.8 ? "review" : "create";
      await prisma.importCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "processed",
          action,
          matchEventId: match?.event.id ?? null,
          matchScore: match?.score ?? null,
          proposedEvent: curated.normalizedEvent,
          displayPreview: catalogDisplayPreview(curated.normalizedEvent),
          provenance: {
            primary: raw.sourceType,
            officialPage: asRecord(raw.rawSourceData).officialPage ? "official" : null,
            contentHash: raw.contentHash,
          },
          warnings: curated.normalizedEvent.warnings,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ externalId: candidate.sourceExternalId, error: message });
      await prisma.importCandidate.update({
        where: { id: candidate.id },
        data: { status: "failed", action: "review", errorMessage: message, warnings: ["source_processing_failed"] },
      });
    }
  }

  const remaining = await prisma.importCandidate.count({ where: { importRunId: runId, status: "pending" } });
  const processedCount = await prisma.importCandidate.count({ where: { importRunId: runId, status: { in: ["processed", "failed"] } } });
  const failedCount = await prisma.importCandidate.count({ where: { importRunId: runId, status: "failed" } });
  await prisma.importRun.update({
    where: { id: runId },
    data: {
      status: remaining ? "ready" : failedCount ? "partial_success" : "success",
      cursor: processedCount,
      processedCount,
      publishedEvents: { increment: publishedEvents },
      manualReviewEvents: { increment: manualReviewEvents },
      unchangedEvents: { increment: unchangedEvents },
      failedCount,
      failures: jsonValue([
        ...(Array.isArray(run.failures) ? run.failures : []),
        ...failures,
      ]),
      finishedAt: new Date(),
    },
  });
  return getCatalogImportRun(runId);
}

export async function getCatalogImportRun(runId: string) {
  return prisma.importRun.findUnique({
    where: { id: runId },
    include: { _count: { select: { candidates: true } } },
  });
}

export async function curateSourceExtraction(
  raw: RawSourceExtraction,
  provider: AIProvider = createAIProviderFromEnv(),
): Promise<CurateSourceExtractionResult> {
  const extraction = await provider.extractRaceEvent({ raw });
  const normalizedEvent = normalizeRaceEventExtraction(extraction, raw);
  const publishability = evaluatePublishability(normalizedEvent);
  const finalEvent = canonicalRaceEventSchema.parse({
    ...normalizedEvent,
    publicationStatus: publishability.publicationStatus,
    publishabilityReasons: publishability.reasons,
    curationStatus: publishability.publicationStatus === "published" ? "curated" : "manual_review",
    curatedAt: new Date().toISOString(),
    curationProvider: provider.name,
    curationModel: provider.model,
    curationVersion: CURATION_PIPELINE_VERSION,
  });
  return {
    extraction,
    normalizedEvent: finalEvent,
    publishability,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    curationVersion: CURATION_PIPELINE_VERSION,
    providerName: provider.name,
    providerModel: provider.model,
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
  const finalEvent = canonicalRaceEventSchema.parse({
    ...normalizedEvent,
    publicationStatus: publishability.publicationStatus,
    publishabilityReasons: publishability.reasons,
    curationStatus: publishability.publicationStatus === "published" ? "curated" : "manual_review",
    curatedAt: new Date().toISOString(),
    curationProvider: "deterministic",
    curationModel: "ticketsports-v1",
    curationVersion: CURATION_PIPELINE_VERSION,
  });
  return {
    extraction,
    normalizedEvent: finalEvent,
    publishability,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    curationVersion: CURATION_PIPELINE_VERSION,
  };
}

export async function curateCorridasBRSourceExtraction(
  raw: RawSourceExtraction,
  extraWarnings: string[] = [],
): Promise<CurateSourceExtractionResult> {
  const extraction = corridasBRExtractionFromRaw(raw);
  if (extraWarnings.length) extraction.warnings = [...new Set([...extraction.warnings, ...extraWarnings])];
  const normalizedEvent = normalizeRaceEventExtraction(extraction, raw);
  const publishability = evaluatePublishability(normalizedEvent);
  const finalEvent = canonicalRaceEventSchema.parse({
    ...normalizedEvent,
    publicationStatus: publishability.publicationStatus,
    publishabilityReasons: publishability.reasons,
    curationStatus: publishability.publicationStatus === "published" ? "curated" : "manual_review",
    curatedAt: new Date().toISOString(),
    curationProvider: "deterministic",
    curationModel: "corridasbr-v1",
    curationVersion: CURATION_PIPELINE_VERSION,
  });
  return {
    extraction,
    normalizedEvent: finalEvent,
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
    const saved = await saveCanonicalEvent(result.normalizedEvent, { contentHash: raw.contentHash });
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

async function hasCurrentCurationForRaw(raw: RawSourceExtraction): Promise<boolean> {
  const externalIdentity =
    raw.sourceType && raw.sourceExternalId
      ? [
          { sourceType: raw.sourceType, sourceExternalId: raw.sourceExternalId },
          { sourceReferences: { some: { sourceType: raw.sourceType, sourceExternalId: raw.sourceExternalId } } },
        ]
      : [];
  const existing = await prisma.event.findFirst({
    where: {
      OR: [
        ...externalIdentity,
        { sourceId: raw.sourceId },
        { sourceReferences: { some: { sourceId: raw.sourceId } } },
      ],
    },
    select: {
      curatedAt: true,
      curationStatus: true,
      curationVersion: true,
    },
  });
  return Boolean(
    existing?.curatedAt &&
      existing.curationVersion === CURATION_PIPELINE_VERSION &&
      existing.curationStatus &&
      existing.curationStatus !== "not_curated",
  );
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
  const importantText = repairMojibake(raw.importantText);
  const address = cleanText(repairMojibake(stringValue(record.address)));
  const location = parseTicketSportsLocation(address);
  const title = cleanText(repairMojibake(stringValue(record.title) ?? raw.title ?? "Evento TicketSports"));
  const realDate = stringValue(record.realDate);
  const date = realDate ?? stringValue(record.date);
  const registrationUrl = stringValue(record.uri) ?? raw.url;
  const images = unique([stringValue(record.headerImageSource), stringValue(record.logoImageSource)].filter(isStringUrl));
  const text = cleanText([title, date, address, repairMojibake(stringValue(record.organizer)), stringValue(record.status), importantText].filter(Boolean).join(" "));
  const prices = pricesFromText(text, { endDate: stringValue(record.signUpDeadLine) });
  const kitPickup = kitPickupFromText(text, { date, locationName: location.locationName, address });
  const schedule = scheduleFromText(text, { date, startTime: realDate, locationName: location.locationName, address, kitPickup });
  const rules = enhancedRulesFromTicketSports(record, text);
  const warnings: string[] = [];
  if (!normalizeDate(date)) warnings.push("missing_date");
  if (!location.city) warnings.push("missing_city");
  if (!location.state) warnings.push("missing_state");
  if (location.suspiciousCity) warnings.push("suspicious_city");
  if (!registrationUrl) warnings.push("missing_registration_url");
  const confidence = warnings.length ? 0.72 : 0.92;

  return raceEventExtractionSchema.parse({
    name: evidence(title, 0.95),
    description: evidence(importantText || title, 0.75),
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
    prices,
    lots: prices,
    currentLot: prices[0] ?? null,
    kits: kitsFromTicketSportsText(text),
    schedule,
    rules,
    kitPickup,
    registrationUrl: evidence(registrationUrl, registrationUrl ? 0.95 : 0),
    officialUrl: evidence(raw.url, 0.85),
    regulationUrl: evidence(findRegulationUrl([...raw.extractedLinks, ...linksFromTicketSportsRecord(record)]), 0.75),
    organizerName: evidence(repairMojibake(stringValue(record.organizer)), stringValue(record.organizer) ? 0.9 : 0),
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

function corridasBRExtractionFromRaw(raw: RawSourceExtraction): RaceEventExtraction {
  const root = asRecord(raw.rawSourceData);
  const record = asRecord(root.corridasbr);
  const official = asRecord(root.officialPage);
  const jsonLd = asRecord(official.jsonLdEvent);
  const jsonLocation = asRecord(jsonLd.location);
  const jsonAddress = asRecord(jsonLocation.address);
  const name = cleanText(stringValue(record.name) ?? raw.title ?? stringValue(official.title) ?? "Evento CorridasBR");
  const date = stringValue(record.date) ?? stringValue(jsonLd.startDate);
  const city = cleanText(stringValue(record.city) ?? stringValue(jsonAddress.addressLocality));
  const state = cleanText(stringValue(record.state) ?? stringValue(jsonAddress.addressRegion)).toUpperCase();
  const locationName = cleanText(stringValue(record.locationName) ?? stringValue(jsonLocation.name));
  const distanceText = cleanText(stringValue(record.distanceText));
  const organizerName = cleanText(stringValue(record.organizerName) ?? nestedString(jsonLd.organizer, "name"));
  const officialUrl = stringValue(record.officialUrl) ?? stringValue(official.url) ?? raw.url;
  const prices = pricesFromJsonLdOffers(jsonLd.offers);
  const offerUrl = registrationUrlFromJsonLdOffers(jsonLd.offers);
  const registrationUrl = offerUrl ?? (looksLikeRegistrationUrl(officialUrl) ? officialUrl : null);
  const images = Array.isArray(official.images)
    ? official.images.flatMap((value) => (typeof value === "string" && isStringUrl(value) ? [value] : []))
    : [];
  const description = cleanText(stringValue(official.description));
  const warnings: string[] = [];
  if (!normalizeDate(date)) warnings.push("missing_date");
  if (!city) warnings.push("missing_city");
  if (!state) warnings.push("missing_state");
  const distances = distancesFromText(distanceText).map((distance) => ({
    ...distance,
    sourceText: distanceText,
    confidence: Math.max(distance.confidence, 0.9),
  }));
  if (!distances.length) warnings.push("no_distances_found");
  const confidence = normalizeDate(date) && city && state ? 0.92 : 0.72;

  return raceEventExtractionSchema.parse({
    name: evidence(name, 0.96),
    description: evidence(description || raw.importantText, description ? 0.82 : 0.68),
    date: evidence(date, date ? 0.95 : 0),
    startTime: evidence(stringValue(jsonLd.startDate), jsonLd.startDate ? 0.85 : 0),
    endTime: evidence(stringValue(jsonLd.endDate), jsonLd.endDate ? 0.8 : 0),
    city: evidence(city, city ? 0.95 : 0),
    state: evidence(state, state ? 0.98 : 0),
    country: evidence("BR", 1),
    locationName: evidence(locationName, locationName ? 0.9 : 0),
    address: evidence(nestedAddress(jsonLd.location) ?? locationName, jsonAddress.streetAddress ? 0.85 : locationName ? 0.72 : 0),
    latitude: numberOrNull(asRecord(jsonLocation.geo).latitude),
    longitude: numberOrNull(asRecord(jsonLocation.geo).longitude),
    modality: modalityFromTicketSportsText(name, `${name} ${distanceText} ${description}`),
    distances,
    prices,
    lots: prices,
    currentLot: prices.find((price) => price.isCurrent) ?? null,
    kits: [],
    schedule: [],
    rules: [],
    kitPickup: null,
    registrationUrl: evidence(registrationUrl, registrationUrl ? 0.85 : 0),
    officialUrl: evidence(officialUrl, 0.9),
    regulationUrl: evidence(null, 0),
    organizerName: evidence(organizerName, organizerName ? 0.88 : 0),
    organizerUrl: evidence(nestedString(jsonLd.organizer, "url"), nestedString(jsonLd.organizer, "url") ? 0.8 : 0),
    images,
    eventStatus: "scheduled",
    confidence,
    fieldConfidences: {
      name: 0.96,
      date: date ? 0.95 : 0,
      city: city ? 0.95 : 0,
      state: state ? 0.98 : 0,
      images: images.length ? 0.82 : 0,
    },
    unstructuredNotes: [],
    warnings,
  });
}

function evidence(value: string | null | undefined, confidence: number) {
  return {
    value: cleanText(repairMojibake(value)) || null,
    confidence,
    sourceText: cleanText(repairMojibake(value)) || null,
  };
}

function repairMojibake(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!/[ÃÂâ€]/.test(value)) return value;
  try {
    return Buffer.from(value, "latin1").toString("utf8");
  } catch {
    return value;
  }
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
  const country = countryFromTicketSportsText(text) ?? "BR";
  const locationName = stripCountrySuffix(text.split(":")[0] ?? "") || null;
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

function countryFromTicketSportsText(value: string): string | null {
  const text = stripDiacritics(cleanText(value).toLowerCase());
  if (!text) return null;
  if (/(^|[\s,;:])(brasil|brazil|br)(?=$|[\s,;:.])/.test(text)) return "BR";
  const countries: Array<[RegExp, string]> = [
    [/(^|[\s,;:])portugal(?=$|[\s,;:.])/, "PT"],
    [/(^|[\s,;:])argentina(?=$|[\s,;:.])/, "AR"],
    [/(^|[\s,;:])chile(?=$|[\s,;:.])/, "CL"],
    [/(^|[\s,;:])(uruguai|uruguay)(?=$|[\s,;:.])/, "UY"],
    [/(^|[\s,;:])(paraguai|paraguay)(?=$|[\s,;:.])/, "PY"],
    [/(^|[\s,;:])bolivia(?=$|[\s,;:.])/, "BO"],
    [/(^|[\s,;:])peru(?=$|[\s,;:.])/, "PE"],
    [/(^|[\s,;:])colombia(?=$|[\s,;:.])/, "CO"],
    [/(^|[\s,;:])mexico(?=$|[\s,;:.])/, "MX"],
    [/(^|[\s,;:])(estados unidos|eua|usa|united states)(?=$|[\s,;:.])/, "US"],
    [/(^|[\s,;:])(espanha|spain)(?=$|[\s,;:.])/, "ES"],
  ];
  return countries.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function stripCountrySuffix(value: string): string | null {
  return cleanText(
    value.replace(
      /,\s*(Portugal|Argentina|Chile|Uruguai|Uruguay|Paraguai|Paraguay|Bolivia|Peru|Colombia|Mexico|México|Estados Unidos|EUA|USA|United States|Espanha|Spain)\b\.?$/i,
      "",
    ),
  );
}

function distancesFromText(text: string): RaceEventExtraction["distances"] {
  const byDistanceKm = new Map<number, RaceEventExtraction["distances"][number]>();
  const sections = preferredDistanceSections(text);
  const searchText = sections.length ? sections.join(" ") : text;
  for (const match of Array.from(searchText.matchAll(/\b(?:[1-9]\d?(?:[,.]\d+)?)\s*(?:km|k)\b/gi))) {
    const label = match[0];
    const index = match.index ?? 0;
    const context = cleanText(searchText.slice(Math.max(0, index - 80), Math.min(searchText.length, index + 100)));
    if (!sections.length && nonRouteDistanceContext(context)) continue;
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

function preferredDistanceSections(text: string): string[] {
  const percursos = textSection(text, /(?:^|\s)PERCURSOS?\b/i, [
    /\bO QUE TE ESPERA\b/i,
    /\bMODALIDADES?\b/i,
    /\bDIFERENCIAIS\b/i,
    /\bRETIRADA DE KIT\b/i,
    /\bINFORMA/i,
  ]);
  if (percursos) return [percursos];

  const distances = textSection(text, /(?:^|\s)(DISTANCIAS?|PROVAS?)\b/i, [
    /\bO QUE TE ESPERA\b/i,
    /\bMODALIDADES?\b/i,
    /\bDIFERENCIAIS\b/i,
    /\bRETIRADA DE KIT\b/i,
    /\bINFORMA/i,
  ]);
  if (distances) return [distances];

  const modalities = textSection(text, /(?:^|\s)MODALIDADES?\b/i, [
    /\bDIFERENCIAIS\b/i,
    /\bRETIRADA DE KIT\b/i,
    /\bINFORMA/i,
  ]);
  return modalities ? [modalities] : [];
}

function textSection(text: string, startPattern: RegExp, endPatterns: RegExp[], maxLength = 900): string | null {
  const start = startPattern.exec(text);
  if (start?.index == null) return null;
  const startIndex = start.index + start[0].length;
  const tail = text.slice(startIndex, startIndex + maxLength);
  const endIndexes = endPatterns.flatMap((pattern) => {
    const match = pattern.exec(tail);
    return match?.index != null ? [match.index] : [];
  });
  const endIndex = endIndexes.length ? Math.min(...endIndexes) : tail.length;
  return cleanText(tail.slice(0, endIndex)) || null;
}

function nonRouteDistanceContext(context: string): boolean {
  return /raio|domicilio|entrega|distancia maxima|ate\s+\d/i.test(stripDiacritics(context.toLowerCase()));
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

function pricesFromText(text: string, options: { endDate?: string | null } = {}): RaceEventExtraction["prices"] {
  const prices: RaceEventExtraction["prices"] = [];
  const matches = Array.from(text.matchAll(/R\$\s*\d+(?:\.\d{3})*(?:[.,]\d{2})?/gi));
  for (const match of matches) {
    const rawPrice = match[0];
    const index = match.index ?? 0;
    const context = cleanText(text.slice(Math.max(0, index - 120), Math.min(text.length, index + 120)));
    const normalizedContext = stripDiacritics(context.toLowerCase());
    if (!/(inscric|lote|a partir|valor|vagas)/.test(normalizedContext)) continue;
    if (/(retirada de kit|entrega de kit|domicilio|taxa)/.test(normalizedContext) && !/(inscric|lote)/.test(normalizedContext)) continue;
    const lotName = context.match(/(?:\b\d{1,2}[ºo]?\s*lote|lote\s*\d{1,2})/i)?.[0] ?? (prices.length === 0 ? "Inscricao" : `Lote ${prices.length + 1}`);
    if (prices.some((price) => price.price === normalizePrice(rawPrice))) continue;
    prices.push({
      name: cleanText(lotName),
      price: normalizePrice(rawPrice),
      currency: "BRL",
      startDate: null,
      endDate: normalizeDate(options.endDate),
      status: /vagas limitadas|aberto|garanta|inscric/i.test(context) ? "open" : "unknown",
      isCurrent: prices.length === 0,
      sourceText: context || rawPrice,
      confidence: 0.84,
    });
  }
  return prices;
}

function kitsFromTicketSportsText(text: string): RaceEventExtraction["kits"] {
  const section =
    textSection(text, /\bO QUE TE ESPERA\b/i, [/\bMODALIDADES?\b/i, /\bDIFERENCIAIS\b/i, /\bRETIRADA DE KIT\b/i], 900) ??
    textSection(text, /\bKIT\b/i, [/\bRETIRADA\b/i, /\bREGULAMENTO\b/i, /\bINFORMA/i], 700) ??
    text;
  const normalized = stripDiacritics(section.toLowerCase());
  const items = unique([
    normalized.includes("medalha") ? "Medalha para concluintes" : null,
    normalized.includes("camiseta") ? "Camiseta" : null,
    normalized.includes("numero de peito") ? "Numero de peito" : null,
    normalized.includes("chip") ? "Chip de cronometragem" : null,
    normalized.includes("cerveja") ? "Cerveja ao final da prova" : null,
  ].filter((item): item is string => Boolean(item)));
  if (!items.length) return [];
  return [
    {
      name: "Kit/beneficios do atleta",
      items,
      price: null,
      sourceText: section,
      confidence: 0.68,
    },
  ];
}

function kitPickupFromText(
  text: string,
  event: { date: string | null | undefined; locationName: string | null; address: string | null },
): RaceEventExtraction["kitPickup"] {
  const normalized = stripDiacritics(text.toLowerCase());
  const pickupIndex = normalized.indexOf("retirada de kit");
  if (pickupIndex < 0) return null;
  const section = cleanText(text.slice(pickupIndex, Math.min(text.length, pickupIndex + 900)));
  const timeRange = section.match(/entre\s+(\d{1,2})h(?:\d{2})?\s+e\s+(\d{1,2})h(?:\d{2})?/i);
  const dayOfEvent = /dia do evento|dia da prova/i.test(section);
  return {
    location: dayOfEvent ? event.locationName : null,
    address: dayOfEvent ? event.address : null,
    date: dayOfEvent ? normalizeDate(event.date) : null,
    startTime: timeRange?.[1] ? `${timeRange[1].padStart(2, "0")}:00` : null,
    endTime: timeRange?.[2] ? `${timeRange[2].padStart(2, "0")}:00` : null,
    requiredDocuments: /terceir/i.test(section) ? ["Formulario para retirada de kit por terceiros"] : [],
    sourceText: section,
    confidence: 0.72,
  };
}

function scheduleFromText(
  text: string,
  event: {
    date: string | null | undefined;
    startTime: string | null | undefined;
    locationName: string | null;
    address: string | null;
    kitPickup: RaceEventExtraction["kitPickup"];
  },
): RaceEventExtraction["schedule"] {
  const schedule: RaceEventExtraction["schedule"] = [];
  const eventDate = normalizeDate(event.date);
  const startTime = normalizeTime(event.startTime) ?? normalizeTime(text.match(/largada(?:\s+a partir)?\s+d(?:as|e)\s+(\d{1,2}h(?:\d{2})?)/i)?.[1]);
  if (eventDate || startTime) {
    schedule.push({
      date: eventDate,
      time: startTime,
      activity: "Largada",
      location: event.locationName ?? event.address,
      sourceText: cleanText(text.match(/largada[^.]{0,80}/i)?.[0]) || event.startTime || null,
      confidence: startTime ? 0.82 : 0.62,
    });
  }
  if (event.kitPickup?.date || event.kitPickup?.startTime) {
    schedule.push({
      date: event.kitPickup.date,
      time: event.kitPickup.startTime,
      activity: "Retirada de kit no dia do evento",
      location: event.kitPickup.location,
      sourceText: event.kitPickup.sourceText,
      confidence: event.kitPickup.confidence,
    });
  }
  return schedule;
}

function rulesFromTicketSports(record: Record<string, unknown>, text: string): RaceEventExtraction["rules"] {
  const rules: RaceEventExtraction["rules"] = [];
  const regulationUrl = stringValue(record.regulationDocument);
  if (regulationUrl) {
    rules.push({
      category: "general",
      text: `Regulamento disponivel em ${regulationUrl}`,
      sourceText: regulationUrl,
      confidence: 0.9,
    });
  }
  const pcd = text.match(/PCD[^.]{0,180}/i)?.[0];
  if (pcd) rules.push({ category: "pcd", text: cleanText(pcd), sourceText: pcd, confidence: 0.75 });
  const awards = text.match(/premia[cç][aã]o[^.]{0,220}/i)?.[0];
  if (awards) rules.push({ category: "awards", text: cleanText(awards), sourceText: awards, confidence: 0.72 });
  return rules;
}

function enhancedRulesFromTicketSports(record: Record<string, unknown>, text: string): RaceEventExtraction["rules"] {
  const rules = rulesFromTicketSports(record, text);
  const normalizedText = stripDiacritics(text.toLowerCase());
  const addRule = (category: RaceEventExtraction["rules"][number]["category"], value: string | null | undefined, confidence: number) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    if (rules.some((rule) => rule.category === category && rule.text === cleaned)) return;
    rules.push({ category, text: cleaned, sourceText: cleaned, confidence });
  };

  addRule("age", text.match(/idosos?\s*60\+?[^.]{0,120}(?:off|desconto)/i)?.[0], 0.78);
  addRule("kit_pickup", text.match(/retirada de kit no dia do evento[^.]{0,360}/i)?.[0], 0.82);
  addRule("documents", text.match(/formul[aá]rio para retirada de kit por terceiros[^.]{0,180}/i)?.[0], 0.78);
  addRule(
    "route",
    normalizedText.includes("percurso em meio a natureza") || normalizedText.includes("corrida em trilhas")
      ? text.match(/(?:Corrida em trilhas|Percurso em meio)[^.]{0,160}/i)?.[0]
      : null,
    0.72,
  );
  addRule("awards", text.match(/premia(?:c|ç)(?:a|ã)o[^.]{0,220}/i)?.[0], 0.72);
  return rules;
}

function linksFromTicketSportsRecord(record: Record<string, unknown>): string[] {
  const links = [
    stringValue(record.uri),
    stringValue(record.regulationDocument),
    ...asRecordArray(record.eventContents).flatMap((content) => extractLinksFromHtml(stringValue(content.description) ?? "")),
  ];
  return unique(links.filter(isStringUrl));
}

function extractLinksFromHtml(html: string): string[] {
  return Array.from(html.matchAll(/href=["']([^"']+)["']/gi)).flatMap((match) => (match[1] ? [match[1]] : []));
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

function jsonValue(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((record) => Object.keys(record).length > 0) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nestedString(value: unknown, key: string): string | null {
  return stringValue(asRecord(value)[key]);
}

function nestedAddress(value: unknown): string | null {
  const location = asRecord(value);
  const address = asRecord(location.address);
  if (typeof location.address === "string") return location.address;
  return cleanText(
    [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode]
      .filter((part): part is string => typeof part === "string")
      .join(", "),
  ) || null;
}

function looksLikeRegistrationUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      /(ticketsports|sympla|minhasinscricoes|atletis|quantoskm|ticketagora|vemcorrer)/i.test(parsed.hostname) ||
      /(inscri|evento|event|checkout|ticket)/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function pricesFromJsonLdOffers(value: unknown): RaceEventExtraction["prices"] {
  const offers = Array.isArray(value) ? value.map(asRecord) : Object.keys(asRecord(value)).length ? [asRecord(value)] : [];
  return offers.flatMap((offer) => {
    const rawPrice = offer.price ?? offer.lowPrice;
    const price = normalizePrice(typeof rawPrice === "string" || typeof rawPrice === "number" ? rawPrice : null);
    if (price == null || price < 20 || price > 1000) return [];
    const currency = cleanText(stringValue(offer.priceCurrency) ?? "BRL").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return [];
    const availability = cleanText(stringValue(offer.availability)).toLowerCase();
    const status = availability.includes("soldout")
      ? "sold_out"
      : availability.includes("instock") || availability.includes("onlineonly")
        ? "open"
        : "unknown";
    const name = cleanText(stringValue(offer.name) ?? stringValue(offer.category) ?? "Inscrição");
    const sourceText = cleanText(
      `Oferta de inscrição: ${name}; valor ${currency} ${price}; ${stringValue(offer.availability) ?? "disponibilidade não informada"}`,
    );
    return [{
      name,
      price,
      currency,
      startDate: normalizeDate(stringValue(offer.validFrom)),
      endDate: normalizeDate(stringValue(offer.priceValidUntil) ?? stringValue(offer.validThrough)),
      status,
      isCurrent: status === "open",
      sourceText,
      confidence: 0.84,
    }];
  });
}

function registrationUrlFromJsonLdOffers(value: unknown): string | null {
  const offers = Array.isArray(value) ? value.map(asRecord) : Object.keys(asRecord(value)).length ? [asRecord(value)] : [];
  return offers
    .map((offer) => stringValue(offer.url))
    .find((url): url is string => isStringUrl(url)) ?? null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
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

function catalogDisplayPreview(event: CanonicalRaceEvent) {
  const distances = event.distances
    .filter((distance) => {
      const evidence = cleanText(distance.sourceText).toLowerCase();
      return (
        distance.distanceKm != null &&
        distance.distanceKm > 0 &&
        distance.distanceKm <= 100 &&
        distance.confidence >= 0.65 &&
        Boolean(evidence) &&
        !/(raio|entrega|frete|endereco|idade|anos|horario|retirada)/i.test(evidence)
      );
    })
    .map((distance) => distance.label);
  const prices = event.prices.filter((price) => {
    const evidence = cleanText(price.sourceText).toLowerCase();
    return (
      price.price != null &&
      price.price >= 20 &&
      price.price <= 1000 &&
      price.confidence >= 0.65 &&
      /(inscric|lote|valor|preco|a partir|vagas|participacao)/i.test(evidence) &&
      (!/(retirada de kit|entrega de kit|domicilio|frete|estacionamento|doacao|multa)/i.test(evidence) || /(inscric|lote)/i.test(evidence))
    );
  });
  const currentLot = prices.find((price) => price.isCurrent) ?? prices[0] ?? null;
  const kitItems = event.kits
    .filter((kit) => kit.confidence >= 0.55)
    .flatMap((kit) => kit.items)
    .filter(Boolean);
  const primaryUrl = event.registrationUrl ?? event.officialUrl ?? event.sourceUrl;
  const primaryType = event.registrationUrl ? "registration" : event.officialUrl ? "official" : "source";
  return {
    coverImageUrl: event.mainImageUrl ?? event.images[0] ?? null,
    locationLabel: event.city && event.state ? `${event.city}, ${event.state}` : event.state,
    distances,
    currentPrice: currentLot?.price ?? null,
    currentLotName: currentLot?.name ?? null,
    currency: currentLot?.currency ?? null,
    kitSummary: kitItems.length ? kitItems.slice(0, 3).join(", ") : null,
    primaryAction: primaryUrl
      ? {
          type: primaryType,
          label: primaryType === "registration" ? "Inscrever-se" : primaryType === "official" ? "Ver informacoes" : "Ver fonte",
          url: primaryUrl,
        }
      : null,
  };
}
