-- Derive priority on the trusted database side; payloads cannot choose it.
-- Aging prevents a continuing stream of new requests from indefinitely passing
-- an older task. This is selection priority, not preemption or a latency SLA.
CREATE FUNCTION task_queue_priority(task_kind TEXT, created_at TIMESTAMP, moment TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE SQL IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE
  WHEN created_at <= (moment AT TIME ZONE 'UTC') - interval '15 minutes' THEN 0
  WHEN task_kind IN ('export','export-selection') THEN 0
  WHEN task_kind IN ('catalog-sync','catalog-reconcile','catalog','catalog-process','curate-batch') THEN 2
  ELSE 1
 END;
$$;

-- Compare all eligible sources, rather than returning the first alphabetic slot.
-- Keep the existing source/circuit/hold/selection and expired-lease protections.
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

REVOKE ALL ON FUNCTION task_queue_priority(TEXT,TIMESTAMP,TIMESTAMPTZ),claim_selected_task(TEXT[],TEXT,TEXT[]) FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION task_queue_priority(TEXT,TIMESTAMP,TIMESTAMPTZ),claim_selected_task(TEXT[],TEXT,TEXT[]) FROM %I',r);
  END IF;
 END LOOP;
END $$;
