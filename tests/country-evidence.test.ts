import { describe, expect, it } from "vitest";
import { countryFromExplicitValue } from "@race-calendar/utils";
import { normalizeRaceEventExtraction, evaluatePublishability } from "@race-calendar/curation";
import { rawSourceExtractionSchema, raceEventExtractionSchema } from "@race-calendar/schemas";
import { CorridasBRAdapter, parseCorridasBRCalendar, parseCorridasBRDetail } from "@race-calendar/sources";

const extraction = raceEventExtractionSchema.parse({
  name: { value: "Corrida", confidence: 0.99 },
  date: { value: "2026-10-18", confidence: 0.99 },
  city: { value: "Vitória", confidence: 0.99 },
  state: { value: "ES", confidence: 0.99 },
  country: { value: "BR", confidence: 0.99, sourceText: "Brasil inventado pelo modelo" },
  modality: "road",
  confidence: 0.99,
});
const raw = (importantText: string, rawSourceData: object = {}, sourceType = "ticketsports") =>
  rawSourceExtractionSchema.parse({
    sourceType,
    sourceId: "country-evidence",
    sourceExternalId: "123456",
    url: "https://www.ticketsports.com.br/e/prova-123456",
    title: "Corrida",
    importantText: `Corrida de rua. ${importantText}`,
    rawSourceData,
    fetchedAt: "2026-10-02T12:00:00.000Z",
    contentHash: "country-evidence-test",
    adapter: sourceType,
    adapterVersion: "1.0.0",
  });

describe("country observed at the edition location", () => {
  it.each(["Vitória, ES", "Vitória, ES. Organizador no Brasil", "Avenida Brasil, Vitória, ES", "Porto, Portugal"])(
    "does not accept the model's BR or its fabricated quote: %s",
    (text) => {
      const result = normalizeRaceEventExtraction(extraction, raw(text));
      expect(result.country).toBeNull();
      expect(result.warnings).toEqual(expect.arrayContaining(["country_unconfirmed", "country_evidence_mismatch"]));
      expect(evaluatePublishability(result).canPublish).toBe(false);
    },
  );
  it("does not treat ES as Spain in a free-text city/UF/country location", () => {
    const result = normalizeRaceEventExtraction(extraction, raw("Vitória, ES, Brasil."));
    expect(result.country).toBe("BR");
    expect(result.warnings).not.toContain("country_evidence_mismatch");
    // ES is valid only when explicitly labelled as a country, never by the UF alone.
    expect(countryFromExplicitValue("ES")).toEqual({ country: "ES", sourceText: "ES" });
  });
  it("accepts actual structured evidence even when omitted by the model and recomputes warnings", () => {
    const result = normalizeRaceEventExtraction(
      {
        ...extraction,
        country: { value: null, confidence: 0, sourceText: null },
        warnings: ["country_unconfirmed", "conflicting_country", "country_evidence_mismatch"],
      },
      raw("", { address: "Vitória, ES, Brasil" }),
    );
    expect(result.country).toBe("BR");
    expect(result.warnings).toEqual([]);
  });
  it("records contradictory model output and real source countries separately", () => {
    const mismatch = normalizeRaceEventExtraction(
      { ...extraction, country: { value: "PT", confidence: 0.99, sourceText: "Portugal" } },
      raw("", { address: "Vitória, ES, Brasil" }),
    );
    expect(mismatch.country).toBe("BR");
    expect(mismatch.warnings).toContain("country_evidence_mismatch");
    expect(evaluatePublishability(mismatch).reasons).toContain("critical_warning");
    const conflicting = normalizeRaceEventExtraction(
      extraction,
      raw("Vitória, ES, Portugal.", { address: "Vitória, ES, Brasil" }),
    );
    expect(conflicting.country).toBeNull();
    expect(conflicting.warnings).toContain("conflicting_country");
  });
  it("ignores legacy CorridasBR BR defaults and accepts only observed labels", () => {
    expect(
      normalizeRaceEventExtraction(extraction, raw("", { corridasbr: { country: "BR" } }, "corridasbr")).country,
    ).toBeNull();
    expect(
      normalizeRaceEventExtraction(
        extraction,
        raw("", { corridasbr: { countrySourceTexts: ["Brasil"] } }, "corridasbr"),
      ).country,
    ).toBe("BR");
    for (const labels of [
      ["Brasil", "Portugal"],
      ["Brasil", "País não reconhecido"],
    ]) {
      expect(
        normalizeRaceEventExtraction(extraction, raw("", { corridasbr: { countrySourceTexts: labels } }, "corridasbr"))
          .country,
      ).toBeNull();
    }
  });
  it("uses a linked official country's structured value only for a compatible dated location", () => {
    const structured = (date: string, city: string) => ({
      corridasbr: { date: "2026-10-18" },
      officialPage: {
        jsonLdEvent: {
          startDate: date,
          location: {
            address: {
              addressLocality: city,
              addressRegion: "ES",
              addressCountry: { name: "Brasil", identifier: "BR" },
            },
          },
        },
      },
    });
    expect(
      normalizeRaceEventExtraction(
        extraction,
        raw("", structured("2026-10-18T07:00:00-03:00", "Vitória"), "corridasbr"),
      ).country,
    ).toBe("BR");
    expect(
      normalizeRaceEventExtraction(extraction, raw("", structured("2027-10-18", "Vitória"), "corridasbr")).country,
    ).toBeNull();
    expect(
      normalizeRaceEventExtraction(
        extraction,
        raw("Vitória, ES, Brasil", structured("2027-10-18", "Vitória"), "corridasbr"),
      ).country,
    ).toBeNull();
    expect(
      normalizeRaceEventExtraction(extraction, raw("", structured("2026-10-18", "Outra Cidade"), "corridasbr")).country,
    ).toBeNull();
  });
});

