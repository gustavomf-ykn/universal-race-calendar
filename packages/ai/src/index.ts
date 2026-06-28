import { type RaceEventExtraction, raceEventExtractionSchema, type RawSourceExtraction } from "@race-calendar/schemas";
import { cleanText, normalizeDate, normalizeDistanceKm, normalizePrice, normalizeTime, unique } from "@race-calendar/utils";

export type ExtractRaceEventInput = {
  raw: RawSourceExtraction;
  currentEvent?: unknown;
  today?: string;
};

export type AIProvider = {
  name: string;
  model: string;
  extractRaceEvent(input: ExtractRaceEventInput): Promise<RaceEventExtraction>;
};

export type OpenAICompatibleProviderOptions = {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  name?: string;
};

export function createAIProviderFromEnv(): AIProvider {
  const provider = process.env.AI_PROVIDER ?? "mock";
  const model = process.env.AI_MODEL ?? "mock-race-event-v1";
  if (provider === "mock") return new MockAIProvider(model);
  if (provider === "openai-compatible") {
    return new OpenAICompatibleProvider({
      baseUrl: requiredEnv("AI_BASE_URL"),
      apiKey: process.env.AI_API_KEY,
      model,
      timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30000),
      maxRetries: Number(process.env.AI_MAX_RETRIES ?? 2),
      name: "openai-compatible",
    });
  }
  if (provider === "ollama") return new OllamaProvider(model);
  if (provider === "openrouter") {
    return new OpenAICompatibleProvider({
      baseUrl: process.env.AI_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKey: process.env.AI_API_KEY,
      model,
      timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30000),
      maxRetries: Number(process.env.AI_MAX_RETRIES ?? 2),
      name: "openrouter",
    });
  }
  if (provider === "gemini") return new GeminiProvider(model);
  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
}

export class MockAIProvider implements AIProvider {
  name = "mock";

  constructor(readonly model = "mock-race-event-v1") {}

  async extractRaceEvent(input: ExtractRaceEventInput): Promise<RaceEventExtraction> {
    const text = cleanText([input.raw.title, input.raw.importantText].filter(Boolean).join(" "));
    const date = normalizeDate(text);
    const cityState = findCityStateCountry(text);
    const registrationUrl = findUrl(text) ?? input.raw.extractedLinks[0] ?? input.raw.url;
    const distances = unique(text.match(/\b\d+(?:[,.]\d+)?\s*km\b/gi) ?? []).map((label) => ({
      label: cleanText(label.replace(",", ".")),
      distanceKm: normalizeDistanceKm(label),
      modality: "unknown" as const,
      startTime: null,
      elevationGain: null,
      sourceText: label,
      confidence: 0.82,
    }));
    const prices = unique(text.match(/R\$\s*\d+(?:[.,]\d{2})?/gi) ?? []).map((rawPrice, index) => ({
      name: index === 0 ? "Inscricao" : `Lote ${index + 1}`,
      price: normalizePrice(rawPrice),
      currency: "BRL",
      startDate: null,
      endDate: null,
      status: "unknown" as const,
      sourceText: rawPrice,
      confidence: 0.78,
    }));
    const warnings: string[] = [];
    if (!date) warnings.push("missing_date");
    if (!cityState.city) warnings.push("missing_city");
    if (!registrationUrl) warnings.push("missing_registration_url");

    return raceEventExtractionSchema.parse({
      name: evidence(input.raw.title ?? inferName(text), 0.9),
      description: evidence(text.slice(0, 1000) || null, 0.7),
      date: evidence(date, date ? 0.9 : 0),
      startTime: evidence(normalizeTime(text), 0.55),
      endTime: evidence(null, 0),
      city: evidence(cityState.city, cityState.city ? 0.8 : 0),
      state: evidence(cityState.state, cityState.state ? 0.8 : 0),
      country: evidence(cityState.country ?? "BR", 0.65),
      locationName: evidence(null, 0),
      address: evidence(null, 0),
      latitude: null,
      longitude: null,
      modality: inferModality(text),
      distances,
      prices,
      kits: [],
      schedule: [],
      rules: [],
      kitPickup: null,
      registrationUrl: evidence(registrationUrl, registrationUrl ? 0.85 : 0),
      officialUrl: evidence(input.raw.url, 0.7),
      regulationUrl: evidence(findRegulationUrl(input.raw.extractedLinks), 0.6),
      organizerName: evidence(null, 0),
      organizerUrl: evidence(null, 0),
      images: imageUrls(input.raw.rawSourceData),
      eventStatus: inferEventStatus(text),
      confidence: warnings.length ? 0.72 : 0.9,
      warnings,
    });
  }
}

