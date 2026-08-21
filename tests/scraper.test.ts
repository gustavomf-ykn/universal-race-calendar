import { afterEach, describe, expect, it, vi } from "vitest";
import { ScraperHttpClient } from "@race-calendar/scraper";

describe("scraper encoding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes a legacy Windows-1252 CorridasBR response", async () => {
    const bytes = new Uint8Array([
      0x3c, 0x68, 0x31, 0x3e,
      0x53, 0xe3, 0x6f, 0x20, 0x4a, 0x6f, 0x73, 0xe9,
      0x3c, 0x2f, 0x68, 0x31, 0x3e,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { headers: { "content-type": "text/html; charset=windows-1252" } })),
    );
    const client = new ScraperHttpClient({ maxRetries: 1 });
    await expect(client.getText("https://www.corridasbr.com.br/SP/calendario.asp")).resolves.toContain("São José");
  });
});
