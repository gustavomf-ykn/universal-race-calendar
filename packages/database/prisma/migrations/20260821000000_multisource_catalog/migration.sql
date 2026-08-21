ALTER TABLE "ImportRun"
ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'apply',
ADD COLUMN "cursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "candidateLimit" INTEGER,
ADD COLUMN "options" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "ImportCandidate" (
  "id" TEXT NOT NULL,
  "importRunId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceExternalId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "date" TIMESTAMP(3),
  "city" TEXT,
  "state" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "action" TEXT NOT NULL DEFAULT 'create',
  "matchEventId" TEXT,
  "matchScore" DOUBLE PRECISION,
  "proposedEvent" JSONB,
  "displayPreview" JSONB,
  "provenance" JSONB NOT NULL DEFAULT '{}',
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImportCandidate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EventSourceReference" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceExternalId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'supplemental',
  "priority" INTEGER NOT NULL DEFAULT 50,
  "contentHash" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventSourceReference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportCandidate_importRunId_sourceType_sourceExternalId_key"
ON "ImportCandidate"("importRunId", "sourceType", "sourceExternalId");
CREATE INDEX "ImportCandidate_importRunId_status_idx" ON "ImportCandidate"("importRunId", "status");
CREATE INDEX "ImportCandidate_sourceType_sourceExternalId_idx" ON "ImportCandidate"("sourceType", "sourceExternalId");

CREATE UNIQUE INDEX "EventSourceReference_sourceType_sourceExternalId_key"
ON "EventSourceReference"("sourceType", "sourceExternalId");
CREATE UNIQUE INDEX "EventSourceReference_eventId_sourceId_key"
ON "EventSourceReference"("eventId", "sourceId");
CREATE INDEX "EventSourceReference_eventId_priority_idx" ON "EventSourceReference"("eventId", "priority");

ALTER TABLE "ImportCandidate"
ADD CONSTRAINT "ImportCandidate_importRunId_fkey"
FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventSourceReference"
ADD CONSTRAINT "EventSourceReference_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventSourceReference"
ADD CONSTRAINT "EventSourceReference_sourceId_fkey"
FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "EventSourceReference" (
  "id", "eventId", "sourceId", "sourceType", "sourceExternalId", "url", "role", "priority", "contentHash", "lastSeenAt", "createdAt", "updatedAt"
)
SELECT
  CONCAT('ref_', SUBSTRING(MD5(random()::text || e."id"), 1, 24)),
  e."id",
  e."sourceId",
  e."sourceType",
  e."sourceExternalId",
  COALESCE(e."sourceUrl", s."url"),
  'primary',
  CASE WHEN e."sourceType" = 'ticketsports' THEN 100 WHEN e."sourceType" = 'official' THEN 80 ELSE 50 END,
  s."lastHash",
  e."updatedAt",
  e."createdAt",
  CURRENT_TIMESTAMP
FROM "Event" e
JOIN "Source" s ON s."id" = e."sourceId"
WHERE e."sourceId" IS NOT NULL
  AND e."sourceType" IS NOT NULL
  AND e."sourceExternalId" IS NOT NULL
ON CONFLICT ("sourceType", "sourceExternalId") DO NOTHING;
