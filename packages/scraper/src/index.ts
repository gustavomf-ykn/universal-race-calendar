import * as cheerio from "cheerio";
import { cleanText, hashContent, unique } from "@race-calendar/utils";

export type ScraperHttpClientOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
};

export class ScraperHttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly statusCode?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScraperHttpError";
  }
}

export class ScraperHttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: ScraperHttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SCRAPER_TIMEOUT_MS ?? 15000);
    this.maxRetries = options.maxRetries ?? Number(process.env.SCRAPER_MAX_RETRIES ?? 3);
    this.userAgent = options.userAgent ?? process.env.SCRAPER_USER_AGENT ?? "UniversalRaceCalendarBot/0.1";
  }

  async getText(url: string, options: { headers?: Record<string, string>; delayMs?: number } = {}): Promise<string> {
    const response = await this.fetchWithRetry(url, options);
    const buffer = await response.arrayBuffer();
    const charset = response.headers.get("content-type")?.match(/charset=([^;]+)/i)?.[1]?.trim();
    for (const label of [charset, "utf-8", "iso-8859-1"].filter(Boolean) as string[]) {
      try {
        return new TextDecoder(label).decode(buffer);
      } catch {
        // Try the next charset.
      }
    }
    return new TextDecoder().decode(buffer);
  }

  async getJson(url: string, options: { headers?: Record<string, string>; delayMs?: number } = {}): Promise<unknown> {
    const text = await this.getText(url, options);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ScraperHttpError(`Invalid JSON returned from ${url}`, url, undefined, error);
    }
  }

  private async fetchWithRetry(
    url: string,
    options: { headers?: Record<string, string>; delayMs?: number },
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      if (options.delayMs && attempt === 1) await wait(options.delayMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": this.userAgent,
            Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
            ...options.headers,
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new ScraperHttpError(`Source returned HTTP ${response.status}`, url, response.status);
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) await wait(400 * attempt);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (lastError instanceof ScraperHttpError) throw lastError;
    throw new ScraperHttpError(`Could not fetch ${url}`, url, undefined, lastError);
  }
}

export function htmlToImportantText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg, canvas").remove();
  $("br").replaceWith("\n");
  $("p,li,h1,h2,h3,h4,h5,h6,tr,section,article").append("\n");
  return cleanText($.root().text().replace(/\n+/g, "\n"));
}

export function sanitizeImportantHtml(html: string): string {
  const allowed = new Set([
    "article",
    "section",
    "div",
    "p",
    "span",
    "ul",
    "ol",
    "li",
    "strong",
    "b",
    "em",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
  ]);
  const $ = cheerio.load(html, null, false);
  $("script, style, noscript, iframe, object, embed, link").remove();
  $("*").each((_, element) => {
    const tagName = element.type === "tag" ? element.tagName.toLowerCase() : "";
    if (!allowed.has(tagName)) {
      $(element).replaceWith($(element).contents());
      return;
    }
    const attrs = "attribs" in element ? element.attribs : {};
    for (const attr of Object.keys(attrs ?? {})) $(element).removeAttr(attr);
  });
  return $.html().replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  return unique(
    $("a[href]")
      .toArray()
      .flatMap((anchor) => {
        const href = $(anchor).attr("href");
        if (!href) return [];
        try {
          return [new URL(href, baseUrl).href];
        } catch {
          return [];
        }
      }),
  );
}

export function contentHashFromParts(parts: Array<string | null | undefined>): string {
  return hashContent(parts.map((part) => cleanText(part)).join("\n---\n"));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
