import { describe, expect, it } from "vitest";
import { nextTicketSportsPrefix, parseTicketSportsCatalogPage, ticketSportsCatalogUrl } from "@race-calendar/sources";

const row = (id: number, extra: object = {}) => ({ eventId: id, title: "Corrida", uri: `https://www.ticketsports.com.br/e/prova-${id}`,
  address: "Garuva, SC", date: "01/10/2026", ...extra });
describe("official national TicketSports discovery", () => {
  it("uses verified country/region filters, without restricting discovery to street races", () => {
    const url = new URL(ticketSportsCatalogUrl({ quantity: 25, state: "SC" }));
    expect(Object.fromEntries(url.searchParams)).toEqual({ quantity: "25", atlheteId: "0", term: "", country: "BR", region: "SC" });
    expect(() => ticketSportsCatalogUrl({ quantity: 25, state: "XX" })).toThrow("catalog_state_invalid");
  });
  it("uses raw counts even when rows duplicate or are excluded by country", () => {
    const page = parseTicketSportsCatalogPage([row(1), row(1), row(2, { address: "Lisboa, Portugal" })], 3);
    expect(page.events).toHaveLength(1);
    expect(page.rawCount).toBe(3);
    expect(page.terminal).toBe(false);
    expect(page.excludedCountryCount).toBe(1);
  });
  it("never treats malformed/truncated candidates as coverage completion", () => {
    const page = parseTicketSportsCatalogPage([row(1), { eventId: 2 }], 25);
    expect(nextTicketSportsPrefix(page, [])).toMatchObject({ status: "blocked", reason: "catalog_invalid_candidates" });
    expect(() => parseTicketSportsCatalogPage({ events: [] }, 25)).toThrow("catalog_structure_changed");
  });
  it("preserves explicit edition dates but does not infer ambiguous dates from titles/deadlines", () => {
    const page = parseTicketSportsCatalogPage([row(1), row(2, { date: "10 e 11 de Outubro", title: "Prova 2026", signUpDeadLine: "01/10/2026" })], 25);
    expect(page.events.map(e => e.date)).toEqual(["2026-10-01", null]);
  });
  it("rejects external credential-bearing URLs and strips organizer contact/identity fields", () => {
    const page = parseTicketSportsCatalogPage([row(1, { organizerEmail: "private@example.test", organizerDocumentNumber: "secret" }),
      row(2, { uri: "https://www.ticketsports.com.br.attacker.test/e/2" }), row(3, { uri: "https://user:pass@www.ticketsports.com.br/e/3" })], 25);
    expect(page.invalidCount).toBe(2);
    expect(JSON.stringify(page.events)).not.toContain("private@example.test");
    expect(JSON.stringify(page.events)).not.toContain("secret");
  });
  it("expands the official prefix and refuses to label a safety ceiling or repetition complete", () => {
    const page = parseTicketSportsCatalogPage(Array.from({ length: 25 }, (_, i) => row(i + 1)), 25);
    expect(nextTicketSportsPrefix(page, [])).toMatchObject({ status: "ready", quantity: 50 });
    expect(nextTicketSportsPrefix(page, page.rawIds)).toMatchObject({ status: "limited", reason: "catalog_not_advancing" });
    expect(nextTicketSportsPrefix(page, [], 25)).toMatchObject({ status: "limited", reason: "catalog_safety_ceiling" });
    expect(nextTicketSportsPrefix(parseTicketSportsCatalogPage([row(1)], 25), [])).toMatchObject({ status: "completed" });
  });
});
