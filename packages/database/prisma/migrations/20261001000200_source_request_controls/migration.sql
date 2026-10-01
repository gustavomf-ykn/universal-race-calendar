CREATE TABLE "SourceRequestControl" (
 source TEXT PRIMARY KEY CHECK(source IN ('ticketsports','corridasbr','openresults')),
 "windowStart" TIMESTAMPTZ NOT NULL DEFAULT now(), "requestCount" INTEGER NOT NULL DEFAULT 0 CHECK("requestCount">=0),
 "limitPerHour" INTEGER NOT NULL DEFAULT 100 CHECK("limitPerHour" BETWEEN 1 AND 100),
 "minDelayMs" INTEGER NOT NULL DEFAULT 1000 CHECK("minDelayMs" BETWEEN 1000 AND 60000),
 "nextAllowedAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "blockedAt" TIMESTAMPTZ, "blockedUntil" TIMESTAMPTZ,
 "blockReason" TEXT, "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE "SourceRequestControl" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "SourceRequestControl" FROM PUBLIC;

-- Reserve each actual outgoing HTTP attempt, including redirects and browser transport.
CREATE FUNCTION reserve_source_request(source_key TEXT)
RETURNS TABLE(decision TEXT, "retryAt" TIMESTAMPTZ) LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE gate "SourceRequestControl"; moment TIMESTAMPTZ; hour_start TIMESTAMPTZ;
BEGIN
 INSERT INTO "SourceRequestControl" (source,"windowStart") VALUES (source_key,date_trunc('hour',clock_timestamp())) ON CONFLICT DO NOTHING;
 SELECT * INTO gate FROM "SourceRequestControl" WHERE source=source_key FOR UPDATE;
 moment:=clock_timestamp(); hour_start:=date_trunc('hour',moment);
 IF gate."blockedAt" IS NOT NULL THEN RETURN QUERY SELECT 'blocked'::TEXT,gate."blockedUntil"; RETURN; END IF;
 IF gate."windowStart"<hour_start THEN
  UPDATE "SourceRequestControl" SET "windowStart"=hour_start,"requestCount"=0,"updatedAt"=moment WHERE source=source_key;
  gate."windowStart":=hour_start; gate."requestCount":=0;
 END IF;
 IF gate."requestCount">=gate."limitPerHour" THEN
  RETURN QUERY SELECT 'budget'::TEXT,gate."windowStart"+interval '1 hour'; RETURN;
 END IF;
 IF gate."nextAllowedAt">moment THEN RETURN QUERY SELECT 'spacing'::TEXT,gate."nextAllowedAt"; RETURN; END IF;
 UPDATE "SourceRequestControl" SET "requestCount"="requestCount"+1,
  "nextAllowedAt"=moment+make_interval(secs=>gate."minDelayMs"/1000.0),"updatedAt"=moment WHERE source=source_key;
 RETURN QUERY SELECT 'allowed'::TEXT,NULL::TIMESTAMPTZ;
END $$;

CREATE FUNCTION defer_source_task(task_id TEXT, token TEXT, counters JSONB, retry_at TIMESTAMPTZ, blocked BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE "CollectionTask" SET status='queued',attempt=greatest(0,attempt-1),"availableAt"=coalesce(retry_at,now()),
  "executionHold"=blocked,"holdReason"=CASE WHEN blocked THEN 'source_access_blocked' ELSE NULL END,
  "errorCode"=CASE WHEN blocked THEN 'source_access_blocked' ELSE 'source_budget_wait' END,
  "leaseToken"=NULL,"leaseUntil"=NULL,"finishedAt"=NULL,"updatedAt"=now(),progress=counters
 WHERE id=task_id AND status='running' AND "leaseToken"=token AND "leaseUntil">now();
 RETURN FOUND;
END $$;

-- Close the gate and protect existing queued requests without releasing preexisting holds.
CREATE FUNCTION block_source_requests(source_key TEXT, retry_at TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('race-task-acquisition'));
 INSERT INTO "SourceRequestControl" (source,"windowStart","blockedAt","blockedUntil","blockReason")
 VALUES (source_key,date_trunc('hour',now()),now(),retry_at,'source_access_blocked')
 ON CONFLICT(source) DO UPDATE SET "blockedAt"=coalesce("SourceRequestControl"."blockedAt",now()),
  "blockedUntil"=CASE WHEN "SourceRequestControl"."blockedUntil" IS NULL AND "SourceRequestControl"."blockedAt" IS NOT NULL THEN NULL
    ELSE greatest("SourceRequestControl"."blockedUntil",excluded."blockedUntil") END,
  "blockReason"='source_access_blocked',"updatedAt"=now();
 UPDATE "CollectionTask" SET "executionHold"=true,"holdReason"='source_access_blocked',"errorCode"='source_access_blocked',"updatedAt"=now()
 WHERE source=source_key AND status='queued' AND NOT "executionHold";
END $$;

-- Acquisition observes the durable gate even for tasks created after a block.
CREATE OR REPLACE FUNCTION claim_selected_task(wanted TEXT[], token TEXT, allowed_ids TEXT[])
RETURNS SETOF "CollectionTask" LANGUAGE plpgsql AS $$
DECLARE slot TEXT; selected TEXT;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('race-task-acquisition'));
 FOR slot IN SELECT source FROM "SourceSlot" WHERE source=ANY(wanted) ORDER BY source FOR UPDATE SKIP LOCKED LOOP
  UPDATE "CollectionTask" SET status=CASE WHEN attempt>="maxAttempts" THEN 'failed' ELSE 'queued' END,
   "errorCode"='lease_expired',"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=now(),
   "finishedAt"=CASE WHEN attempt>="maxAttempts" THEN now() ELSE NULL END
  WHERE source=slot AND status='running' AND "leaseUntil"<now()
   AND NOT "executionHold" AND (allowed_ids IS NULL OR id=ANY(allowed_ids));
  IF EXISTS(SELECT FROM "SourceRequestControl" WHERE source=slot AND "blockedAt" IS NOT NULL) THEN CONTINUE; END IF;
  IF EXISTS(SELECT FROM "CollectionTask" WHERE status='running' AND
   (source=slot OR (slot IN ('ticketsports','corridasbr','maintenance') AND source IN ('ticketsports','corridasbr','maintenance')))) THEN CONTINUE; END IF;
  SELECT id INTO selected FROM "CollectionTask" WHERE source=slot AND status='queued' AND "availableAt"<=now()
   AND NOT "executionHold" AND (allowed_ids IS NULL OR id=ANY(allowed_ids)) ORDER BY "createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF selected IS NOT NULL THEN
   RETURN QUERY UPDATE "CollectionTask" SET status='running',attempt=attempt+1,"leaseToken"=token,
    "leaseUntil"=now()+interval '90 seconds',"updatedAt"=now() WHERE id=selected RETURNING *; RETURN;
  END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION reserve_source_request(TEXT),defer_source_task(TEXT,TEXT,JSONB,TIMESTAMPTZ,BOOLEAN),block_source_requests(TEXT,TIMESTAMPTZ) FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON TABLE "SourceRequestControl" FROM %I',r);
   EXECUTE format('REVOKE ALL ON FUNCTION reserve_source_request(TEXT),defer_source_task(TEXT,TEXT,JSONB,TIMESTAMPTZ,BOOLEAN),block_source_requests(TEXT,TIMESTAMPTZ) FROM %I',r);
  END IF;
 END LOOP;
END $$;
