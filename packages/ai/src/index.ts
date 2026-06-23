import { type RaceEventExtraction, raceEventExtractionSchema, type RawSourceExtraction } from "@race-calendar/schemas";
import { cleanText, normalizeDate, normalizeDistanceKm, normalizePrice, normalizeTime, unique } from "@race-calendar/utils";

export type ExtractRaceEventInput = {
  raw: RawSourceExtraction;
};

export type AIProvider = {
  name: string;
  model: string;
  extractRaceEvent(input: ExtractRaceEventInput): Promise<RaceEventExtraction>;
};

export function createAIProviderFromEnv(): AIProvider {
  const provider = process.env.AI_PROVIDER ?? "mock";
  const model = process.env.AI_MODEL ?? "mock-race-event-v1";
  if (provider === "mock") return new MockAIProvider(model);
  if (provider === "ollama") return new OllamaProvider(model);
  if (provider === "openrouter") return new OpenRouterProvider(model);
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