export class StubAIProvider implements AIProvider {
  constructor(
    readonly name: string,
    readonly model: string,
  ) {}

  async extractRaceEvent(): Promise<RaceEventExtraction> {
    throw new Error(`${this.name} provider is configured but not implemented in the MVP. Use AI_PROVIDER=mock.`);
  }
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name ?? "openai-compatible";
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/g, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30000;
    this.maxRetries = Number.isFinite(options.maxRetries) && options.maxRetries != null && options.maxRetries >= 0 ? options.maxRetries : 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async extractRaceEvent(input: ExtractRaceEventInput): Promise<RaceEventExtraction> {
    const content = await this.chatCompletion(buildCurationMessages(input));
    const parsed = parseJsonObjectFromText(content);
    return raceEventExtractionSchema.parse(normalizeRaceEventExtractionPayload(parsed));
  }

  private async chatCompletion(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: withoutUndefined({
            "content-type": "application/json",
            authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined,
          }),
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`AI provider returned ${response.status}: ${text.slice(0, 500)}`);
        const payload = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error("AI provider response did not include choices[0].message.content");
        return content;
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries) break;
        await wait(250 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

export class OllamaProvider extends StubAIProvider {
  constructor(model: string) {
    super("ollama", model);
  }
}

export class OpenRouterProvider extends StubAIProvider {
  constructor(model: string) {
    super("openrouter", model);
  }
}

export class GeminiProvider extends StubAIProvider {
  constructor(model: string) {
    super("gemini", model);
  }
}

export function parseJsonObjectFromText(text: string): unknown {
  const cleaned = cleanText(text);
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? cleaned;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("AI provider response is not valid JSON");
  }
}

export function normalizeRaceEventExtractionPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const normalized: Record<string, unknown> = { ...payload };

  for (const key of [
    "name",
    "description",
    "date",
    "startTime",
    "endTime",
    "city",
    "state",
    "country",
    "locationName",
    "address",
    "registrationUrl",
    "officialUrl",
    "regulationUrl",
    "organizerName",
    "organizerUrl",
  ]) {
    normalized[key] = normalizeEvidenceValue(normalized[key]);
  }

  for (const key of ["distances", "prices", "lots", "kits", "schedule", "rules", "images"]) {
    normalized[key] = normalizeArrayValue(normalized[key]);
  }

  normalized.warnings = normalizeStringArray(normalized.warnings);
  normalized.unstructuredNotes = normalizeStringArray(normalized.unstructuredNotes);

  if (isRecord(normalized.kitPickup)) {
    normalized.kitPickup = {
      ...normalized.kitPickup,
      requiredDocuments: normalizeStringArray(normalized.kitPickup.requiredDocuments),
    };
  }

  normalized.kits = normalizeArrayValue(normalized.kits).map((kit) =>
    isRecord(kit) ? { ...kit, items: normalizeStringArray(kit.items) } : kit,
  );

  return normalized;
}

function normalizeEvidenceValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return { value: null, confidence: 0, sourceText: null };
  if (typeof value === "string") {
    const cleaned = cleanText(value);
    return { value: cleaned || null, confidence: cleaned ? 0.5 : 0, sourceText: cleaned || null };
  }
  return value;
}

