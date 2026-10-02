/** Evidence of an edition, rather than a shared organizer or similar name. */
export type EditionIdentity = { source: string; externalId: string; url: string };

const editionFailureCodes = new Set([
  "edition_date_unconfirmed",
  "edition_date_mismatch",
  "edition_location_unconfirmed",
  "edition_location_conflict",
  "edition_source_identity_conflict",
  "edition_administratively_restricted",
  "edition_link_unconfirmed",
  "edition_observation_unconfirmed",
  "source_identifier_reused_for_different_edition",
]);
export function editionFailureCode(error: unknown): string | null {
  return error instanceof Error && editionFailureCodes.has(error.message) ? error.message : null;
}

export function editionIdentity(value: string | null | undefined): EditionIdentity | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.replace(/^www\./, "");
    let source: string;
    let externalId: string;
    if (host === "ticketsports.com.br") {
      const match = url.pathname.match(/^\/e\/[^/]*-(\d+)\/?$/i);
      if (!match) return null;
      source = "ticketsports";
      externalId = match[1]!;
    } else if (host === "openresults.run") {
      const match = url.pathname.match(/^\/evento\/([^/]+)\/?$/);
      if (!match) return null;
      source = "openresults";
      // The public slug is a URL identity; it is not the provider's numeric ID.
      externalId = "url:" + match[1];
    } else if (host === "corridasbr.com.br") {
      const match = url.pathname.match(/^\/([A-Za-z]{2})\/mostracorrida\.asp$/i);
      const choices = url.searchParams.getAll("escolha");
      if (
        !match ||
        !/^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/i.test(match[1]!) ||
        choices.length !== 1 ||
        !/^\d+$/.test(choices[0]!)
      )
        return null;
      source = "corridasbr";
      externalId = match[1]!.toUpperCase() + ":" + choices[0];
    } else return null;
    // Keep identity-bearing parameters. Only tracking and fragment are irrelevant.
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_")) url.searchParams.delete(key);
    url.searchParams.sort();
    url.hostname = host;
    url.protocol = "https:";
    url.pathname = url.pathname.replace(/\/$/, "");
    return { source, externalId, url: url.href };
  } catch {
    return null;
  }
}

export function editionLinks(event: {
  registrationUrl?: string | null;
  officialUrl?: string | null;
  sourceUrl?: string | null;
}) {
  return [event.registrationUrl, event.officialUrl, event.sourceUrl].flatMap((url) => {
    const identity = editionIdentity(url);
    return identity ? [{ ...identity, originalUrl: url! }] : [];
  });
}

/** Query aliases of an already validated edition route; never fetch these URLs. */
export function editionUrlVariants(link: EditionIdentity & { originalUrl: string }): string[] {
  const urls = new Set([link.originalUrl, link.url]);
  const normalizedUrl = new URL(link.url);
  const slashes = link.source === "corridasbr" ? [""] : ["", "/"];
  for (const protocol of ["http:", "https:"])
    for (const prefix of ["", "www."])
      for (const slash of slashes) {
        const value = new URL(normalizedUrl);
        value.protocol = protocol;
        value.hostname = prefix + normalizedUrl.hostname;
        value.pathname = normalizedUrl.pathname.replace(/\/$/, "") + slash;
        urls.add(value.href);
      }
  return [...urls];
}

export type EditionLocation = {
  date: Date | string | null;
  city: string | null;
  state: string | null;
  country: string | null;
};
const normalized = (value: string | null) =>
  value
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim() || null;
const date = (value: Date | string | null) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value?.slice(0, 10) || null;

export function editionLocationEvidence(left: EditionLocation, right: EditionLocation): string | null {
  if (!left.date || !right.date) return "edition_date_unconfirmed";
  if (date(left.date) !== date(right.date)) return "edition_date_mismatch";
  let incomplete = false;
  for (const field of ["city", "state", "country"] as const) {
    const a = normalized(left[field]),
      b = normalized(right[field]);
    if (!a || !b) incomplete = true;
    else if (a !== b) return "edition_location_conflict";
  }
  return incomplete ? "edition_location_unconfirmed" : null;
}

type EditionCandidate = EditionLocation & {
  sourceType: string | null;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  registrationUrl: string | null;
  officialUrl: string | null;
  publicationStatus: string;
  sourceReferences: Array<{
    sourceType: string;
    sourceExternalId: string;
    url: string;
    observation: unknown;
    lastValidatedAt: Date | null;
  }>;
};

export function crossSourceEditionReason(
  incoming: EditionLocation & {
    sourceType: string | null;
    sourceExternalId: string | null;
    sourceUrl: string | null;
    registrationUrl: string | null;
    officialUrl: string | null;
  },
  candidate: EditionCandidate,
): string | null {
  const refs = candidate.sourceReferences;
  if (
    (candidate.sourceType === incoming.sourceType && candidate.sourceExternalId !== incoming.sourceExternalId) ||
    refs.some((ref) => ref.sourceType === incoming.sourceType && ref.sourceExternalId !== incoming.sourceExternalId)
  )
    return "edition_source_identity_conflict";
  if (["hidden", "rejected"].includes(candidate.publicationStatus)) return "edition_administratively_restricted";
  const location = editionLocationEvidence(incoming, candidate);
  if (location) return location;
  const sourceLinks = editionLinks(incoming);
  const targetLinks = [...editionLinks(candidate), ...refs.flatMap((ref) => editionLinks({ sourceUrl: ref.url }))];
  const strong = sourceLinks.some(
    (link) =>
      (link.source === "ticketsports" &&
        ((candidate.sourceType === link.source && candidate.sourceExternalId === link.externalId) ||
          refs.some((ref) => ref.sourceType === link.source && ref.sourceExternalId === link.externalId))) ||
      targetLinks.some(
        (target) =>
          target.source === link.source &&
          (link.source === "ticketsports" ? target.externalId === link.externalId : target.url === link.url),
      ),
  );
  if (!strong) return "edition_link_unconfirmed";
  // A populated legacy country/location is not evidence if its source was never validated.
  const observed = refs
    .filter((ref) => ref.lastValidatedAt)
    .map((ref) => {
      const value =
        ref.observation && typeof ref.observation === "object" && !Array.isArray(ref.observation)
          ? (ref.observation as Record<string, unknown>)
          : {};
      const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
      return { date: text("date"), city: text("city"), state: text("state"), country: text("country") };
    });
  if (!observed.some((value) => editionLocationEvidence(candidate, value) === null))
    return "edition_observation_unconfirmed";
  for (const value of observed) {
    if (value.date && value.date.slice(0, 10) !== date(candidate.date)) return "edition_date_mismatch";
    for (const field of ["city", "state", "country"] as const) {
      if (normalized(value[field]) && normalized(value[field]) !== normalized(candidate[field]))
        return "edition_location_conflict";
    }
  }
  return null;
}
