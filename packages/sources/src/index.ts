import * as cheerio from "cheerio";
import { rawSourceExtractionSchema, type RawSourceExtraction } from "@race-calendar/schemas";
import {
  contentHashFromParts,
  extractLinks,
  htmlToImportantText,
  sanitizeImportantHtml,
  ScraperHttpClient,
} from "@race-calendar/scraper";
import {
  ADAPTER_VERSION_CORRIDASBR,
  ADAPTER_VERSION_OFFICIAL_PAGE,
  ADAPTER_VERSION_TICKETSPORTS,
  cleanText,
  normalizeDate,
  unique,
} from "@race-calendar/utils";

export type SourceFetchInput = {
  sourceId: string;
  url: string;
  sourceExternalId?: string | null;
  metadata?: Record<string, unknown>;
};

export type SourceAdapter = {
  sourceType: string;
  adapter: string;
  adapterVersion: string;
  canHandle(url: string): boolean;
  fetchAndExtract(input: SourceFetchInput): Promise<RawSourceExtraction>;
};

export type SourceHttpClient = {
  getText(url: string, options?: { headers?: Record<string, string>; delayMs?: number }): Promise<string>;
  getJson(url: string, options?: { headers?: Record<string, string>; delayMs?: number }): Promise<unknown>;
};

export type TicketSportsDiscoveredEvent = {
  sourceType: "ticketsports";
  adapter: "ticketsports";
  externalId: string;
  name: string;
  url: string;
  country: string;
  state: string | null;
  city: string | null;
  metadata: Record<string, unknown>;
};

export type DiscoverTicketSportsEventsOptions = {
  quantity?: number;
  quickFilter?: string;
  client?: SourceHttpClient;
};

export type CorridasBRDiscoveredEvent = {
  sourceType: "corridasbr";
  adapter: "corridasbr";
  externalId: string;
  name: string;
  url: string;
  country: "BR";
  state: string;
  city: string | null;
  date: string | null;
  metadata: Record<string, unknown>;
};

export type DiscoverCorridasBREventsOptions = {
  states?: string[];
  client?: SourceHttpClient;
  concurrency?: number;
};

type SourceAdapterRegistryOptions = {
  adapters?: SourceAdapter[];
};

export class SourceAdapterRegistry {
  readonly adapters: SourceAdapter[];

  constructor(options: SourceAdapterRegistryOptions = {}) {
    this.adapters = options.adapters ?? [
      new TicketSportsAdapter(),
      new CorridasBRAdapter(),
      new MockSourceAdapter(),
      new OfficialEventPageAdapter(),
    ];
  }

  findForUrl(url: string): SourceAdapter | null {
    return this.adapters.find((adapter) => adapter.canHandle(url)) ?? null;
  }
}

export class OfficialEventPageAdapter implements SourceAdapter {
  sourceType = "official";
  adapter = "official-page";
  adapterVersion = ADAPTER_VERSION_OFFICIAL_PAGE;

  constructor(private readonly client: SourceHttpClient = new ScraperHttpClient()) {}

  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.hostname.includes("ticketsports.com.br") &&
        !parsed.hostname.includes("corridasbr.com.br")
      );
    } catch {
      return false;
    }
  }

  async fetchAndExtract(input: SourceFetchInput): Promise<RawSourceExtraction> {
    const page = await fetchOfficialEventPage(input.url, this.client);
    return rawSourceExtractionSchema.parse({
      sourceType: this.sourceType,
      sourceId: input.sourceId,
      sourceExternalId: input.sourceExternalId ?? null,
      url: input.url,
      title: page.title,
      importantHtml: sanitizeImportantHtml(page.importantHtml),
      importantText: page.importantText,
      rawSourceData: page.structured,
      extractedLinks: page.links,
      fetchedAt: new Date().toISOString(),
      contentHash: contentHashFromParts([page.title, page.importantText, JSON.stringify(page.structured)]),
      adapter: this.adapter,
      adapterVersion: this.adapterVersion,
    });
  }
}

export class CorridasBRAdapter implements SourceAdapter {
  sourceType = "corridasbr";
  adapter = "corridasbr";
  adapterVersion = ADAPTER_VERSION_CORRIDASBR;

  constructor(private readonly client: SourceHttpClient = new ScraperHttpClient()) {}

  canHandle(url: string): boolean {
    try {
      return new URL(url).hostname.includes("corridasbr.com.br");
    } catch {
      return false;
    }
  }

