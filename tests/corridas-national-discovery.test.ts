import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCorridasBRCatalogPage, corridasBRCatalogUrl } from "@race-calendar/sources";
const html = readFileSync(new URL("./fixtures/corridasbr-calendar.html", import.meta.url), "utf8");
describe("explicit CorridasBR calendar navigation", () => {
  it("discovers the next calendar without following other UFs, domains or event details", () => {
    const result = parseCorridasBRCatalogPage(html + `<a href="Calendario2.asp">Próximas Corridas</a>
      <a href="/SP/calendario.asp">SP</a><a href="https://evil.test/SC/calendario2.asp">bad</a>`, "SC");
    expect(result.events).toHaveLength(2);
    expect(result.nextUrls).toEqual(["https://www.corridasbr.com.br/sc/calendario2.asp"]);
    expect(corridasBRCatalogUrl("http://corridasbr.com.br/SC/Calendario2.asp#top", "SC")).toBe(result.nextUrls[0]);
  });
  it("does not treat a security challenge or generic error as an empty completed calendar", () => {
    expect(() => parseCorridasBRCatalogPage("<h1>Verificação de segurança</h1>", "SC")).toThrow("source_access_blocked");
    expect(() => parseCorridasBRCatalogPage("<h1>Server unavailable</h1>", "SC")).toThrow("catalog_end_unconfirmed");
    const empty = parseCorridasBRCatalogPage(`<link rel="canonical" href="https://www.corridasbr.com.br/AC/calendario.asp"><h1>Calendário de corridas</h1>`, "AC");
    expect(empty.events).toEqual([]);
    expect(() => corridasBRCatalogUrl("https://user:secret@www.corridasbr.com.br/SC/calendario.asp", "SC")).toThrow();
  });
});
