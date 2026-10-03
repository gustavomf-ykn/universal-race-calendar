-- Durable catalog scan; Event IDs in receipts survive reconciliation as aliases.
CREATE TABLE "CatalogReconciliation" (
 id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "rootTaskId" TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'ready', "parserVersion" INTEGER NOT NULL DEFAULT 1,
 "snapshotAt" TIMESTAMP(3) NOT NULL, "cursorCreatedAt" TIMESTAMP(3), "cursorEventId" TEXT,
 sequence INTEGER NOT NULL DEFAULT 0, "activeTaskId" TEXT,
 "pauseRequested" BOOLEAN NOT NULL DEFAULT false, "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 "scannedCount" INTEGER NOT NULL DEFAULT 0, "mergedCount" INTEGER NOT NULL DEFAULT 0,
 "reviewCount" INTEGER NOT NULL DEFAULT 0, "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
 "foreignCount" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 "finishedAt" TIMESTAMPTZ(3),
 CHECK(status IN ('ready','waiting','paused','blocked','completed','completed_with_review')),
 CHECK("parserVersion">0 AND sequence>=0 AND "scannedCount">=0 AND "mergedCount">=0 AND "reviewCount">=0 AND "unmatchedCount">=0 AND "foreignCount">=0),
 CHECK(("cursorCreatedAt" IS NULL)=("cursorEventId" IS NULL))
);
CREATE INDEX "CatalogReconciliation_status_nextAttemptAt_idx" ON "CatalogReconciliation"(status,"nextAttemptAt");
CREATE INDEX "Event_createdAt_id_idx" ON "Event"("createdAt",id);
CREATE TABLE "CatalogReconciliationDecision" (
 id TEXT PRIMARY KEY, "runId" TEXT NOT NULL REFERENCES "CatalogReconciliation"(id) ON DELETE RESTRICT,
 "eventId" TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, details JSONB NOT NULL DEFAULT '{}',
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 UNIQUE("runId","eventId"), CHECK(status IN ('merged','review','unmatched','foreign','waiting'))
);
CREATE INDEX "CatalogReconciliationDecision_runId_status_createdAt_idx" ON "CatalogReconciliationDecision"("runId",status,"createdAt");
ALTER TABLE "CatalogReconciliation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogReconciliationDecision" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CatalogReconciliation","CatalogReconciliationDecision" FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON TABLE "CatalogReconciliation","CatalogReconciliationDecision" FROM %I',r);
  END IF;
 END LOOP;
END $$;
