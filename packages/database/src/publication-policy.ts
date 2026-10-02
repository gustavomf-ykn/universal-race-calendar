import { cleanText, normalizeDate } from "@race-calendar/utils";
import { editionIdentity } from "./edition-evidence.js";

export const brazilianStateCodes = [
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
] as const;

/** Structural requirements are shared by automatic and audited administrative publication. */
export function validPublicationCity(value: string | null | undefined): boolean {
  const city = cleanText(value);
  return Boolean(
    city && !/[\uFFFD<>]/u.test(city) && !/corridas?\s+(?:nesta cidade|nesta regi[aã]o)|https?:\/\//i.test(city),
  );
}

export function validBrazilianPublicationLocation(event: { city?: string | null; state?: string | null }): boolean {
  return validPublicationCity(event.city) && brazilianStateCodes.some((state) => state === event.state);
}

type Reference = { sourceType?: string | null; sourceExternalId?: string | null; url?: string | null };
export function validPublicationReference(ref: Reference): boolean {
  const identity = editionIdentity(ref.url);
  if (!identity || identity.source !== ref.sourceType || !ref.sourceExternalId) return false;
  if (identity.source === "ticketsports") return identity.externalId === ref.sourceExternalId;
  if (identity.source === "corridasbr")
    return identity.externalId === ref.sourceExternalId || identity.externalId.split(":")[1] === ref.sourceExternalId;
  // OpenResults numeric IDs are obtained from the provider and are not URL slugs.
  return identity.externalId === ref.sourceExternalId || /^\d+$/.test(ref.sourceExternalId);
}

export function hasPublicationReference(event: {
  sourceType?: string | null;
  sourceExternalId?: string | null;
  sourceUrl?: string | null;
  state?: string | null;
  sourceReferences?: Reference[];
}): boolean {
  const compatible = (ref: Reference) => {
    if (!validPublicationReference(ref)) return false;
    const identity = editionIdentity(ref.url)!;
    return identity.source !== "corridasbr" || identity.externalId.split(":")[0] === event.state;
  };
  return (
    compatible({
      sourceType: event.sourceType ?? null,
      sourceExternalId: event.sourceExternalId ?? null,
      url: event.sourceUrl ?? null,
    }) || Boolean(event.sourceReferences?.some(compatible))
  );
}

export function validPublicationDate(value: Date | string | null): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && normalizeDate(value) === value);
}

export function eventPublicationError(event: {
  name: string;
  date: Date | string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  modality: string;
  sourceType?: string | null;
  sourceExternalId?: string | null;
  sourceUrl?: string | null;
  sourceReferences?: Reference[];
}): string | null {
  if (!cleanText(event.name)) return "publication_requires_name";
  if (!validPublicationDate(event.date) || !validBrazilianPublicationLocation(event))
    return "publication_requires_date_city_state";
  if (event.country !== "BR") return "publication_requires_brazil_country";
  if (!["road", "trail", "mixed", "kids", "walk"].includes(event.modality))
    return "publication_requires_confirmed_modality";
  if (!hasPublicationReference(event)) return "publication_requires_valid_source_reference";
  return null;
}
