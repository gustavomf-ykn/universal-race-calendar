// Compatibility contracts. Flexible JSON fields are intentionally retained for
// provider-specific diagnostics; they are available only to administrators.
import type { FastifyInstance } from "fastify";
const text = { type: "string" },
  nullable = { type: ["string", "null"] },
  number = { type: "number" },
  boolean = { type: "boolean" };
const object = (properties: Record<string, unknown>, extra = false) => ({
  type: "object",
  properties,
  additionalProperties: extra,
});
const array = (items: unknown) => ({ type: "array", items });
const json = { description: "Provider-specific JSON diagnostic data; administrator access only" };
const fields = (names: string, schema: unknown = text) =>
  Object.fromEntries(names.split(" ").map((name) => [name, schema]));
const pagination = object(fields("page limit total totalPages", number));
const page = {
  page: { type: "integer", minimum: 1, default: 1 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
};
const error = object({ error: text });
const errors = { 400: error, 401: error, 403: error, 404: error, 409: error, 429: error, 500: error };
const task = object({
  ...fields("id source kind status createdAt updatedAt"),
  ...fields("errorCode finishedAt", nullable),
  ...fields("attempt maxAttempts", number),
  progress: object({}, true),
});
const source = object(
  {
    ...fields("id name url type createdAt updatedAt"),
    ...fields("country state city adapter externalId lastCheckedAt", nullable),
    metadata: json,
    checkIntervalMinutes: number,
  },
  true,
);
const run = object(
  {
    ...fields("id source status mode startedAt finishedAt createdAt"),
    quickFilter: nullable,
    ...fields(
      "requestedQuantity offset discoveredCount processedCount publishedEvents manualReviewEvents unchangedEvents failedCount cursor candidateLimit durationMs candidateCount",
      number,
    ),
    hasMore: boolean,
    failures: json,
    options: json,
    breakdown: array(object({ sourceType: text, action: text, status: text, _count: object({ _all: number }) })),
  },
  true,
);
const candidate = object(
  {
    ...fields("id importRunId sourceType sourceExternalId sourceUrl name status action createdAt updatedAt"),
    ...fields("date city state matchEventId errorMessage", nullable),
    matchScore: number,
    proposedEvent: json,
    displayPreview: json,
    provenance: json,
    warnings: array(text),
  },
  true,
);
const job = object(
  {
    ...fields("id status createdAt"),
    ...fields(
      "eventId sourceId rawSourceExtractionId provider model contentHash schemaVersion adapter adapterVersion curationVersion startedAt finishedAt errorMessage",
      nullable,
    ),
    confidence: number,
    durationMs: number,
    isDryRun: boolean,
    warnings: json,
    reasons: json,
    appliedChanges: json,
  },
  true,
);
const adminEvent = object(
  {
    ...fields(
      "id slug name publicationStatus eventStatus curationStatus dedupeStatus createdAt updatedAt lastUpdatedAt",
    ),
    ...fields("date city state country description sourceType sourceExternalId sourceUrl duplicateOfEventId", nullable),
    confidence: number,
    distances: array(text),
    distanceDetails: array(object({}, true)),
    prices: array(object({}, true)),
    warnings: array(text),
    publishabilityReasons: array(text),
    versions: array(object({}, true)),
    curationJobs: array(job),
    extractionJobs: array(job),
    latestRawExtraction: json,
  },
  true,
);
const listing = (item: unknown) => object({ data: array(item), pagination });
export function installLegacyContracts(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    if (route.schema || (!route.url.startsWith("/v1/") && route.url !== "/health")) return;
    if (route.url === "/v1/openapi.json") {
      route.schema = { tags: ["System"], response: { 200: object({}, true) } };
      return;
    }
    if (route.url === "/health" || route.url === "/v1/version") {
      route.schema = {
        tags: ["System"],
        response: {
          200: object(
            {
              ...fields("status backendVersion gitSha canonicalSchemaVersion curationPipelineVersion"),
              adapters: object({}, true),
            },
            true,
          ),
        },
      };
      return;
    }
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    const url = route.url;
    const isGet = method === "GET";
    const params = Object.fromEntries([...url.matchAll(/:([\w]+)/g)].map((match) => [match[1]!, text]));
    const asyncRoute =
      !isGet &&
      (url.includes("/imports/") ||
        url.endsWith("/check") ||
        url.includes("/curation/events/") ||
        url === "/v1/admin/import-runs" ||
        url.endsWith("/process"));
    const schema: any = {
      tags: ["Compatibility / administration"],
      security: [{ supabaseAuth: [] }, { internalKey: [] }],
      description: asyncRoute
        ? "Asynchronous since backend 2.0. Requires Idempotency-Key; poll /v1/tasks/{id}. Old synchronous clients must migrate."
        : "Administrative compatibility endpoint. Prefer the unified calendar, collections, tasks and results contracts for new clients.",
      response: { ...errors },
    };
    if (Object.keys(params).length) schema.params = { ...object(params), required: Object.keys(params) };
    if (asyncRoute) {
      schema.headers = {
        ...object({ "idempotency-key": { type: "string", minLength: 1, maxLength: 128 } }, true),
        required: ["idempotency-key"],
      };
      schema.response[202] = task;
      schema.body = object({
        quantity: { type: "integer", minimum: 1, maximum: 500 },
        candidateLimit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        force: boolean,
        dryRun: boolean,
        enrichOfficialPages: boolean,
        mode: { enum: ["simulate", "apply"] },
        sources: array({ enum: ["ticketsports", "corridasbr"] }),
        states: array(text),
        from: { type: "string", format: "date" },
        to: { type: "string", format: "date" },
        quickFilter: text,
        only: text,
        concurrency: { type: "integer", minimum: 1 },
        delayMs: { type: "integer", minimum: 0 },
        maxDurationMs: { type: "integer", minimum: 1 },
      });
      if (url.endsWith("/check")) delete schema.body;
    } else if (url === "/v1/sources") {
      if (isGet) schema.response[200] = object({ data: array(source) });
      else {
        schema.body = {
          ...object({
            ...fields("name url type country state city adapter externalId"),
            metadata: object({}, true),
            checkIntervalMinutes: { type: "integer", minimum: 1 },
          }),
          required: ["url", "type"],
        };
        schema.response[201] = source;
      }
    } else if (url.includes("import-runs") || url.includes("/imports/")) {
      schema.response[200] = url.endsWith("/candidates")
        ? listing(candidate)
        : params.id || url.endsWith("/latest")
          ? run
          : listing(run);
      schema.querystring = object({ ...page, ...fields("source sourceType status action state from to") });
    } else if (url.includes("jobs")) {
      schema.response[200] = params.id ? job : listing(job);
      schema.querystring = object({ ...page, ...fields("status provider model eventId from to") });
    } else if (url.startsWith("/v1/admin/events") || url === "/v1/audit/events") {
      schema.response[200] = params.id ? adminEvent : listing(adminEvent);
      if (isGet)
        schema.querystring = object({
          ...page,
          ...fields("publicationStatus eventStatus status warnings country state city sourceType search from to"),
        });
      if (method === "PATCH")
        schema.body = object({ ...fields("publicationStatus dedupeStatus status"), duplicateOfEventId: nullable });
    } else {
      schema.response[200] = object(
        {
          total: number,
          bySource: object({}, true),
          possibleDuplicates: number,
          coverage: object({}, true),
          latestImports: array(run),
        },
        true,
      );
    }
    route.schema = schema;
  });
}