  async fetchAndExtract(input: SourceFetchInput): Promise<RawSourceExtraction> {
    const html = await this.client.getText(input.url, { headers: corridasBRHeaders(), delayMs: 300 });
    if (isCorridasBRSecurityChallenge(html)) {
      throw new Error(`CorridasBR security challenge blocked event detail ${input.sourceExternalId ?? input.url}`);
    }
    const parsed = parseCorridasBRDetail(html, input.url);
    const shouldEnrich = input.metadata?.enrichOfficialPages !== false && process.env.OFFICIAL_PAGE_ENRICHMENT_ENABLED !== "false";
    const officialPage =
      shouldEnrich && parsed.officialUrl && isAllowedOfficialTarget(parsed.officialUrl)
        ? await fetchOfficialEventPage(parsed.officialUrl, this.client).catch(() => null)
        : null;
    const importantHtml = sanitizeImportantHtml(
      [
        `<article><h1>${escapeHtml(parsed.name ?? "Corrida")}</h1>`,
        `<p>${escapeHtml([parsed.date, parsed.city, parsed.state].filter(Boolean).join(" - "))}</p>`,
        `<p>${escapeHtml(parsed.locationName ?? "")}</p>`,
        `<p>${escapeHtml(parsed.distanceText ?? "")}</p>`,
        `<p>${escapeHtml(parsed.organizerName ?? "")}</p></article>`,
        officialPage?.importantHtml ?? "",
      ].join("\n"),
    );
    const importantText = cleanText(
      [
        parsed.name,
        parsed.date,
        parsed.city,
        parsed.state,
        parsed.locationName,
        parsed.distanceText,
        parsed.organizerName,
        officialPage?.importantText,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const links = unique([parsed.officialUrl, ...(officialPage?.links ?? [])].filter(isStringUrl));

    return rawSourceExtractionSchema.parse({
      sourceType: this.sourceType,
      sourceId: input.sourceId,
      sourceExternalId: input.sourceExternalId ?? corridasBRIdFromUrl(input.url),
      url: input.url,
      title: parsed.name,
      importantHtml,
      importantText,
      rawSourceData: {
        corridasbr: parsed,
        officialPage: officialPage?.structured ?? null,
      },
      extractedLinks: links,
      fetchedAt: new Date().toISOString(),
      contentHash: contentHashFromParts([
        parsed.name,
        parsed.date,
        parsed.city,
        parsed.state,
        parsed.locationName,
        parsed.distanceText,
        parsed.organizerName,
        parsed.officialUrl,
        JSON.stringify(officialPage?.structured ?? null),
      ]),
      adapter: this.adapter,
      adapterVersion: this.adapterVersion,
    });
  }
}

export class MockSourceAdapter implements SourceAdapter {
  sourceType = "mock";
  adapter = "mock";
  adapterVersion = "1.0.0";

  canHandle(url: string): boolean {
    return url.startsWith("mock://") || url.includes("example.test");
  }

  async fetchAndExtract(input: SourceFetchInput): Promise<RawSourceExtraction> {
    const title = String(input.metadata?.title ?? "Corrida Mock Florianopolis");
    const importantText = String(
      input.metadata?.importantText ??
        "Corrida Mock Florianopolis. Data 16/08/2026. Florianopolis, SC, Brasil. Distancias 5 km e 10 km. Inscricoes em https://example.test/inscricao.",
    );
    const importantHtml = sanitizeImportantHtml(`<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(importantText)}</p></main>`);
    return rawSourceExtractionSchema.parse({
      sourceType: this.sourceType,
      sourceId: input.sourceId,
      sourceExternalId: input.sourceExternalId ?? null,
      url: input.url.replace("mock://", "https://example.test/"),
      title,
      importantHtml,
      importantText,
      rawSourceData: { metadata: input.metadata ?? {} },
      extractedLinks: ["https://example.test/inscricao"],
      fetchedAt: new Date().toISOString(),
      contentHash: contentHashFromParts([title, importantText]),
      adapter: this.adapter,
      adapterVersion: this.adapterVersion,
    });
  }
}

export class TicketSportsAdapter implements SourceAdapter {
  sourceType = "ticketsports";
  adapter = "ticketsports";
  adapterVersion = ADAPTER_VERSION_TICKETSPORTS;

  constructor(private readonly client: SourceHttpClient = new ScraperHttpClient()) {}

  canHandle(url: string): boolean {
    try {
      return new URL(url).hostname.includes("ticketsports.com.br");
    } catch {
      return false;
    }
  }

  async fetchAndExtract(input: SourceFetchInput): Promise<RawSourceExtraction> {
    const eventId = input.sourceExternalId ?? eventIdFromTicketSportsUrl(input.url);
    const sourceUrl = eventId ? ticketSportsDetailUrl(eventId) : input.url;
    const payload = eventId
      ? await this.client.getJson(sourceUrl, { headers: ticketSportsHeaders(), delayMs: 300 })
      : await this.fetchGenericPagePayload(input.url);
    const record = asRecord(payload);
    const title = cleanText(stringValue(record.title) ?? stringValue(record.name) ?? stringValue(record.eventName)) || null;
    const sections = sectionsFromTicketSports(record.eventContents);
    const htmlFromSections = sections.map((section) => section.html).filter(Boolean).join("\n");
    const fallbackHtml = typeof record.description === "string" ? record.description : "";
    const importantHtml = sanitizeImportantHtml(htmlFromSections || fallbackHtml || `<h1>${escapeHtml(title ?? "TicketSports")}</h1>`);
    const importantText = cleanText(
      [
        title,
        stringValue(record.realDate) ?? stringValue(record.date),
        stringValue(record.address),
        stringValue(record.organizer),
        stringValue(record.status),
        htmlToImportantText(importantHtml),
        stringValue(record.sharingText),
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const url = registrationUrlFromTicketSportsPayload(record, input.url);

    return rawSourceExtractionSchema.parse({
      sourceType: this.sourceType,
      sourceId: input.sourceId,
      sourceExternalId: eventId,
      url,
      title,
      importantHtml,
      importantText,
      rawSourceData: record,
      extractedLinks: uniqueUrls([url, ...extractLinks(importantHtml, url)]),
      fetchedAt: new Date().toISOString(),
      contentHash: contentHashFromParts([
        title,
        importantText,
        stringValue(record.status),
        stringValue(record.headerImageSource),
        stringValue(record.logoImageSource),
        JSON.stringify(record.eventContents ?? null),
      ]),
      adapter: this.adapter,
      adapterVersion: this.adapterVersion,
    });
  }

  private async fetchGenericPagePayload(url: string): Promise<Record<string, unknown>> {
    const html = await this.client.getText(url, { headers: ticketSportsHeaders() });
    return { uri: url, description: html, title: pageTitle(html) };
  }
}

export async function discoverTicketSportsEvents(
  options: DiscoverTicketSportsEventsOptions = {},
): Promise<TicketSportsDiscoveredEvent[]> {
  const quantity = positiveInt(options.quantity, Number(process.env.TICKETSPORTS_IMPORT_QUANTITY ?? 1000));
  const quickFilter = cleanText(options.quickFilter ?? process.env.TICKETSPORTS_IMPORT_QUICK_FILTER ?? "corrida-de-rua");
  const client = options.client ?? new ScraperHttpClient();
  const payload = await client.getJson(ticketSportsListUrl({ quantity, quickFilter }), {
    headers: ticketSportsHeaders(),
  });
  const rows = Array.isArray(payload) ? payload : [];
  return rows.flatMap((item) => {
    const record = asRecord(item);
    const eventId = numberOrString(record.eventId);
    const url = stringValue(record.uri);
    const title = cleanText(stringValue(record.title));
    if (!eventId || !url || !title) return [];
    const location = parseTicketSportsLocation(stringValue(record.address));
    if (location.country !== "BR") return [];
    return [
      {
        sourceType: "ticketsports",
        adapter: "ticketsports",
        externalId: eventId,
        name: title,
        url,
        country: location.country ?? "BR",
        state: location.state,
        city: location.city,
        metadata: {
          quickFilter,
          listItem: record,
          discoveredAt: new Date().toISOString(),
        },
      },
    ];
  });
}

export async function discoverCorridasBREvents(
  options: DiscoverCorridasBREventsOptions = {},
): Promise<CorridasBRDiscoveredEvent[]> {
  const requestedStates = options.states?.length ? options.states : corridasBRStates;
  const states = unique(requestedStates.map((state) => cleanText(state).toUpperCase())).filter((state) =>
    corridasBRStates.includes(state),
  );
  const client = options.client ?? new ScraperHttpClient();
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Number(process.env.CORRIDASBR_IMPORT_CONCURRENCY ?? 2), 5),
  );
  const discovered = await mapWithConcurrency(states, concurrency, async (state) => {
    const calendarUrl = corridasBRCalendarUrl(state);
    const html = await client.getText(calendarUrl, { headers: corridasBRHeaders(), delayMs: 150 });
    if (isCorridasBRSecurityChallenge(html)) {
      throw new Error(`CorridasBR security challenge blocked calendar discovery for ${state}`);
    }
    return parseCorridasBRCalendar(html, state, calendarUrl);
  });
  const byExternalId = new Map<string, CorridasBRDiscoveredEvent>();
  for (const event of discovered.flat()) byExternalId.set(event.externalId, event);
  return [...byExternalId.values()];
}

export function isCorridasBRSecurityChallenge(html: string): boolean {
  const text = stripDiacritics(htmlToImportantText(html).toLowerCase());
  return (
    text.includes("verificacao de seguranca") ||
    text.includes("tentativas de acessos suspeitos") ||
    text.includes("responda ao desafio")
  );
}

export function corridasBRCalendarUrl(state: string): string {
  return `https://www.corridasbr.com.br/${state.toUpperCase()}/calendario.asp`;
}

export function parseCorridasBRCalendar(
  html: string,
  state: string,
  calendarUrl = corridasBRCalendarUrl(state),
): CorridasBRDiscoveredEvent[] {
  const $ = cheerio.load(html);
  const events: CorridasBRDiscoveredEvent[] = [];
  $('a[href*="mostracorrida.asp?escolha="]').each((_, anchor) => {
    const href = $(anchor).attr("href");
    const name = cleanText($(anchor).text());
    if (!href || !name) return;
    const url = new URL(href, calendarUrl).href;
    const externalId = corridasBRIdFromUrl(url);
    if (!externalId) return;
    const row = $(anchor).closest("tr");
    const surroundingRows = row.add(row.prev()).add(row.prev().prev());
    const city =
      cleanText(
        surroundingRows
          .find('a[href*="por_cidade.asp"]')
          .toArray()
          .map((item) => $(item).text())
          .find(Boolean),
      ) || null;
    const rowText = cleanText(surroundingRows.text());
    const dateText = rowText.match(/(?<!\d)\d{1,2}\/\d{1,2}\/\d{2,4}(?!\d)/)?.[0] ?? null;
    events.push({
      sourceType: "corridasbr",
      adapter: "corridasbr",
      externalId,
      name,
      url,
      country: "BR",
      state: state.toUpperCase(),
      city,
      date: normalizeDate(dateText),
      metadata: {
        calendarUrl,
        state: state.toUpperCase(),
        city,
        date: normalizeDate(dateText),
        rowText,
        discoveredAt: new Date().toISOString(),
      },
    });
  });
  return events;
}

export function parseCorridasBRDetail(html: string, url: string) {
  const $ = cheerio.load(html);
  const fields = new Map<string, string>();
  $("tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 2) return;
    const label = normalizeLabel($(cells[0]).text());
    const valueCell = $(cells[1]).clone();
    valueCell.find("script,button").remove();
    if (label === "cidade") {
      // These links navigate to other listings; they are not part of the city name.
      valueCell.find("a").filter((_, link) => /Corridas?\s+(?:nesta Cidade|nesta Regi[aã]o)/i.test($(link).text())).remove();
    }
    const text = cleanText(valueCell.text());
    const value = label === "cidade"
      ? text.replace(/\s*\(Corridas?\s+(?:nesta Cidade|nesta Regi[aã]o)\)/gi, "").trim()
      : text;
    if (label && value && !fields.has(label)) fields.set(label, value);
  });
  const state = stateFromCorridasBRUrl(url);
  const name = cleanText($(".tipo7 strong").first().text()) || cleanText($("title").first().text()) || null;
  const officialRedirect = html.match(
    /function\s+paraonde\s*\(\)\s*\{\s*window\.open\(['"]([^'"]+)['"]\)/i,
  )?.[1];
  const officialUrl = officialRedirect ? officialTargetFromCorridasBRRedirect(officialRedirect) : null;
  return {
    name,
    date: normalizeDate(fieldByLabels(fields, ["data"])),
    city: fieldByLabels(fields, ["cidade"]),
    state,
    country: "BR",
    locationName: fieldByLabels(fields, ["largada", "local", "local de largada"]),
    distanceText: fieldByLabels(fields, ["distancia s", "distancias", "distancia"]),
    organizerName: fieldByLabels(fields, ["organizador", "organizacao"]),
    officialUrl,
    sourceUrl: url,
  };
}

type OfficialPageResult = {
  title: string | null;
  importantHtml: string;
  importantText: string;
  links: string[];
  structured: Record<string, unknown>;
};

async function fetchOfficialEventPage(url: string, client: SourceHttpClient): Promise<OfficialPageResult> {
  if (!isAllowedOfficialTarget(url)) throw new Error(`Official page host is not allowed: ${url}`);
  const cached = officialPageCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const hostname = new URL(url).hostname.toLowerCase();
  const previous = officialDomainQueues.get(hostname) ?? Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn);
  officialDomainQueues.set(hostname, queued);
  await previous;
  try {
    const result = await fetchOfficialEventPageUncached(url, client);
    officialPageCache.set(url, { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, value: result });
    return result;
  } finally {
    release();
    if (officialDomainQueues.get(hostname) === queued) officialDomainQueues.delete(hostname);
  }
}

async function fetchOfficialEventPageUncached(url: string, client: SourceHttpClient): Promise<OfficialPageResult> {
  const html = await client.getText(url, { delayMs: 250 });
  const $ = cheerio.load(html);
  const jsonLdEvents = $("script[type='application/ld+json']")
    .toArray()
    .flatMap((script) => jsonLdEventRecords($(script).text()));
  const event = jsonLdEvents[0] ?? {};
  const title =
    cleanText(stringValue(event.name)) ||
    cleanText($("meta[property='og:title']").attr("content")) ||
    cleanText($("h1").first().text()) ||
    cleanText($("title").first().text()) ||
    null;
  const description =
    cleanText(stringValue(event.description)) ||
    cleanText($("meta[property='og:description']").attr("content")) ||
    cleanText($("meta[name='description']").attr("content")) ||
    null;
  const images = unique(
    [
      ...imageUrlsFromJsonLd(event.image),
      $("meta[property='og:image']").attr("content"),
      $("meta[property='og:image:secure_url']").attr("content"),
      $("meta[name='twitter:image']").attr("content"),
    ].flatMap((value) => absoluteHttpUrl(value, url)),
  ).filter((imageUrl) => !looksLikeNonEventImage(imageUrl));
  const links = unique(
    [url, ...extractLinks(html, url), ...absoluteHttpUrl(stringValue(event.url), url)].filter(isStringUrl),
  ).slice(0, 100);
  const importantHtml = `<article><h1>${escapeHtml(title ?? "Evento")}</h1><p>${escapeHtml(description ?? "")}</p></article>`;
  return {
    title,
    importantHtml,
    importantText: cleanText([title, description, htmlToImportantText(importantHtml)].filter(Boolean).join("\n")),
    links,
    structured: {
      url,
      title,
      description,
      images,
      jsonLdEvent: event,
    },
  };
}

const officialPageCache = new Map<string, { expiresAt: number; value: OfficialPageResult }>();
const officialDomainQueues = new Map<string, Promise<void>>();

export function ticketSportsDetailUrl(eventId: string): string {
  const params = new URLSearchParams({ eventId, athleteId: "0", clientTypeId: "1" });
  return `https://www.ticketsports.com.br/api/events/detail?${params.toString()}`;
}

export function ticketSportsListUrl(input: { quantity: number; quickFilter: string }): string {
  const params = new URLSearchParams({
    quantity: String(input.quantity),
    atlheteId: "0",
    quickFilter: input.quickFilter,
  });
  return `https://www.ticketsports.com.br/api/events/list?${params.toString()}`;
}

function ticketSportsHeaders(): Record<string, string> {
  return {
    Accept: "application/json,text/plain,*/*",
    Referer: "https://www.ticketsports.com.br",
  };
}

function eventIdFromTicketSportsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const queryId = parsed.searchParams.get("eventId") ?? parsed.searchParams.get("id");
    if (queryId) return queryId;
    const numberInPath = parsed.pathname.match(/(\d{3,})(?:\D*)$/)?.[1];
    return numberInPath ?? null;
  } catch {
    return null;
  }
}

