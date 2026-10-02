import type { RawSourceExtraction } from "@race-calendar/schemas";
import {
  cleanText,
  countryFromExplicitValue,
  countryFromLocationText,
  normalizeDate,
  normalizeKey,
} from "@race-calendar/utils";
import { repairMojibake } from "./text-normalization.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? repairMojibake(value) : null);

/** Whitelisted source fields and a location clause, never a model's generated quote. */
export function countryEvidenceForRaw(
  raw: RawSourceExtraction,
  location: {
    city: string | null;
    state: string | null;
    claimedCountry?: string | null;
  },
) {
  const root = record(raw.rawSourceData);
  const observations: Array<{ country: string; sourceText: string }> = [];
  let conflicting = false;
  let unrecognized = false;
  const explicit = (value: unknown) => {
    const observed = countryFromExplicitValue(text(value));
    if (observed.sourceText && !observed.country) unrecognized = true;
    if (observed.country && observed.sourceText)
      observations.push({ country: observed.country, sourceText: observed.sourceText });
  };
  const address = (value: unknown) => {
    const observed = countryFromLocationText(text(value));
    if (observed.conflicting) conflicting = true;
    if (observed.country && observed.sourceText)
      observations.push({ country: observed.country, sourceText: observed.sourceText });
  };
  if (raw.sourceType === "ticketsports") address(root.address);
  // Older CorridasBR extractions contained country=BR by default; only the observed label is usable.
  if (raw.sourceType === "corridasbr") {
    const parsed = record(root.corridasbr);
    if (Array.isArray(parsed.countrySourceTexts)) parsed.countrySourceTexts.forEach(explicit);
    else explicit(parsed.countrySourceText);
  }
  for (const page of [root, record(root.officialPage)]) {
    const jsonLd = record(page.jsonLdEvent);
    const eventAddress = record(record(jsonLd.location).address);
    // An organizer's linked page may now describe a different edition. It cannot
    // confirm country unless its dated location is compatible with this edition.
    if (page !== root && raw.sourceType === "corridasbr") {
      const parsed = record(root.corridasbr);
      if (
        !parsed.date ||
        normalizeDate(text(jsonLd.startDate)) !== parsed.date ||
        !location.city ||
        normalizeKey(text(eventAddress.addressLocality)) !== normalizeKey(location.city) ||
        (location.state && normalizeKey(text(eventAddress.addressRegion)) !== normalizeKey(location.state))
      )
        continue;
    }
    const country = eventAddress.addressCountry;
    if (typeof country === "string") explicit(country);
    else {
      explicit(record(country).name);
      explicit(record(country).identifier);
    }
  }
  // Unstructured evidence must be the same location, immediately before the country suffix.
  // CorridasBR text mixes the calendar detail with a linked official page;
  // country for that source must retain its structured, dated provenance.
  if (location.city && raw.sourceType !== "corridasbr") {
    for (const clause of (repairMojibake(raw.importantText) ?? "").split(/[.!?;\n]/)) {
      const observed = countryFromLocationText(clause);
      if (!observed.country && !observed.conflicting) continue;
      const components = clause.split(",").map(cleanText).filter(Boolean);
      // Free text suffixes must not reinterpret ES (Espírito Santo), PE or other UFs as country codes.
      while (components.length && countryFromLocationText(components.at(-1)).country) components.pop();
      const stateMatches = !location.state || normalizeKey(components.pop()) === normalizeKey(location.state);
      if (!stateMatches || normalizeKey(components.at(-1)) !== normalizeKey(location.city)) continue;
      if (observed.conflicting) conflicting = true;
      if (observed.country && observed.sourceText)
        observations.push({ country: observed.country, sourceText: observed.sourceText });
    }
  }
  const countries = new Set(observations.map((item) => item.country));
  conflicting ||= countries.size > 1;
  const observed = !conflicting && !unrecognized && countries.size === 1 ? observations[0]! : null;
  return {
    country: observed?.country ?? null,
    sourceText: observed?.sourceText ?? null,
    conflicting,
    mismatch: Boolean(location.claimedCountry && location.claimedCountry !== observed?.country),
  };
}
