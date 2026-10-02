import { ScraperHttpClient } from "@race-calendar/scraper";
import * as cheerio from "cheerio";
import { cleanText, normalizeDate } from "@race-calendar/utils";
import { parseTicketSportsLocation, parseCorridasBRCalendar, corridasBRCalendarUrl, isCorridasBRSecurityChallenge,
  type CorridasBRDiscoveredEvent, type SourceHttpClient, type TicketSportsDiscoveredEvent } from "./index.js";

// Verified against the official calendar/filter JavaScript on 2026-10-01.
// The site's Load more increases quantity; there is no verified offset/page parameter.
export type TicketSportsCatalogOptions = {
  quantity: number;
  state?: string;
  quickFilter?: string;
  from?: string;
  to?: string;
  client?: SourceHttpClient;
};
export type TicketSportsCatalogPage = {
  events: Array<TicketSportsDiscoveredEvent & { date: string | null }>;
  requested: number;
  rawCount: number;
  rawIds: string[];
  invalidCount: number;
  excludedCountryCount: number;
  excludedCountryIds: string[];
  unknownCountryCount: number;
  terminal: boolean;
};

export function ticketSportsCatalogUrl(options: TicketSportsCatalogOptions): string {
  if (!Number.isSafeInteger(options.quantity) || options.quantity < 1 || options.quantity > 10000)
    throw Error("catalog_quantity_invalid");
  if (options.state && !/^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/.test(options.state))
    throw Error("catalog_state_invalid");
  const params = new URLSearchParams({ quantity: String(options.quantity), atlheteId: "0", term: "", country: "BR" });
  if (options.state) params.set("region", options.state);
  if (options.quickFilter) params.set("quickFilter", options.quickFilter);
  if (options.from) params.set("start", options.from);
  if (options.to) params.set("end", options.to);
  return `https://www.ticketsports.com.br/api/events/list?${params}`;
}

function explicitDate(row: Record<string, unknown>): string | null {
  const value = cleanText(row.date as string);
  // Multi-day labels, enrollment deadlines and years inferred from titles are not race dates.
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value) || /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
    return normalizeDate(value);
  return null;
}

