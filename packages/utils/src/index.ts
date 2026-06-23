import { createHash } from "node:crypto";

export const ADAPTER_VERSION_TICKETSPORTS = process.env.ADAPTER_VERSION_TICKETSPORTS ?? "1.0.0";
export const CANONICAL_SCHEMA_VERSION = process.env.CANONICAL_SCHEMA_VERSION ?? "1.0.0";
export const CURATION_PIPELINE_VERSION = process.env.CURATION_PIPELINE_VERSION ?? "1.0.0";

export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

export function normalizeDate(value: string | null | undefined, fallbackYear = new Date().getFullYear()): string | null {
  const text = cleanText(value);
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
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
  const match = text.match(/(?:R\$\s*)?(\d+(?:[.,]\d{2})?)/i);
  if (!match) return null;
  const parsed = Number(match[1]!.replace(".", "").replace(",", "."));
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
