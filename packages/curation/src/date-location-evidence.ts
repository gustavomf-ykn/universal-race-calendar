import type { RawSourceExtraction } from "@race-calendar/schemas";
import { cleanText, countryFromLocationText, normalizeDate, normalizeKey } from "@race-calendar/utils";
import { brazilianStateCodes, validPublicationCity } from "@race-calendar/database";
import { repairMojibake } from "./text-normalization.js";

type Location = { city: string | null; state: string | null };
type Evidence = Location & { date: string | null; warnings: string[] };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? cleanText(repairMojibake(value)) : null;
const city = (value: unknown, structured = true) => {
  const observed = text(value);
  return validPublicationCity(observed) && (structured || !/^(?:av\.? |avenida |rua |rodovia |estrada |parque |shopping |estadio |ginasio |arena |complexo |campus |km )/i.test(normalizeKey(observed))) ? observed : null;
};
const state = (value: unknown) => {
  const observed = text(value)?.toUpperCase() ?? null;
  return observed && brazilianStateCodes.some(code => code === observed) ? observed : null;
};

/** A selected event belongs to the fetched page, not the first event in a list. */
export function selectedJsonLdEvent(page: Record<string, unknown>) {
  return ["single", "url"].includes(String(page.jsonLdSelection)) ? record(page.jsonLdEvent) : {};
}

export function relatedJsonLdForEdition(page: Record<string, unknown>, edition: Location & { date: string | null; name: string | null }) {
  const linked = selectedJsonLdEvent(page);
  const address = record(record(linked.location).address);
  if (!edition.date || normalizeDate(text(linked.startDate)) !== edition.date ||
      !edition.name || normalizeKey(text(linked.name)) !== normalizeKey(edition.name) ||
      (edition.city && normalizeKey(text(address.addressLocality)) !== normalizeKey(edition.city)) ||
      (edition.state && state(address.addressRegion) !== edition.state)) return {};
  return linked;
}

export function editionTextForRaw(raw: RawSourceExtraction, edition: Evidence) {
  if (raw.sourceType !== "corridasbr") return repairMojibake(raw.importantText) ?? "";
  const root = record(raw.rawSourceData), primary = record(root.corridasbr), page = record(root.officialPage);
  const linked = relatedJsonLdForEdition(page, { ...edition, name: text(primary.name) ?? raw.title });
  return [primary.name, primary.date, primary.city, primary.state, primary.distanceText,
    text(primary.modalityText) ? `Modalidade: ${text(primary.modalityText)}` : null,
    ...(Object.keys(linked).length ? [linked.name, linked.description, page.importantText] : [])].map(text).filter(Boolean).join("\n");
}

/** Source fields, never a provider's quote, determine the edition's date and city/UF. */
export function dateLocationEvidenceForRaw(
  raw: RawSourceExtraction,
  parseTicketLocation: (address: string) => Location,
): Evidence {
  const root = record(raw.rawSourceData);
  const result: Evidence = { date: null, city: null, state: null, warnings: [] };
  if (raw.sourceType === "corridasbr") {
    const primary = record(root.corridasbr);
    result.date = normalizeDate(text(primary.date));
    result.city = city(primary.city);
    result.state = state(primary.state);
    const linked = relatedJsonLdForEdition(record(root.officialPage), { ...result, name: text(primary.name) ?? raw.title });
    const address = record(record(linked.location).address);
    // A linked page cannot supply the edition's missing primary date. It can
    // fill location gaps only with the same date/name and compatible known location.
    if (Object.keys(linked).length) {
      result.city ??= city(address.addressLocality);
      result.state ??= state(address.addressRegion);
    }
    // importantText mixes the primary page with a linked page; never use it
    // to fill primary edition identity or silently select another year's date.
    return result;
  }
  if (raw.sourceType === "ticketsports") {
    const dates = [root.realDate, root.date].map(value => normalizeDate(text(value))).filter((value): value is string => Boolean(value));
    const distinct = [...new Set(dates)];
    result.date = distinct.length === 1 ? distinct[0]! : null;
    if (distinct.length > 1) result.warnings.push("conflicting_date");
    if (text(root.address)) {
      const observed = parseTicketLocation(text(root.address)!);
      result.city = city(observed.city);
      result.state = state(observed.state);
    }
    if (root.realDate || root.date || root.address) return result;
  }
  const own = selectedJsonLdEvent(root);
  if (Object.keys(own).length) {
    const address = record(record(own.location).address);
    result.date = normalizeDate(text(own.startDate));
    result.city = city(address.addressLocality);
    result.state = state(address.addressRegion);
    return result;
  }
  if (Object.keys(record(root.jsonLdEvent)).length || (root.jsonLdSelection && root.jsonLdSelection !== "absent")) {
    result.warnings.push("edition_observation_unconfirmed");
    return result;
  }
  // Conservative text fallback for a primary page. Event dates must be labelled;
  // registration/kit dates and organizer/footer locations are not edition evidence.
  const source = repairMojibake(raw.importantText) ?? "";
  const dates: string[] = [];
  for (const match of source.matchAll(/\bData(?:\s+(?:da|do)\s+(?:prova|evento|corrida))?\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/gi)) {
    const prefix = normalizeKey(source.slice(Math.max(0, match.index! - 60), match.index));
    if (/(kit|inscric|lote|organizador|outras provas|outros eventos|proximas provas|calendario)/.test(prefix)) continue;
    const observed = normalizeDate(match[1]);
    if (observed) dates.push(observed);
  }
  const distinctDates = [...new Set(dates)];
  result.date = distinctDates.length === 1 ? distinctDates[0]! : null;
  if (distinctDates.length > 1) result.warnings.push("conflicting_date");
  const locations: Location[] = [];
  for (const clause of source.split(/[.!?;\n]/)) {
    if (/(organizador|outras provas|outros eventos|proximas provas|calendario|retirada|kit)/.test(normalizeKey(clause))) continue;
    const components = clause.split(",").map(cleanText).filter(Boolean);
    while (components.length && countryFromLocationText(components.at(-1)).country) components.pop();
    let observedState: string | null = null;
    if (state(components.at(-1))) observedState = state(components.pop());
    if (components.length !== 1) continue;
    const observedCity = city(components[0]?.replace(/^(?:cidade|munic[ií]pio|localiza[çc][ãa]o)\s*:\s*/i, ""), false);
    // A bare name is not a location clause. Require city/UF or explicit country.
    if (observedCity && (observedState || countryFromLocationText(clause).country))
      locations.push({ city: observedCity, state: observedState });
  }
  const distinctLocations = new Map(locations.map(item => [normalizeKey(item.city) + ":" + item.state, item]));
  if (distinctLocations.size === 1) Object.assign(result, [...distinctLocations.values()][0]);
  else if (distinctLocations.size > 1) result.warnings.push("conflicting_location");
  return result;
}
