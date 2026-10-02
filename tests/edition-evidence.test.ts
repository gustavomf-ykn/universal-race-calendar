import { describe, expect, it } from "vitest";
import { editionIdentity, editionLinks, editionLocationEvidence } from "@race-calendar/database";

describe("edition identity proof", () => {
  it("recognizes only the exact approved providers and edition routes", () => {
    expect(editionIdentity("https://www.ticketsports.com.br/e/Corrida-85488")?.externalId).toBe("85488");
    expect(editionIdentity("https://openresults.run/evento/prova-2026/")?.externalId).toBe("url:prova-2026");
    expect(editionIdentity("https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=123")?.externalId).toBe(
      "SC:123",
    );
    for (const url of [
      "https://www.ticketsports.com.br.attacker.test/e/prova-85488",
      "https://attacker-ticketsports.com.br/e/prova-85488",
      "https://user:pass@www.ticketsports.com.br/e/prova-85488",
      "https://www.ticketsports.com.br:444/e/prova-85488",
      "https://www.ticketsports.com.br/organizer/85488",
      "https://www.ticketsports.com.br/?eventId=85488",
      "https://openresults.run/",
      "https://organizer.test/prova-85488",
      "https://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=1&escolha=2",
      "https://www.corridasbr.com.br/XX/mostracorrida.asp?escolha=123",
    ])
      expect(editionIdentity(url)).toBeNull();
  });
  it("preserves identity-bearing parameters while ignoring only tracking and fragments", () => {
    expect(
      editionIdentity("http://www.corridasbr.com.br/SC/mostracorrida.asp?escolha=123&p=2&utm_source=test#top")?.url,
    ).toBe("https://corridasbr.com.br/SC/mostracorrida.asp?escolha=123&p=2");
    expect(
      editionLinks({
        officialUrl: "https://organizer.test/",
        registrationUrl: "https://www.ticketsports.com.br/e/prova-85488",
      }),
    ).toHaveLength(1);
  });
  it("requires the same complete date and observed location without treating accents as conflicts", () => {
    const a = { date: "2026-10-10", city: "São José", state: "SC", country: "BR" };
    expect(editionLocationEvidence(a, { ...a, date: new Date("2026-10-10"), city: "sao jose" })).toBeNull();
    expect(editionLocationEvidence(a, { ...a, date: "2027-10-10" })).toBe("edition_date_mismatch");
    expect(editionLocationEvidence(a, { ...a, date: "2026-10-11" })).toBe("edition_date_mismatch");
    expect(editionLocationEvidence(a, { ...a, country: null })).toBe("edition_location_unconfirmed");
    expect(editionLocationEvidence(a, { ...a, country: "PT" })).toBe("edition_location_conflict");
    expect(editionLocationEvidence(a, { ...a, city: null, country: "PT" })).toBe("edition_location_conflict");
    expect(editionLocationEvidence(a, { ...a, city: "Joinville" })).toBe("edition_location_conflict");
  });
});
