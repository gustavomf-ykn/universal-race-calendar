CREATE TYPE "CurationStatus" AS ENUM ('not_curated', 'curated', 'failed', 'skipped_cached', 'manual_review');

CREATE TYPE "CurationJobStatus" AS ENUM ('pending', 'processing', 'success', 'validation_failed', 'provider_failed', 'skipped_cached', 'manual_review');

ALTER TABLE "Event"
  ADD COLUMN "curationStatus" "CurationStatus" NOT NULL DEFAULT 'not_curated',
  ADD COLUMN "curatedAt" TIMESTAMP(3),
  ADD COLUMN "curationProvider" TEXT,
  ADD COLUMN "curationModel" TEXT,
  ADD COLUMN "curationVersion" TEXT;

ALTER TABLE "EventPrice"
  ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "CurationJob" (
  "id" TEXT NOT NULL,
  "eventId" TEXT,
  "rawSourceExtractionId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" "CurationJobStatus" NOT NULL DEFAULT 'pending',
  "contentHash" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "curationVersion" TEXT NOT NULL,
  "rawInput" JSONB,
  "rawOutput" JSONB,
  "validatedJson" JSONB,
  "normalizedJson" JSONB,
  "appliedChanges" JSONB,
  "warnings" JSONB,
  "confidence" DOUBLE PRECISION,
  "isDryRun" BOOLEAN NOT NULL DEFAULT false,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),

  CONSTRAINT "CurationJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CurationJob_eventId_idx" ON "CurationJob"("eventId");
CREATE INDEX "CurationJob_rawSourceExtractionId_idx" ON "CurationJob"("rawSourceExtractionId");
CREATE INDEX "CurationJob_provider_model_contentHash_schemaVersion_curationVersion_status_idx"
  ON "CurationJob"("provider", "model", "contentHash", "schemaVersion", "curationVersion", "status");
CREATE INDEX "CurationJob_status_idx" ON "CurationJob"("status");

ALTER TABLE "CurationJob"
  ADD CONSTRAINT "CurationJob_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CurationJob"
  ADD CONSTRAINT "CurationJob_rawSourceExtractionId_fkey"
  FOREIGN KEY ("rawSourceExtractionId") REFERENCES "RawSourceExtraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