describe("CorridasBR extraction retains source country labels", () => {
  const url = "https://www.corridasbr.com.br/ES/mostracorrida.asp?escolha=123456";
  const html = `<div class="tipo7"><strong>Corrida</strong></div><table>
    <tr><td>Data:</td><td>18/10/2026</td></tr><tr><td>Cidade:</td><td>Vitória</td></tr>
    <tr><td>Modalidade:</td><td>Trail</td></tr>`;
  it("does not derive BR from UF, calendar membership or an organizer footer", () => {
    expect(parseCorridasBRDetail(html + "</table><footer>Empresa no Brasil</footer>", url)).toMatchObject({
      country: null,
      countrySourceTexts: [],
    });
    const calendar = `<table><tr><td><a href="mostracorrida.asp?escolha=123456">Corrida Brasil</a></td></tr></table>`;
    expect(
      parseCorridasBRCalendar(calendar + '<footer itemprop="addressCountry">Brasil</footer>', "ES")[0]?.country,
    ).toBeNull();
    const scoped = calendar.replace("<td>", '<td><meta itemprop="addressCountry" content="BR">');
    expect(parseCorridasBRCalendar(scoped, "ES")[0]).toMatchObject({
      country: "BR",
      metadata: { countrySourceTexts: ["BR"] },
    });
    const organizer = calendar.replace(
      "<td>",
      '<td><div itemprop="organizer"><meta itemprop="addressCountry" content="BR"></div>',
    );
    expect(parseCorridasBRCalendar(organizer, "ES")[0]?.country).toBeNull();
  });
  it("keeps labels and modality in raw data, text and content hash for deterministic re-curation", async () => {
    const sourceHtml = html + "<tr><td>País:</td><td>Brasil</td></tr></table>";
    const adapter = (content: string) =>
      new CorridasBRAdapter({
        async getText() {
          return content;
        },
        async getJson() {
          throw Error("unexpected_transport");
        },
      });
    const input = {
      sourceId: "test-country",
      sourceExternalId: "123456",
      url,
      metadata: { enrichOfficialPages: false },
    };
    const observed = await adapter(sourceHtml).fetchAndExtract(input);
    expect(observed.importantText).toContain("Modalidade: Trail");
    expect(observed.rawSourceData).toMatchObject({ corridasbr: { country: "BR", countrySourceTexts: ["Brasil"] } });
    expect(normalizeRaceEventExtraction(extraction, observed)).toMatchObject({ country: "BR", modality: "trail" });
    const unknown = await adapter(html + "</table>").fetchAndExtract(input);
    expect(unknown.contentHash).not.toBe(observed.contentHash);
    const conflict = parseCorridasBRDetail(
      sourceHtml.replace("</table>", "<tr><td>Country:</td><td>Portugal</td></tr></table>"),
      url,
    );
    expect(conflict).toMatchObject({ country: null, countrySourceTexts: ["Brasil", "Portugal"] });
  });
});
