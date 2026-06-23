import { z } from "zod";

export const eventStatusSchema = z.enum(["scheduled", "postponed", "cancelled", "sold_out", "finished", "unknown"]);
export const publicationStatusSchema = z.enum(["draft", "pending_review", "published", "hidden", "rejected"]);
export const modalitySchema = z.enum(["road", "trail", "mixed", "kids", "walk", "unknown"]);
export const priceStatusSchema = z.enum(["open", "closed", "sold_out", "unknown"]);
export const sourceKindSchema = z.enum(["official_page", "registration_page", "organizer_page", "aggregator"]);
export const sourceStatusSchema = z.enum(["active", "paused", "error"]);
export const extractionJobStatusSchema = z.enum([
  "pending",
  "processing",
  "success",
  "validation_failed",
  "provider_failed",
  "manual_review",
]);
export const dedupeStatusSchema = z.enum(["unique", "possible_duplicate", "duplicate", "needs_review"]);
export const ruleCategorySchema = z.enum([
  "general",
  "age",
  "kit_pickup",
  "cancellation",
  "documents",
  "pcd",
  "awards",
  "route",
  "other",
]);

export const evidenceStringSchema = z.object({
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1).default(0),
  sourceText: z.string().nullable().default(null),
});

export const rawSourceExtractionSchema = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  sourceExternalId: z.string().nullable().default(null),
  url: z.string().url(),
  title: z.string().nullable().default(null),
  importantHtml: z.string().default(""),
  importantText: z.string().default(""),
  rawSourceData: z.record(z.unknown()).default({}),
  extractedLinks: z.array(z.string().url()).default([]),
  fetchedAt: z.string().datetime(),
  contentHash: z.string().min(16),
  adapter: z.string().min(1),
  adapterVersion: z.string().min(1),
});

export const raceDistanceExtractionSchema = z.object({
  label: z.string(),
  distanceKm: z.number().positive().nullable().default(null),
  modality: modalitySchema.default("unknown"),
  startTime: z.string().nullable().default(null),
  elevationGain: z.number().nullable().default(null),
  sourceText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export const racePriceExtractionSchema = z.object({
  name: z.string().nullable().default(null),
  price: z.number().nonnegative().nullable().default(null),
  currency: z.string().length(3).default("BRL"),
  startDate: z.string().nullable().default(null),
  endDate: z.string().nullable().default(null),
  status: priceStatusSchema.default("unknown"),
  sourceText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export const raceKitExtractionSchema = z.object({
  name: z.string().nullable().default(null),
  items: z.array(z.string()).default([]),
  price: z.number().nonnegative().nullable().default(null),
  sourceText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export const raceScheduleItemExtractionSchema = z.object({
  date: z.string().nullable().default(null),
  time: z.string().nullable().default(null),
  activity: z.string(),
  location: z.string().nullable().default(null),
  sourceText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export const raceRuleExtractionSchema = z.object({
  category: ruleCategorySchema.default("other"),
  text: z.string(),
  sourceText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export const kitPickupExtractionSchema = z.object({
  location: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  startTime: z.string().nullable().default(null),
  endTime: z.string().nullable().default(null),
  requiredDocuments: z.array(z.string()).default([]),
  sourceText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
});

export const raceEventExtractionSchema = z.object({
  name: evidenceStringSchema,
  description: evidenceStringSchema.optional(),
  date: evidenceStringSchema,
  startTime: evidenceStringSchema.optional(),
  endTime: evidenceStringSchema.optional(),
  city: evidenceStringSchema,
  state: evidenceStringSchema,
  country: evidenceStringSchema.default({ value: "BR", confidence: 0.5, sourceText: null }),
  locationName: evidenceStringSchema.optional(),
  address: evidenceStringSchema.optional(),
  latitude: z.number().nullable().default(null),
  longitude: z.number().nullable().default(null),
  modality: modalitySchema.default("unknown"),
  distances: z.array(raceDistanceExtractionSchema).default([]),
  prices: z.array(racePriceExtractionSchema).default([]),
  kits: z.array(raceKitExtractionSchema).default([]),
  schedule: z.array(raceScheduleItemExtractionSchema).default([]),
  rules: z.array(raceRuleExtractionSchema).default([]),
  kitPickup: kitPickupExtractionSchema.nullable().default(null),
  registrationUrl: evidenceStringSchema.optional(),
  officialUrl: evidenceStringSchema.optional(),
  regulationUrl: evidenceStringSchema.optional(),
  organizerName: evidenceStringSchema.optional(),
  organizerUrl: evidenceStringSchema.optional(),
  images: z.array(z.string().url()).default([]),
  eventStatus: eventStatusSchema.default("unknown"),
  confidence: z.number().min(0).max(1).default(0),
  warnings: z.array(z.string()).default([]),
});

export const canonicalRaceEventSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  date: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  locationName: z.string().nullable(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  modality: modalitySchema,
  eventStatus: eventStatusSchema,
  publicationStatus: publicationStatusSchema,
  registrationUrl: z.string().url().nullable(),
  officialUrl: z.string().url().nullable(),
  regulationUrl: z.string().url().nullable(),
  organizerName: z.string().nullable(),
  organizerUrl: z.string().url().nullable(),
  mainImageUrl: z.string().url().nullable(),
  sourceId: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceExternalId: z.string().nullable(),
  sourceUrl: z.string().url().nullable(),
  confidence: z.number().min(0).max(1),
  canonicalFingerprint: z.string(),
  dedupeStatus: dedupeStatusSchema,
  duplicateOfEventId: z.string().nullable(),
  warnings: z.array(z.string()),
  publishabilityReasons: z.array(z.string()),
  distances: z.array(raceDistanceExtractionSchema),
  prices: z.array(racePriceExtractionSchema),
  kits: z.array(raceKitExtractionSchema),
  schedule: z.array(raceScheduleItemExtractionSchema),
  rules: z.array(raceRuleExtractionSchema),
  kitPickup: kitPickupExtractionSchema.nullable(),
  images: z.array(z.string().url()),
});

export type EventStatus = z.infer<typeof eventStatusSchema>;
export type PublicationStatus = z.infer<typeof publicationStatusSchema>;
export type Modality = z.infer<typeof modalitySchema>;
export type ExtractionJobStatus = z.infer<typeof extractionJobStatusSchema>;
export type DedupeStatus = z.infer<typeof dedupeStatusSchema>;
export type RawSourceExtraction = z.infer<typeof rawSourceExtractionSchema>;
export type RaceEventExtraction = z.infer<typeof raceEventExtractionSchema>;
export type CanonicalRaceEvent = z.infer<typeof canonicalRaceEventSchema>;
