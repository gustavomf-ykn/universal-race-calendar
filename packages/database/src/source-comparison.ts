export const comparisonFields = ["name", "date", "city", "state", "country", "modality", "registrationUrl", "officialUrl"] as const;
type Field = typeof comparisonFields[number];
export type SourceObservation = Partial<Record<Field, string | null>>;
export function observationOf(event: SourceObservation): SourceObservation {
  return Object.fromEntries(comparisonFields.map(field => [field, event[field] ?? null]));
}
function normalized(value: unknown, field: Field): string | null {
  if (typeof value !== "string" || !value.trim() || (field === "modality" && value === "unknown")) return null;
  if (field === "date") return value.slice(0, 10);
  if (field.endsWith("Url")) {
    try {
      const u = new URL(value); u.hash = "";
      for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
      return u.href.replace(/\/$/, "");
    } catch { return value; }
  }
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
export function compareSourceObservations(canonical: SourceObservation, sources: Array<{
  sourceType: string; sourceExternalId: string; observation: SourceObservation; lastValidatedAt: Date | string | null;
}>) {
  return comparisonFields.map(field => {
    const evidence = sources.map(source => ({ source: source.sourceType, externalId: source.sourceExternalId,
      value: source.observation[field] ?? null, validatedAt: source.lastValidatedAt }));
    const confirmed = evidence.filter(e => e.validatedAt && normalized(e.value, field) !== null);
    const values = new Set(confirmed.map(e => normalized(e.value, field)));
    const chosen = normalized(canonical[field], field);
    return { field, canonicalValue: canonical[field] ?? null, evidence,
      conflict: values.size > 1 || (chosen !== null && confirmed.some(e => normalized(e.value, field) !== chosen)),
      missingEvidence: confirmed.length === 0,
    };
  });
}
