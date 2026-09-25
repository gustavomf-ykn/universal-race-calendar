-- Reversible hold preserves task status/history and protects against every consumer.
ALTER TABLE "CollectionTask" ADD COLUMN "executionHold" boolean NOT NULL DEFAULT false;
ALTER TABLE "CollectionTask" ADD COLUMN "holdReason" text;
CREATE FUNCTION claim_selected_task(wanted text[], token text, allowed_ids text[]) RETURNS SETOF "CollectionTask"
LANGUAGE plpgsql AS $$
DECLARE slot text; selected text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('race-task-acquisition'));
  FOR slot IN SELECT source FROM "SourceSlot" WHERE source = ANY(wanted) ORDER BY source FOR UPDATE SKIP LOCKED LOOP
    UPDATE "CollectionTask" SET status=CASE WHEN attempt >= "maxAttempts" THEN 'failed' ELSE 'queued' END,
      "errorCode"='lease_expired', "leaseToken"=NULL, "leaseUntil"=NULL, "updatedAt"=now(),
      "finishedAt"=CASE WHEN attempt >= "maxAttempts" THEN now() ELSE NULL END
      WHERE source=slot AND status='running' AND "leaseUntil" < now()
        AND NOT "executionHold" AND (allowed_ids IS NULL OR id=ANY(allowed_ids));
    IF EXISTS (SELECT 1 FROM "CollectionTask" WHERE status='running' AND
      (source=slot OR (slot IN ('ticketsports','corridasbr','maintenance') AND source IN ('ticketsports','corridasbr','maintenance')))) THEN CONTINUE; END IF;
    SELECT id INTO selected FROM "CollectionTask" WHERE source=slot AND status='queued' AND "availableAt" <= now()
      AND NOT "executionHold" AND (allowed_ids IS NULL OR id=ANY(allowed_ids))
      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF selected IS NOT NULL THEN
      RETURN QUERY UPDATE "CollectionTask" SET status='running', attempt=attempt+1, "leaseToken"=token,
        "leaseUntil"=now()+interval '90 seconds', "updatedAt"=now() WHERE id=selected RETURNING *;
      RETURN;
    END IF;
  END LOOP;
END $$;


CREATE OR REPLACE FUNCTION claim_task(wanted text[], token text) RETURNS SETOF "CollectionTask"
LANGUAGE sql AS $$ SELECT * FROM claim_selected_task(wanted,token,NULL::text[]); $$;
REVOKE ALL ON FUNCTION claim_selected_task(text[],text,text[]) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION claim_selected_task(text[],text,text[]) FROM %I',r);
  END IF;
 END LOOP;
END $$;
