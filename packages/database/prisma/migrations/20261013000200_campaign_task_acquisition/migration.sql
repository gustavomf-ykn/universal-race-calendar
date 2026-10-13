-- Fence pause/cancel at acquisition, including inserts racing a pause.
-- INSERT must not acquire the queue gate while holding task/capacity/checkpoint locks.
CREATE FUNCTION catalog_campaign_task_blocked(task_source TEXT, task_payload JSONB)
RETURNS BOOLEAN LANGUAGE SQL STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT FROM "CatalogCampaign" c
  WHERE (c."pauseRequested" OR c.status='cancelled') AND
   (c."sourceSyncs"->>task_source=task_payload->>'syncId'
     OR (c."reconciliationId" IS NOT NULL AND c."reconciliationId"=task_payload->>'runId')));
$$;
CREATE OR REPLACE FUNCTION guard_campaign_task() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE campaign "CatalogCampaign";
BEGIN
 IF NEW.payload->>'syncId' IS NULL AND NEW.payload->>'runId' IS NULL THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION claim_selected_task(wanted TEXT[], token TEXT, allowed_ids TEXT[])
RETURNS SETOF "CollectionTask" LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE slot TEXT; selected TEXT; locked_sources TEXT[] := ARRAY[]::TEXT[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('race-task-acquisition'));
 FOR slot IN SELECT source FROM "SourceSlot" WHERE source=ANY(wanted) ORDER BY source FOR UPDATE SKIP LOCKED LOOP
  locked_sources := array_append(locked_sources,slot);
  UPDATE "CollectionTask" SET status=CASE WHEN attempt>="maxAttempts" THEN 'failed' ELSE 'queued' END,
   "errorCode"='lease_expired',"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now(),
   "finishedAt"=CASE WHEN attempt>="maxAttempts" THEN now() ELSE NULL END
  WHERE source=slot AND status='running' AND "leaseUntil"<now()
   AND NOT "executionHold" AND (allowed_ids IS NULL OR id=ANY(allowed_ids));
 END LOOP;
 SELECT t.id INTO selected FROM "CollectionTask" t
 WHERE t.source=ANY(locked_sources) AND t.status='queued' AND t."availableAt"<=now()
  AND NOT t."executionHold" AND (allowed_ids IS NULL OR t.id=ANY(allowed_ids))
  AND NOT catalog_campaign_task_blocked(t.source,t.payload)
  AND NOT EXISTS(SELECT FROM "SourceRequestControl" g WHERE g.source=t.source AND g."blockedAt" IS NOT NULL)
  AND NOT EXISTS(SELECT FROM "CollectionTask" active WHERE active.status='running' AND
    (active.source=t.source OR (t.source IN ('ticketsports','corridasbr','maintenance')
      AND active.source IN ('ticketsports','corridasbr','maintenance'))))
 ORDER BY task_queue_priority(t.kind,t."createdAt",now()),t."createdAt",t.id
 LIMIT 1 FOR UPDATE OF t SKIP LOCKED;
 IF selected IS NOT NULL THEN
  RETURN QUERY UPDATE "CollectionTask" SET status='running',attempt=attempt+1,"leaseToken"=token,
   "leaseUntil"=now()+interval '90 seconds',"updatedAt"=now() WHERE id=selected RETURNING *;
 END IF;
END $$;
REVOKE ALL ON FUNCTION catalog_campaign_task_blocked(TEXT,JSONB),guard_campaign_task(),claim_selected_task(TEXT[],TEXT,TEXT[]) FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION catalog_campaign_task_blocked(TEXT,JSONB),guard_campaign_task(),claim_selected_task(TEXT[],TEXT,TEXT[]) FROM %I',r);
  END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION catalog_campaign_task_blocked(TEXT,JSONB) TO service_role;
 END IF;
END $$;
