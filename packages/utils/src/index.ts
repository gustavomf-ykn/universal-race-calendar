import { createHash } from "node:crypto";

export const ADAPTER_VERSION_TICKETSPORTS = atLeastSemver(process.env.ADAPTER_VERSION_TICKETSPORTS, "1.1.0");
export const ADAPTER_VERSION_CORRIDASBR = atLeastSemver(process.env.ADAPTER_VERSION_CORRIDASBR, "1.1.0");
export const ADAPTER_VERSION_OFFICIAL_PAGE = atLeastSemver(process.env.ADAPTER_VERSION_OFFICIAL_PAGE, "1.1.0");
export const CANONICAL_SCHEMA_VERSION = process.env.CANONICAL_SCHEMA_VERSION ?? "1.0.0";
export const CURATION_PIPELINE_VERSION = atLeastSemver(process.env.CURATION_PIPELINE_VERSION, "1.7.0");

export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export type SourceModality = "road" | "trail" | "mixed" | "kids" | "walk" | "unknown";

/** Classify only explicit race/route evidence, never an address or a generic race name. */
export function modalityFromSourceText(title: string, text: string): {
  modality: SourceModality;
  evidence: Array<{ modality: Exclude<SourceModality, "mixed" | "unknown">; sourceText: string }>;
} {
  const evidence: Array<{ modality: Exclude<SourceModality, "mixed" | "unknown">; sourceText: string }> = [];
  const patterns: Array<["road" | "trail", RegExp]> = [
    ["road", /\b(?:corrida(?:s)?|maratona(?:s)?|prova(?:s)?)\s+de\s+rua\b|\b(?:road|street)\s+(?:running|race|run)\b|\b(?:percurso(?:s)?|corrida(?:s)?)\s+(?:em|no|de)\s+asfalto\b|\bmodalidade\s*:\s*(?:rua|road)\b/gi],
    ["trail", /\btrail\s+(?:running|run|race)\b|\b(?:corrida(?:s)?|prova(?:s)?)\s+de\s+montanha\b|\b(?:corrida(?:s)?|percurso(?:s)?)\s+(?:em|de|pela(?:s)?|com)\s+trilha(?:s)?\b|\bmodalidade\s*:\s*trail\b/gi],
  ];
  // Keep the original text offsets, including decomposed accents and Unicode before a quote.
  for (const original of [title, text]) {
    const normalized = original;
    for (const [modality, pattern] of patterns) {
      for (const match of normalized.matchAll(pattern)) {
        const index = match.index;
        const prefix = normalized.slice(Math.max(0, index - 100), index);
        const clause = prefix.split(/[.!?;\n]/).at(-1) ?? "";
        if (/\b(?:nao|not|sem|acesse|clique|veja tambem|outras provas|menu)\b[^.!?;\n]*$/i.test(stripAccents(clause))) continue;
        evidence.push({ modality, sourceText: original.slice(index, index + match[0].length) });
      }
    }
  }
  // A standalone Trail in the event title is evidence; a navigation link in the body is not.
  if (!evidence.some(item => item.modality === "trail") && /\btrail\b/i.test(title)
    && !/\b(?:nao|not|sem)\b/i.test(stripAccents(title))) {
    const match = title.match(/\btrail\b/i)!;
    evidence.push({ modality: "trail", sourceText: match[0] });
  }
  const surfaces = new Set(evidence.map(item => item.modality));
  if (surfaces.size > 1) return { modality: "mixed", evidence };
  if (surfaces.has("road")) return { modality: "road", evidence };
  if (surfaces.has("trail")) return { modality: "trail", evidence };
  const titleOnly = stripAccents(title);
  const kids = title.match(/\b(?:kids?|infantil)\b/i);
  if (kids && !/\b(?:nao|not|sem)\b/i.test(titleOnly))
    return { modality: "kids", evidence: [{ modality: "kids", sourceText: kids[0] }] };
  const walk = title.match(/\bcaminhada\b/i);
  if (walk && !/\b(?:corrida|maratona|run|trail|nao|not|sem)\b/i.test(titleOnly))
    return { modality: "walk", evidence: [{ modality: "walk", sourceText: walk[0] }] };
  return { modality: "unknown", evidence: [] };
}

const countryLabels: Record<string, string> = {
  brasil: "BR", brazil: "BR", br: "BR", portugal: "PT", pt: "PT", argentina: "AR",
  chile: "CL", uruguai: "UY", uruguay: "UY", paraguai: "PY", paraguay: "PY",
  bolivia: "BO", peru: "PE", colombia: "CO", mexico: "MX", "estados unidos": "US",
  eua: "US", usa: "US", "united states": "US", espanha: "ES", spain: "ES",
};