function normalizeArrayValue(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStringArray(value: unknown): string[] {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => (typeof entry === "string" ? entry : typeof entry === "number" || typeof entry === "boolean" ? String(entry) : ""))
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function buildCurationMessages(input: ExtractRaceEventInput): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "Voce estrutura dados de corridas de rua para uma API universal de calendario.",
        "Retorne somente JSON valido compatível com RaceEventExtraction.",
        "Nao invente dados: use null quando nao houver evidencia clara.",
        "Use country como codigo ISO-2 real da localizacao do evento, por exemplo BR, PT, US ou AR.",
        "Use state para UF/estado/provincia apenas quando houver evidencia; fora do Brasil pode ser null sem warning se city/country/locationName estiverem claros.",
        "Inclua sourceText nos campos criticos, confidence de 0 a 1, fieldConfidences, warnings e unstructuredNotes.",
        "Nao use confidence 0 quando houver evidencia nos campos principais; se nome, data, cidade/pais e URL estiverem claros, a confidence geral deve ser pelo menos 0.75.",
        "Use warnings apenas para problemas reais de qualidade; nao marque missing_state para eventos internacionais sem estado.",
        "Separe lotes/precos em lots, marque isCurrent apenas quando houver evidencia, e mantenha prices para compatibilidade.",
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          today: input.today ?? new Date().toISOString().slice(0, 10),
          raw: {
            sourceType: input.raw.sourceType,
            sourceExternalId: input.raw.sourceExternalId,
            url: input.raw.url,
            title: input.raw.title,
            importantText: input.raw.importantText.slice(0, 20000),
            rawSourceData: input.raw.rawSourceData,
            extractedLinks: input.raw.extractedLinks,
          },
          currentEvent: input.currentEvent ?? null,
          expectedShape: {
            name: { value: "string|null", confidence: "number", sourceText: "string|null" },
            date: { value: "YYYY-MM-DD|null", confidence: "number", sourceText: "string|null" },
            city: { value: "string|null", confidence: "number", sourceText: "string|null" },
            state: { value: "UF/state/province|null", confidence: "number", sourceText: "string|null" },
            country: { value: "ISO-2 country code|null", confidence: "number", sourceText: "string|null" },
            distances: [{ label: "5 km", distanceKm: 5, modality: "road", confidence: 0.8 }],
            lots: [{ name: "Lote 1", price: 100, currency: "BRL", status: "open", isCurrent: true, confidence: 0.8 }],
            currentLot: { name: "Lote atual", price: 100, currency: "BRL", status: "open", isCurrent: true, confidence: 0.8 },
          },
        },
        null,
        2,
      ),
    },
  ];
}

function evidence(value: string | null | undefined, confidence: number) {
  return {
    value: cleanText(value) || null,
    confidence,
    sourceText: cleanText(value) || null,
  };
}

function inferName(text: string): string | null {
  const sentence = text.split(/[.!?]/)[0];
  return cleanText(sentence).slice(0, 120) || null;
}

function findCityStateCountry(text: string): { city: string | null; state: string | null; country: string | null } {
  const explicit = text.match(/([^.,;:]{2,80}),\s*([A-Z]{2})(?:,\s*(Brasil|BR))?/);
  if (!explicit?.[1] || !explicit[2]) return { city: null, state: null, country: "BR" };

  const city = explicit[1]
    .replace(/\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .trim()
    .split(/\s{2,}| - |\n/)
    .at(-1);

  return {
    city: cleanText(city) || null,
    state: explicit[2].toUpperCase(),
    country: "BR",
  };
}

function findUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s)]+/i)?.[0]?.replace(/[.,;:!?]+$/g, "") ?? null;
}

function findRegulationUrl(urls: string[]): string | null {
  return urls.find((url) => /regulamento|regulation|pdf/i.test(url)) ?? null;
}

function imageUrls(raw: Record<string, unknown>): string[] {
  return [raw.headerImageSource, raw.logoImageSource].filter((value): value is string => typeof value === "string" && value.startsWith("http"));
}

function inferModality(text: string): "road" | "trail" | "mixed" | "kids" | "walk" | "unknown" {
  const lower = text.toLowerCase();
  if (lower.includes("trail")) return "trail";
  if (lower.includes("kids") || lower.includes("infantil")) return "kids";
  if (lower.includes("caminhada")) return "walk";
  if (lower.includes("rua") || lower.includes("maratona") || lower.includes("corrida")) return "road";
  return "unknown";
}

function inferEventStatus(text: string): "scheduled" | "postponed" | "cancelled" | "sold_out" | "finished" | "unknown" {
  const lower = text.toLowerCase();
  if (/cancelad|cancelled/.test(lower)) return "cancelled";
  if (/adiad|postponed/.test(lower)) return "postponed";
  if (/esgotad|sold out/.test(lower)) return "sold_out";
  if (/encerrad|finalizad|finished/.test(lower)) return "finished";
  return "scheduled";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when AI_PROVIDER=openai-compatible`);
  return value;
}

function withoutUndefined(value: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Record<string, string>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