function sectionsFromTicketSports(value: unknown): Array<{ title: string; html: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const title = cleanText(stringValue(record.title));
    const html = typeof record.description === "string" ? record.description : "";
    const text = htmlToImportantText(html);
    return title || text ? [{ title, html, text }] : [];
  });
}

function parseTicketSportsLocation(value: string | null): { city: string | null; state: string | null; country: string | null } {
  const text = cleanText(value);
  if (!text) return { city: null, state: null, country: "BR" };
  const state = text.match(/,\s*([A-Z]{2})(?:,|\b)/)?.[1]?.toUpperCase() ?? null;
  const country = countryFromText(text) ?? "BR";
  if (!state) return { city: cityBeforeColon(text), state: null, country };
  const beforeState = text.split(new RegExp(`,\\s*${state}\\b`, "i"))[0] ?? "";
  const city = cityBeforeColon(beforeState) ?? cleanText(beforeState.split(",").at(-1));
  return { city: city || null, state, country };
}

function countryFromText(value: string): string | null {
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
    [/(^|[\s,;:])(mexico|méxico)(?=$|[\s,;:.])/, "MX"],
    [/(^|[\s,;:])(estados unidos|eua|usa|united states)(?=$|[\s,;:.])/, "US"],
    [/(^|[\s,;:])(espanha|spain)(?=$|[\s,;:.])/, "ES"],
  ];
  return countries.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function cityBeforeColon(value: string): string | null {
  const left = stripCountrySuffix(value.split(":")[0] ?? "");
  return cleanText(left) || null;
}

