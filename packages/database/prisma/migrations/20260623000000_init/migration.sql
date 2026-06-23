CREATE TYPE "SourceKind" AS ENUM ('official_page', 'registration_page', 'organizer_page', 'aggregator');
CREATE TYPE "SourceStatus" AS ENUM ('active', 'paused', 'error');
CREATE TYPE "EventStatus" AS ENUM ('scheduled', 'postponed', 'cancelled', 'sold_out', 'finished', 'unknown');
CREATE TYPE "PublicationStatus" AS ENUM ('draft', 'pending_review', 'published', 'hidden', 'rejected');
CREATE TYPE "Modality" AS ENUM ('road', 'trail', 'mixed', 'kids', 'walk', 'unknown');
CREATE TYPE "DedupeStatus" AS ENUM ('unique', 'possible_duplicate', 'duplicate', 'needs_review');
CREATE TYPE "ExtractionJobStatus" AS ENUM ('pending', 'processing', 'success', 'validation_failed', 'provider_failed', 'manual_review');

CREATE TABLE "Source" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "type" "SourceKind" NOT NULL,
  "country" TEXT,
  "state" TEXT,
  "city" TEXT,
  "status" "SourceStatus" NOT NULL DEFAULT 'active',
  "adapter" TEXT,
  "externalId" TEXT,
  "metadata" JSONB,
  "checkIntervalMinutes" INTEGER,
  "lastHash" TEXT,
  "lastCheckedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RawSourceExtraction" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceExternalId" TEXT,
  "url" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "title" TEXT,
  "importantHtml" TEXT NOT NULL,
  "importantText" TEXT NOT NULL,
  "rawSourceData" JSONB NOT NULL,
  "extractedLinks" JSONB NOT NULL,
  "adapter" TEXT NOT NULL,
  "adapterVersion" TEXT NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RawSourceExtraction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "date" TIMESTAMP(3),
  "startTime" TEXT,
  "endTime" TEXT,
  "city" TEXT,
  "state" TEXT,
  "country" TEXT,
  "locationName" TEXT,
  "address" TEXT,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "modality" "Modality" NOT NULL DEFAULT 'unknown',
  "eventStatus" "EventStatus" NOT NULL DEFAULT 'unknown',
  "publicationStatus" "PublicationStatus" NOT NULL DEFAULT 'draft',
  "registrationUrl" TEXT,
  "officialUrl" TEXT,
  "regulationUrl" TEXT,
  "organizerName" TEXT,
  "organizerUrl" TEXT,
  "mainImageUrl" TEXT,
  "sourceId" TEXT,
  "sourceType" TEXT,
  "sourceExternalId" TEXT,
  "sourceUrl" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "canonicalFingerprint" TEXT NOT NULL,
  "dedupeStatus" "DedupeStatus" NOT NULL DEFAULT 'unique',
  "duplicateOfEventId" TEXT,
  "warnings" JSONB NOT NULL,
  "publishabilityReasons" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventDistance" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "distanceKm" DOUBLE PRECISION,
  "modality" "Modality" NOT NULL DEFAULT 'unknown',
  "startTime" TEXT,
  "elevationGain" DOUBLE PRECISION,
  "sourceText" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "EventDistance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventPrice" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "name" TEXT,
  "price" DOUBLE PRECISION,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "sourceText" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "EventPrice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventKit" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "name" TEXT,
  "items" JSONB NOT NULL,
  "price" DOUBLE PRECISION,
  "sourceText" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "EventKit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventKitPickup" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "location" TEXT,
  "address" TEXT,
  "date" TIMESTAMP(3),
  "startTime" TEXT,
  "endTime" TEXT,
  "requiredDocuments" JSONB NOT NULL,
  "sourceText" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "EventKitPickup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventSchedule" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "date" TIMESTAMP(3),
  "time" TEXT,
  "activity" TEXT NOT NULL,
  "location" TEXT,
  "sourceText" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "EventSchedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventRule" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "sourceText" TEXT,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "EventRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventImage" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "EventImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventVersion" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "curationVersion" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExtractionJob" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "eventId" TEXT,
  "provider" TEXT,
  "model" TEXT,
  "adapter" TEXT,
  "adapterVersion" TEXT,
  "schemaVersion" TEXT,
  "curationVersion" TEXT,
  "inputHash" TEXT,
  "status" "ExtractionJobStatus" NOT NULL DEFAULT 'pending',
  "rawInput" JSONB,
  "rawOutput" JSONB,
  "validatedJson" JSONB,
  "normalizedJson" JSONB,
  "confidence" DOUBLE PRECISION,
  "warnings" JSONB,
  "reasons" JSONB,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");
CREATE INDEX "RawSourceExtraction_sourceId_idx" ON "RawSourceExtraction"("sourceId");
CREATE INDEX "RawSourceExtraction_contentHash_idx" ON "RawSourceExtraction"("contentHash");
CREATE INDEX "Event_publicationStatus_idx" ON "Event"("publicationStatus");
CREATE INDEX "Event_date_idx" ON "Event"("date");
CREATE INDEX "Event_city_state_country_idx" ON "Event"("city", "state", "country");
CREATE INDEX "Event_canonicalFingerprint_idx" ON "Event"("canonicalFingerprint");
CREATE INDEX "ExtractionJob_sourceId_idx" ON "ExtractionJob"("sourceId");
CREATE INDEX "ExtractionJob_eventId_idx" ON "ExtractionJob"("eventId");
CREATE INDEX "ExtractionJob_status_idx" ON "ExtractionJob"("status");

ALTER TABLE "RawSourceExtraction" ADD CONSTRAINT "RawSourceExtraction_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EventDistance" ADD CONSTRAINT "EventDistance_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventPrice" ADD CONSTRAINT "EventPrice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventKit" ADD CONSTRAINT "EventKit_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventKitPickup" ADD CONSTRAINT "EventKitPickup_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventSchedule" ADD CONSTRAINT "EventSchedule_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventRule" ADD CONSTRAINT "EventRule_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventImage" ADD CONSTRAINT "EventImage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventVersion" ADD CONSTRAINT "EventVersion_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExtractionJob" ADD CONSTRAINT "ExtractionJob_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExtractionJob" ADD CONSTRAINT "ExtractionJob_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;
