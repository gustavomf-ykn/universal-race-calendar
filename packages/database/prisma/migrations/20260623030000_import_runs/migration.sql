CREATE TABLE "ImportRun" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "quickFilter" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "requestedQuantity" INTEGER NOT NULL,
  "offset" INTEGER NOT NULL DEFAULT 0,
  "discoveredCount" INTEGER NOT NULL,
  "processedCount" INTEGER NOT NULL,
  "publishedEvents" INTEGER NOT NULL,
  "manualReviewEvents" INTEGER NOT NULL,
  "unchangedEvents" INTEGER NOT NULL,
  "failedCount" INTEGER NOT NULL,
  "failures" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImportRun_source_createdAt_idx" ON "ImportRun"("source", "createdAt");