function stripCountrySuffix(value: string): string {
  return cleanText(
    value.replace(
      /,\s*(Brasil|Brazil|BR|Portugal|Argentina|Chile|Uruguai|Uruguay|Paraguai|Paraguay|Bolivia|Peru|Colombia|Mexico|México|Estados Unidos|EUA|USA|United States|Espanha|Spain)\b\.?$/i,
      "",
    ),
  );
}

function registrationUrlFromTicketSportsPayload(payload: Record<string, unknown>, fallbackUrl: string): string {
  const uri = stringValue(payload.uri);
  if (!uri) return fallbackUrl;
  try {
    return new URL(uri, "https://www.ticketsports.com.br").href;
  } catch {
    return fallbackUrl;
  }
}

function pageTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
  return match ? cleanText(match[1]?.replace(/<[^>]+>/g, "")) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((url) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }))];
}

function corridasBRHeaders(): Record<string, string> {
  return {
    Accept: "text/html,application/xhtml+xml",
    Referer: "https://www.corridasbr.com.br/",
  };
}

function corridasBRIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("escolha");
  } catch {
    return url.match(/[?&]escolha=(\d+)/i)?.[1] ?? null;
  }
}

function stateFromCorridasBRUrl(url: string): string | null {
  try {
    const state = new URL(url).pathname.split("/").filter(Boolean)[0]?.toUpperCase() ?? null;
    return state && corridasBRStates.includes(state) ? state : null;
  } catch {
    return null;
  }
}

