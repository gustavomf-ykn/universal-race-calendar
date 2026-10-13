-- No campaigns, tasks, schedules or requests are created by this migration.
CREATE TABLE "CatalogCampaign" (
 id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "coordinatorVersion" INTEGER NOT NULL DEFAULT 1 CHECK("coordinatorVersion">0),
 status TEXT NOT NULL DEFAULT 'discovery' CHECK(status IN ('discovery','enrichment','reconciliation','blocked','paused','completed','completed_with_review','partial','cancelled')),
 "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
 options JSONB NOT NULL CHECK(jsonb_typeof(options)='object'),
 "sourceSyncs" JSONB NOT NULL CHECK(jsonb_typeof("sourceSyncs")='object'),
 "reconciliationId" TEXT, summary JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(summary)='object'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 "finishedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "CatalogCampaign_createdAt_idx" ON "CatalogCampaign"("createdAt");
CREATE UNIQUE INDEX "CatalogCampaign_one_active" ON "CatalogCampaign"((true))
 WHERE status NOT IN ('completed','completed_with_review','partial','cancelled');
ALTER TABLE "CatalogCampaign" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "CatalogCampaign" FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON TABLE "CatalogCampaign" FROM %I',r);
  END IF;
 END LOOP;
END $$;

-- Serialize a newly generated enrichment step with campaign pause/cancel.
CREATE FUNCTION guard_campaign_task() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE campaign "CatalogCampaign";
BEGIN
 IF NEW.payload->>'syncId' IS NULL AND NEW.payload->>'runId' IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('race-task-acquisition'));
 SELECT * INTO campaign FROM "CatalogCampaign"
 WHERE ("sourceSyncs"->>NEW.source=NEW.payload->>'syncId')
    OR ("reconciliationId" IS NOT NULL AND "reconciliationId"=NEW.payload->>'runId');
 IF FOUND THEN
  IF campaign.status='cancelled' THEN RAISE EXCEPTION 'campaign_cancelled'; END IF;
  IF campaign."pauseRequested" AND NEW.status='queued' AND NOT NEW."executionHold" THEN
   NEW."executionHold":=true; NEW."holdReason":='catalog_campaign_paused';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_task_insert BEFORE INSERT ON "CollectionTask" FOR EACH ROW EXECUTE FUNCTION guard_campaign_task();
REVOKE ALL ON FUNCTION guard_campaign_task() FROM PUBLIC;

ALTER TABLE "CatalogSync" ADD COLUMN "createdCount" INTEGER NOT NULL DEFAULT 0 CHECK("createdCount">=0),
 ADD COLUMN "existingCount" INTEGER NOT NULL DEFAULT 0 CHECK("existingCount">=0),
 ADD COLUMN "countsAvailable" BOOLEAN NOT NULL DEFAULT false;
-- Old receipts do not prove these new counters; no backfill is inferred.