export function parseTicketSportsCatalogPage(payload: unknown, requested: number): TicketSportsCatalogPage {
  if (!Array.isArray(payload)) throw Error("catalog_structure_changed");
  const events: TicketSportsCatalogPage["events"] = [];
  const rawIds: string[] = [];
  const excludedCountryIds = new Set<string>();
  let invalidCount = 0, excludedCountryCount = 0;
  const seen = new Set<string>();
  for (const value of payload) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { invalidCount++; continue; }
    const row = value as Record<string, unknown>;
    const id = typeof row.eventId === "number" || typeof row.eventId === "string" ? String(row.eventId) : "";
    if (id) rawIds.push(id);
    const name = typeof row.title === "string" ? cleanText(row.title) : "";
    let url: URL;
    try { url = new URL(String(row.uri)); } catch { invalidCount++; continue; }
    if (!/^\d+$/.test(id) || !name || !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      !["www.ticketsports.com.br", "ticketsports.com.br"].includes(url.hostname)) { invalidCount++; continue; }
    const location = parseTicketSportsLocation(typeof row.address === "string" ? row.address : null);
    if (location.country && location.country !== "BR") {
      excludedCountryCount++;
      excludedCountryIds.add(id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    events.push({
      sourceType: "ticketsports", adapter: "ticketsports", externalId: id, name, url: url.href,
      country: location.country, city: location.city, state: location.state, date: explicitDate(row),
      // Whitelist event fields. Never persist organizer email/document numbers from catalog payloads.
      metadata: { discovery: "official_calendar_filters", listItem: {
        eventId: id, title: name, uri: url.href, address: row.address ?? null, date: row.date ?? null,
        year: row.year ?? null, status: row.status ?? null, isVirtualEvent: row.isVirtualEvent ?? null,
      } },
    });
  }
  // Count the raw response, not filtered/unique events. This is the official Load more terminal signal.
  return { events, requested, rawCount: payload.length, rawIds, invalidCount, excludedCountryCount,
    excludedCountryIds: [...excludedCountryIds], unknownCountryCount: events.filter(event => !event.country).length,
    terminal: payload.length < requested && invalidCount === 0 };
}

export async function discoverTicketSportsCatalogPage(options: TicketSportsCatalogOptions): Promise<TicketSportsCatalogPage> {
  const client = options.client ?? new ScraperHttpClient({ maxRetries: 1 });
  const payload = await client.getJson(ticketSportsCatalogUrl(options), { headers: {
    Accept: "application/json", Referer: "https://www.ticketsports.com.br/calendario/filters/",
  }, delayMs: 1000 });
  return parseTicketSportsCatalogPage(payload, options.quantity);
}

export function nextTicketSportsPrefix(page: TicketSportsCatalogPage, previousIds: string[], ceiling = 10000) {
  if (page.invalidCount) return { status: "blocked" as const, reason: "catalog_invalid_candidates", quantity: page.requested };
  if (page.rawCount > page.requested)
    return { status: "blocked" as const, reason: "catalog_quantity_ignored", quantity: page.requested };
  if (page.terminal) return { status: "completed" as const, reason: "official_load_more_end", quantity: page.requested };
  const previous = new Set(previousIds);
  if (previous.size && page.rawIds.every(id => previous.has(id)))
    return { status: "limited" as const, reason: "catalog_not_advancing", quantity: page.requested };
  if (page.requested >= ceiling)
    return { status: "limited" as const, reason: "catalog_safety_ceiling", quantity: page.requested };
  return { status: "ready" as const, reason: "prefix_expansion", quantity: Math.min(ceiling, page.requested + 25) };
}

export type CorridasBRCatalogPage = { events: CorridasBRDiscoveredEvent[]; url: string; nextUrls: string[] };
export function corridasBRCatalogUrl(value: string, state: string): string {
  const url = new URL(value);
  if (!/^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/.test(state) ||
      !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      !["www.corridasbr.com.br", "corridasbr.com.br"].includes(url.hostname) ||
      !new RegExp(`^/${state}/calendario\\d*\\.asp$`, "i").test(url.pathname)) throw Error("catalog_page_url_invalid");
  url.hash = "";
  url.protocol = "https:";
  url.hostname = "www.corridasbr.com.br";
  url.pathname = url.pathname.toLowerCase();
  return url.href;
}
export function parseCorridasBRCatalogPage(html: string, state: string, url = corridasBRCalendarUrl(state)): CorridasBRCatalogPage {
  const current = corridasBRCatalogUrl(url, state);
  if (isCorridasBRSecurityChallenge(html)) throw Error("source_access_blocked");
  const $ = cheerio.load(html);
  const events = parseCorridasBRCalendar(html, state, current);
  const nextUrls = new Set<string>();
  $("a[href]").each((_, node) => {
    try { nextUrls.add(corridasBRCatalogUrl(new URL($(node).attr("href")!, current).href, state)); } catch { /* Other navigation is not catalog pagination. */ }
  });
  const canonical = $("link[rel='canonical']").attr("href");
  let confirmedCalendar = false;
  try { confirmedCalendar = Boolean(canonical && corridasBRCatalogUrl(canonical, state) === current); } catch { /* Wrong UF is not valid evidence. */ }
  if (!events.length && !(confirmedCalendar && /calend[aá]rio|pr[oó]ximas corridas/i.test($.text())))
    throw Error("catalog_end_unconfirmed");
  return { events, url: current, nextUrls: [...nextUrls].filter(next => next !== current) };
}
export async function discoverCorridasBRCatalogPage(options: { state: string; url?: string; client?: SourceHttpClient }): Promise<CorridasBRCatalogPage> {
  const url = corridasBRCatalogUrl(options.url ?? corridasBRCalendarUrl(options.state), options.state);
  const client = options.client ?? new ScraperHttpClient({ maxRetries: 1 });
  const html = await client.getText(url, { delayMs: 1000 });
  return parseCorridasBRCatalogPage(html, options.state, url);
}
