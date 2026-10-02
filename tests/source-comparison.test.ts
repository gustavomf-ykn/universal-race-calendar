import { describe, expect, it } from "vitest";
import { compareSourceObservations, observationOf } from "@race-calendar/database";
describe("field-level comparison of verified source observations", () => {
  const source = (observation: object, lastValidatedAt: string | null = "2026-10-01") => ({
    sourceType: "ticketsports", sourceExternalId: "123", observation, lastValidatedAt,
  });
  it("compares dates and locations without treating accents/case as disagreements", () => {
    const rows = compareSourceObservations({ city: "São José", date: "2026-10-01" }, [source({ city: "sao jose", date: "2026-10-01T00:00:00Z" })]);
    expect(rows.find(r => r.field === "city")).toMatchObject({ conflict: false, missingEvidence: false });
    expect(rows.find(r => r.field === "date")).toMatchObject({ conflict: false });
  });
  it("reports another edition or a conflicting city without silently choosing a value", () => {
    const rows = compareSourceObservations({ date: "2026-10-01", city: "Garuva" }, [source({ date: "2025-10-01", city: "Joinville" })]);
    expect(rows.filter(r => r.conflict).map(r => r.field)).toEqual(["date", "city"]);
  });
  it("does not label missing/unvalidated data or unknown modality as agreement", () => {
    const rows = compareSourceObservations({ modality: "trail" }, [source({ modality: "unknown" }), source({ city: "Garuva" }, null)]);
    expect(rows.find(r => r.field === "modality")).toMatchObject({ missingEvidence: true });
    expect(rows.find(r => r.field === "city")).toMatchObject({ missingEvidence: true });
  });
  it("whitelists public event fields without passing arbitrary metadata to the frontend", () => {
    const value = observationOf({ name: "Corrida", organizerEmail: "secret@example.test", databaseUrl: "secret" } as never);
    expect(JSON.stringify(value)).not.toContain("secret");
    expect(value.name).toBe("Corrida");
  });
  it("does not compare a missing-name placeholder as an observed source name", () => {
    const observation = observationOf({ name: "Evento sem nome", warnings: ["missing_name"] });
    expect(observation.name).toBeNull();
    expect(compareSourceObservations({ name: "Nome validado" }, [source(observation)]).find(row => row.field === "name"))
      .toMatchObject({ conflict: false, missingEvidence: true });
  });
});
