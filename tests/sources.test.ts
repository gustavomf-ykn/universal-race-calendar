import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { discoverTicketSportsEvents, MockSourceAdapter, TicketSportsAdapter, ticketSportsListUrl } from "@race-calendar/sources";
import { rawSourceExtractionSchema } from "@race-calendar/schemas";

const ticketsportsFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-simple.json", "utf-8")) as Record<
  string,
  unknown
>;
const ticketsportsListFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-list.json", "utf-8")) as unknown[];

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

  it("discovers TicketSports street race events from list payload", async () => {
    const discovered = await discoverTicketSportsEvents({
      quantity: 1000,
      quickFilter: "corrida-de-rua",
      client: {
        async getJson(url) {
          expect(url).toBe(ticketSportsListUrl({ quantity: 1000, quickFilter: "corrida-de-rua" }));
          return ticketsportsListFixture;
        },
        async getText() {
          throw new Error("getText should not be called for list payloads");
        },
      },
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      adapter: "ticketsports",
      externalId: "74641",
      name: "9a MEIA MARATONA DE UBERABA",
      city: "Uberaba",
      state: "MG",
      country: "BR",
    });
  });
});
