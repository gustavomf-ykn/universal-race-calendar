import { rawSourceExtractionSchema, type RawSourceExtraction } from "@race-calendar/schemas";
import {
  contentHashFromParts,
  extractLinks,
  htmlToImportantText,
  sanitizeImportantHtml,
  ScraperHttpClient,
} from "@race-calendar/scraper";
import { ADAPTER_VERSION_TICKETSPORTS, cleanText } from "@race-calendar/utils";

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

type SourceAdapterRegistryOptions = {
  adapters?: SourceAdapter[];
};

export class SourceAdapterRegistry {
  readonly adapters: SourceAdapter[];

  constructor(options: SourceAdapterRegistryOptions = {}) {
    this.adapters = options.adapters ?? [new TicketSportsAdapter(), new MockSourceAdapter()];
  }

  findForUrl(url: string): SourceAdapter | null {
    return this.adapters.find((adapter) => adapter.canHandle(url)) ?? null;
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
        stringValue(record.date) ?? stringValue(record.realDate),
        stringValue(record.address),
        stringValue(record.organizer),
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
      extractedLinks: extractLinks(importantHtml, url),
      fetchedAt: new Date().toISOString(),
      contentHash: contentHashFromParts([title, importantText, JSON.stringify(record.eventContents ?? null)]),
      adapter: this.adapter,
      adapterVersion: this.adapterVersion,
    });
  }

  private async fetchGenericPagePayload(url: string): Promise<Record<string, unknown>> {
    const html = await this.client.getText(url, { headers: ticketSportsHeaders() });
    return { uri: url, description: html, title: pageTitle(html) };
  }
}

export function ticketSportsDetailUrl(eventId: string): string {
  const params = new URLSearchParams({ eventId, athleteId: "0", clientTypeId: "1" });
  return `https://www.ticketsports.com.br/api/events/detail?${params.toString()}`;
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
