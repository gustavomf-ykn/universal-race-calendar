import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CorridasBRAdapter,
  discoverCorridasBREvents,
  discoverTicketSportsEvents,
  isCorridasBRSecurityChallenge,
  MockSourceAdapter,
  OfficialEventPageAdapter,
  parseCorridasBRCalendar,
  parseCorridasBRDetail,
  TicketSportsAdapter,
  ticketSportsListUrl,
} from "@race-calendar/sources";
import { rawSourceExtractionSchema } from "@race-calendar/schemas";

const ticketsportsFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-simple.json", "utf-8")) as Record<
  string,
  unknown
>;
const ticketsportsListFixture = JSON.parse(readFileSync("tests/fixtures/ticketsports-list.json", "utf-8")) as unknown[];
const corridasBRCalendarFixture = readFileSync("tests/fixtures/corridasbr-calendar.html", "utf-8");
const corridasBRDetailFixture = readFileSync("tests/fixtures/corridasbr-detail.html", "utf-8");
const officialEventFixture = readFileSync("tests/fixtures/official-event.html", "utf-8");

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

  it("skips explicitly non-Brazil TicketSports events during discovery", async () => {
    const discovered = await discoverTicketSportsEvents({
      quantity: 1000,
      quickFilter: "corrida-de-rua",
      client: {
        async getJson() {
          return [
            ...ticketsportsListFixture,
            {
              organizer: "SUB4.RUN",
              date: "08/11/2026",
              address: "Porto, Portugal",
              uri: "https://www.ticketsports.com.br/e/Maratona+do+Porto-85488",
              eventId: 85488,
              title: "Maratona do Porto",
              status: "Aberto",
            },
          ];
        },
        async getText() {
          throw new Error("getText should not be called for list payloads");
        },
      },
    });

    expect(discovered.map((event) => event.externalId)).toEqual(["74641"]);
    expect(discovered.every((event) => event.country === "BR")).toBe(true);
  });

  it("discovers CorridasBR events from a state calendar", async () => {
    const parsed = parseCorridasBRCalendar(corridasBRCalendarFixture, "SP");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      sourceType: "corridasbr",
      externalId: "98765",
      name: "Corrida das Águas 2026",
      date: "2026-10-18",
      city: "Campinas",
      state: "SP",
    });

    const discovered = await discoverCorridasBREvents({
      states: ["SP"],
      client: {
        async getText() {
          return corridasBRCalendarFixture;
        },
        async getJson() {
          throw new Error("getJson should not be called");
        },
      },
    });
    expect(discovered.map((event) => event.externalId)).toEqual(["98765", "98766"]);
  });

  it("detects a CorridasBR security challenge instead of treating it as an empty calendar", () => {
    expect(
      isCorridasBRSecurityChallenge("<h1>Verificacao de seguranca</h1><p>Responda ao desafio abaixo</p>"),
    ).toBe(true);
    expect(isCorridasBRSecurityChallenge(corridasBRCalendarFixture)).toBe(false);
  });

  it("extracts CorridasBR detail fields and the external TicketSports target", () => {
    const detail = parseCorridasBRDetail(
      corridasBRDetailFixture,
      "https://www.corridasbr.com.br/SP/mostracorrida.asp?escolha=98765",
    );
    expect(detail).toMatchObject({
      name: "Corrida das Águas 2026",
      date: "2026-10-18",
      city: "Campinas",
      state: "SP",
      locationName: "Parque Portugal, Portão 2",
      distanceText: "5 km e 10 km",
      organizerName: "Associação Campinas Corre",
      officialUrl: "https://www.ticketsports.com.br/e/corrida-das-aguas-98765",
    });
  });

  it("enriches CorridasBR with a real official cover and never uses an ad banner", async () => {
    const adapter = new CorridasBRAdapter({
      async getText(url) {
        return url.includes("corridasbr.com.br") ? corridasBRDetailFixture : officialEventFixture;
      },
      async getJson() {
        throw new Error("getJson should not be called");
      },
    });
    const extraction = await adapter.fetchAndExtract({
      sourceId: "src_corridasbr",
      sourceExternalId: "98765",
      url: "https://www.corridasbr.com.br/SP/mostracorrida.asp?escolha=98765",
    });
    expect(extraction.sourceType).toBe("corridasbr");
    expect(extraction.importantText).toContain("5 km e 10 km");
    expect(JSON.stringify(extraction.rawSourceData)).not.toContain("publicidade/banner.jpg");
  });

  it("extracts JSON-LD and OpenGraph from an official event page", async () => {
    const adapter = new OfficialEventPageAdapter({
      async getText() {
        return officialEventFixture;
      },
      async getJson() {
        throw new Error("getJson should not be called");
      },
    });
    const extraction = await adapter.fetchAndExtract({
      sourceId: "src_official",
      url: "https://corridadasaguas.example/2026",
    });
    expect(extraction.title).toBe("Corrida das Águas 2026");
    expect(JSON.stringify(extraction.rawSourceData)).toContain("capa-2026.jpg");
  });
});
