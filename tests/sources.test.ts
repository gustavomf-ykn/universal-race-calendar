import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MockSourceAdapter, TicketSportsAdapter } from "@race-calendar/sources";
import { rawSourceExtractionSchema } from "@race-calendar/schemas";

const ticketsportsFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-simple.json", "utf-8")) as Record<
  string,
  unknown
>;

describe("source adapters", () => {
  it("recognizes TicketSports URLs", () => {
    const adapter = new TicketSportsAdapter();
    expect(adapter.canHandle("https://www.ticketsports.com.br/e/corrida-123456")).toBe(true);
    expect(adapter.canHandle("https://example.test/e/corrida")).toBe(false);
  });

  it("returns valid mock raw extraction and changes hash with content", async () => {
    const adapter = new MockSourceAdapter();
    const first = await adapter.fetchAndExtract({ sourceId: "src_1", url: "mock://one", metadata: { importantText: "A" } });
    const second = await adapter.fetchAndExtract({ sourceId: "src_1", url: "mock://one", metadata: { importantText: "B" } });
    expect(first.sourceType).toBe("mock");
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("returns a valid RawSourceExtraction from TicketSports detail payload", async () => {
    const adapter = new TicketSportsAdapter({
      async getJson() {
        return ticketsportsFixture;
      },
      async getText() {
        throw new Error("getText should not be called for detail payloads");
      },
    });

    const extraction = await adapter.fetchAndExtract({
      sourceId: "src_ticketsports",
      sourceExternalId: "123456",
      url: "https://www.ticketsports.com.br/e/meia-maratona-florianopolis-123456",
    });

    expect(rawSourceExtractionSchema.safeParse(extraction).success).toBe(true);
    expect(extraction.sourceType).toBe("ticketsports");
    expect(extraction.adapter).toBe("ticketsports");
    expect(extraction.sourceExternalId).toBe("123456");
    expect(extraction.title).toBe("Meia Maratona de Florianopolis");
    expect(extraction.importantText).toContain("21 km");
    expect(extraction.importantHtml).toContain("Meia Maratona de Florianopolis");
    expect(extraction.rawSourceData.eventId).toBe("123456");
    expect(extraction.contentHash).toHaveLength(64);
  });
});
