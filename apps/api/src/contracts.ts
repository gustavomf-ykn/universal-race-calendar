import type { FastifyInstance } from "fastify";
const s = { type: "string" };
const ns = { type: ["string", "null"] };
const n = { type: "number" };
const nn = { type: ["number", "null"] };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties });
const arr = (items: unknown) => ({ type: "array", items });
const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: ["object", "null"] });
export const errorSchema = obj({ error: s });
export const provenanceSchema = obj({ source: s, sourceUrl: s, updatedAt: { type: "string", format: "date-time" } });
export const resultSchema = obj({
  id: s,
  modality: s,
  gender: ns,
  category: ns,
  bib: ns,
  name: s,
  team: ns,
  overallPosition: nn,
  categoryPosition: nn,
  time: ns,
  pace: ns,
  resultSet: provenanceSchema,
});
export const disciplineSchema = obj({
  id: s,
  name: s,
  distanceKm: nn,
  externalId: s,
  resultSet: obj({ source: s, updatedAt: { type: "string", format: "date-time" } }),
});
export const matchSchema = obj({
  id: s,
  source: s,
  externalId: s,
  url: s,
  name: s,
  date: ns,
  city: ns,
  state: ns,
  status: { enum: ["pending", "resolved"] },
  eventId: ns,
  resolvedBy: ns,
  updatedAt: s,
});
const distance = obj({ id: s, label: s, distanceKm: nn, modality: s, startTime: ns, elevationGain: nn, confidence: n });
const price = obj({
  id: s,
  name: ns,
  price: nn,
  currency: s,
  startDate: ns,
  endDate: ns,
  status: s,
  isCurrent: { type: "boolean" },
  confidence: n,
});
const kit = obj({ id: s, name: ns, items: arr(s), price: nn, confidence: n });
const pickup = obj({
  id: s,
  location: ns,
  address: ns,
  date: ns,
  startTime: ns,
  endTime: ns,
  requiredDocuments: arr(s),
  confidence: n,
});
const schedule = obj({ id: s, date: ns, time: ns, activity: s, location: ns, confidence: n });
const rule = obj({ id: s, category: s, text: s, confidence: n });
const display = obj({
  coverImageUrl: ns,
  locationLabel: ns,
  distances: arr(s),
  currentPrice: nn,
  currentLotName: ns,
  currency: ns,
  kitSummary: ns,
  registrationUrl: ns,
  primaryAction: nullable(obj({ type: s, label: s, url: s })),
  badges: arr(s),
});
const eventProperties = {
  id: s,
  slug: s,
  name: s,
  description: ns,
  date: ns,
  startTime: ns,
  endTime: ns,
  city: ns,
  state: ns,
  country: ns,
  locationName: ns,
  address: ns,
  latitude: nn,
  longitude: nn,
  modality: s,
  eventStatus: s,
  registrationUrl: ns,
  officialUrl: ns,
  regulationUrl: ns,
  organizerName: ns,
  organizerUrl: ns,
  mainImageUrl: ns,
  distances: arr(distance),
  distanceDetails: arr(distance),
  prices: arr(price),
  priceLots: arr(price),
  kits: arr(kit),
  kitPickup: nullable(pickup),
  schedule: arr(schedule),
  rules: arr(rule),
  images: arr(s),
  currentLot: nullable(price),
  currentPrice: nn,
  currentLotName: ns,
  currency: ns,
  lowestPrice: nn,
  display,
  sources: arr(obj({ type: s, role: s, url: ns, externalId: ns, updatedAt: ns })),
  source: nullable(obj({ id: s, type: s, url: s, adapter: ns })),
  sourceType: ns,
  confidence: n,
  lastCuratedAt: ns,
  lastUpdatedAt: s,
};
const pagination = obj({ page: n, limit: n, total: n, totalPages: n });
const eventQuery = obj({
  country: s,
  state: s,
  city: s,
  sourceType: { type: "string", description: "Comma-separated source types: ticketsports,corridasbr,openresults" },
  from: { type: "string", format: "date" },
  to: { type: "string", format: "date" },
  distanceMin: { type: "number", minimum: 0 },
  distanceMax: { type: "number", minimum: 0 },
  modality: { enum: ["road", "trail", "mixed", "kids", "walk", "unknown"] },
  status: { enum: ["scheduled", "postponed", "cancelled", "sold_out", "finished", "unknown"] },
  search: { type: "string", maxLength: 200 },
  page: { type: "integer", minimum: 1, default: 1 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  sort: { enum: ["date_asc", "date_desc", "name_asc"] },
});
export function installCalendarContracts(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    if (route.url === "/v1/events" && method === "GET")
      route.schema = {
        tags: ["Calendar"],
        summary: "List published race editions",
        querystring: eventQuery,
        response: {
          200: obj({ data: arr(obj({ ...eventProperties, distances: arr(s) })), pagination }),
          400: errorSchema,
        },
      };
    if (["/v1/events/:id", "/v1/events/slug/:slug"].includes(route.url)) {
      const field = route.url.endsWith(":slug") ? "slug" : "id";
      route.schema = {
        tags: ["Calendar"],
        summary: "Get a published edition",
        params: { ...obj({ [field]: s }), required: [field] },
        response: { 200: obj(eventProperties), 404: errorSchema },
      };
    }
    if (route.url === "/v1/events/nearby")
      route.schema = {
        tags: ["Calendar"],
        summary: "Search every geocoded candidate before distance filtering",
        querystring: {
          ...obj({
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            lat: { type: "number", minimum: -90, maximum: 90 },
            lng: { type: "number", minimum: -180, maximum: 180 },
            radiusKm: { type: "number", minimum: 0, maximum: 20000, default: 50 },
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
          }),
          required: ["lat", "lng"],
        },
        response: {
          200: obj({
            data: arr(obj({ id: s, slug: s, name: s, date: ns, city: ns, state: ns, country: ns, distanceKm: n })),
            pagination,
          }),
          400: errorSchema,
        },
      };
  });
}