function officialTargetFromCorridasBRRedirect(value: string): string | null {
  const decoded = value.replace(/&amp;/g, "&");
  try {
    const parsed = new URL(decoded, "https://www.corridasbr.com.br");
    const target = parsed.hostname.includes("corridasbr.com.br") ? parsed.searchParams.get("c") : parsed.href;
    if (!target) return null;
    const normalized = decodeURIComponent(target);
    return absoluteHttpUrl(normalized, parsed.href)[0] ?? null;
  } catch {
    return null;
  }
}

function normalizeLabel(value: string): string {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fieldByLabels(fields: Map<string, string>, labels: string[]): string | null {
  for (const label of labels) {
    const value = fields.get(label);
    if (value) return cleanText(value) || null;
  }
  return null;
}

function jsonLdEventRecords(text: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const records = flattenJsonLd(parsed);
    return records.filter((record) => {
      const type = record["@type"];
      return type === "Event" || (Array.isArray(type) && type.includes("Event"));
    });
  } catch {
    return [];
  }
}

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  const record = asRecord(value);
  if (!Object.keys(record).length) return [];
  return [record, ...flattenJsonLd(record["@graph"]), ...flattenJsonLd(record.itemListElement)];
}

function imageUrlsFromJsonLd(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(imageUrlsFromJsonLd);
  if (typeof value === "string") return [value];
  const record = asRecord(value);
  return [record.url, record.contentUrl].filter(Boolean);
}

function absoluteHttpUrl(value: unknown, baseUrl: string): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = new URL(value, baseUrl);
    return ["http:", "https:"].includes(parsed.protocol) ? [parsed.href] : [];
  } catch {
    return [];
  }
}

function isStringUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeNonEventImage(url: string): boolean {
  return /(?:^|[/_-])(logo|favicon|icon|avatar|pixel|tracking|banner-ad|publicidade)(?:[/_-]|\.)/i.test(url);
}

function isAllowedOfficialTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    ) {
      return false;
    }
    return (
      !host.includes("corridasbr.com.br") &&
      !host.includes("facebook.com") &&
      !host.includes("instagram.com") &&
      host !== "wa.me"
    );
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

const corridasBRStates = [
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
];

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
