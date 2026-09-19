-- CreateTable
CREATE TABLE "CollectionTask" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "ownerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CollectionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceSlot" (
    "source" TEXT NOT NULL,

    CONSTRAINT "SourceSlot_pkey" PRIMARY KEY ("source")
);

-- CreateTable
CREATE TABLE "ResultSet" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "ResultSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaceDiscipline" (
    "id" TEXT NOT NULL,
    "resultSetId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "distanceKm" DOUBLE PRECISION,

    CONSTRAINT "RaceDiscipline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RaceResult" (
    "id" TEXT NOT NULL,
    "resultSetId" TEXT NOT NULL,
    "recordKey" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "gender" TEXT,
    "category" TEXT,
    "bib" TEXT,
    "name" TEXT NOT NULL,
    "team" TEXT,
    "overallPosition" INTEGER,
    "categoryPosition" INTEGER,
    "time" TEXT,
    "pace" TEXT,

    CONSTRAINT "RaceResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportArtifact" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "objectPath" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceMatch" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "city" TEXT,
    "state" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "eventId" TEXT,
    "resolvedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "limitPerHour" INTEGER NOT NULL DEFAULT 1000,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiUsage" (
    "credentialId" TEXT NOT NULL,
    "window" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("credentialId","window")
);

-- CreateIndex
CREATE INDEX "CollectionTask_source_status_availableAt_idx" ON "CollectionTask"("source", "status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionTask_ownerId_idempotencyKey_key" ON "CollectionTask"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ResultSet_eventId_idx" ON "ResultSet"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultSet_source_externalId_key" ON "ResultSet"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RaceDiscipline_resultSetId_externalId_key" ON "RaceDiscipline"("resultSetId", "externalId");

-- CreateIndex
CREATE INDEX "RaceResult_resultSetId_modality_overallPosition_id_idx" ON "RaceResult"("resultSetId", "modality", "overallPosition", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RaceResult_resultSetId_recordKey_key" ON "RaceResult"("resultSetId", "recordKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExportArtifact_taskId_key" ON "ExportArtifact"("taskId");

-- CreateIndex
CREATE INDEX "ExportArtifact_expiresAt_idx" ON "ExportArtifact"("expiresAt");

-- CreateIndex
CREATE INDEX "SourceMatch_status_idx" ON "SourceMatch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SourceMatch_source_externalId_key" ON "SourceMatch"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_keyHash_key" ON "ApiCredential"("keyHash");

-- AddForeignKey
ALTER TABLE "ResultSet" ADD CONSTRAINT "ResultSet_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaceDiscipline" ADD CONSTRAINT "RaceDiscipline_resultSetId_fkey" FOREIGN KEY ("resultSetId") REFERENCES "ResultSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RaceResult" ADD CONSTRAINT "RaceResult_resultSetId_fkey" FOREIGN KEY ("resultSetId") REFERENCES "ResultSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportArtifact" ADD CONSTRAINT "ExportArtifact_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiUsage" ADD CONSTRAINT "ApiUsage_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ApiCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "CurationJob_provider_model_contentHash_schemaVersion_curationVe" RENAME TO "CurationJob_provider_model_contentHash_schemaVersion_curati_idx";