/** A labelled country field may use a recognised ISO code; never apply this to a UF. */
export function countryFromExplicitValue(value: string | null | undefined): { country: string | null; sourceText: string | null } {
  const sourceText = cleanText(value).replace(/[.]+$/, "");
  const key = stripAccents(sourceText.toLowerCase());
  const country = Object.hasOwn(countryLabels, key) ? countryLabels[key]!
    : Object.values(countryLabels).includes(sourceText.toUpperCase()) ? sourceText.toUpperCase() : null;
  return { country, sourceText: sourceText || null };
}

/** Only explicit country components in a location; a UF, domain or request filter is not evidence. */
export function countryFromLocationText(value: string | null | undefined): {
  country: string | null;
  sourceText: string | null;
  conflicting: boolean;
} {
  const components: Array<{ country: string; sourceText: string }> = [];
  for (const component of (value ?? "").split(/[,;\n]/).reverse()) {
    const sourceText = cleanText(component).replace(/[.]+$/, "");
    if (!sourceText) continue;
    const key = stripAccents(sourceText.toLowerCase());
    const country = Object.hasOwn(countryLabels, key) ? countryLabels[key] : undefined;
    if (!country) break;
    components.unshift({ country, sourceText });
  }
  const distinct = new Set(components.map(component => component.country));
  if (distinct.size !== 1) return { country: null, sourceText: null, conflicting: distinct.size > 1 };
  return { country: components[0]!.country, sourceText: components[0]!.sourceText, conflicting: false };
}

export function normalizeKey(value: string | null | undefined): string {
  return stripAccents(cleanText(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeCompact(value: string | null | undefined): string {
  return normalizeKey(value).replace(/\s+/g, "-");
}

export function slugify(value: string): string {
  return normalizeCompact(value).replace(/(^-|-$)/g, "").slice(0, 90) || "evento";
}

export function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function atLeastSemver(value: string | null | undefined, minimum: string): string {
  const parsedValue = parseSemver(value);
  const parsedMinimum = parseSemver(minimum);
  if (!parsedMinimum) return value ?? minimum;
  if (!parsedValue) return minimum;
  for (let index = 0; index < parsedMinimum.length; index += 1) {
    const current = parsedValue[index] ?? 0;
    const floor = parsedMinimum[index] ?? 0;
    if (current > floor) return value!;
    if (current < floor) return minimum;
  }
  return value!;
}

function parseSemver(value: string | null | undefined): [number, number, number] | null {
  const match = cleanText(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function normalizeDate(value: string | null | undefined, fallbackYear = new Date().getFullYear()): string | null {
  const text = cleanText(value);
  // JSON-LD startDate commonly has a T-separated time. A word boundary alone
  // misses those dates; preserve the source's calendar day without timezone shifts.
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?=\b|T\d{2}:\d{2})/);
  if (iso?.[0] && isValidIsoDate(iso[0])) return iso[0];

  const br = text.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  if (!br) return null;

  const day = br[1]!.padStart(2, "0");
  const month = br[2]!.padStart(2, "0");
  let year = br[3] ?? String(fallbackYear);
  if (year.length === 2) year = `20${year}`;
  const parsed = `${year}-${month}-${day}`;
  return isValidIsoDate(parsed) ? parsed : null;
}

export function normalizeTime(value: string | null | undefined): string | null {
  const text = cleanText(value).toLowerCase();
  const match = text.match(/\b([01]?\d|2[0-3])(?::|h)([0-5]\d)?\b/);
  if (!match) return null;
  return `${match[1]!.padStart(2, "0")}:${match[2] ?? "00"}`;
}

export function normalizePrice(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/(?:R\$\s*)?(\d[\d.,]*)/i);
  if (!match) return null;
  const token = match[1]!;
  const commaIndex = token.lastIndexOf(",");
  const dotIndex = token.lastIndexOf(".");
  let normalized = token;

  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = token.replaceAll(thousandsSeparator, "").replace(decimalSeparator, ".");
  } else if (commaIndex >= 0 || dotIndex >= 0) {
    const separator = commaIndex >= 0 ? "," : ".";
    const pieces = token.split(separator);
    const fractional = pieces.at(-1) ?? "";
    normalized = fractional.length >= 1 && fractional.length <= 2
      ? `${pieces.slice(0, -1).join("")}.${fractional}`
      : pieces.join("");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeDistanceKm(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cleanText(value).toLowerCase().replace(",", ".");
  const match = text.match(/(\d+(?:\.\d+)?)\s*(km|k)?\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function absolutizeUrl(value: string | null | undefined, baseUrl: string): string | null {
  const text = cleanText(value);
  if (!text) return null;
  try {
    return new URL(text, baseUrl).href;
  } catch {
    return null;
  }
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function generateEventFingerprint(input: {
  name: string | null | undefined;
  date: string | null | undefined;
  city: string | null | undefined;
  state: string | null | undefined;
  country: string | null | undefined;
}): string {
  return [
    normalizeCompact(input.name),
    cleanText(input.date),
    normalizeCompact(input.city),
    normalizeCompact(input.state),
    normalizeCompact(input.country),
  ].join("|");
}

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
