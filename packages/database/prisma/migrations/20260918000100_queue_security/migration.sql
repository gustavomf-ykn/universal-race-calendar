INSERT INTO "SourceSlot" (source) VALUES ('ticketsports'),('corridasbr'),('openresults'),('exports'),('maintenance');
ALTER TABLE "CollectionTask" ADD CONSTRAINT task_status CHECK (status IN ('queued','running','completed','partial','failed','cancelled'));
ALTER TABLE "CollectionTask" ADD CONSTRAINT task_source FOREIGN KEY (source) REFERENCES "SourceSlot"(source);
ALTER TABLE "CollectionTask" ADD CONSTRAINT task_attempts CHECK (attempt >= 0 AND "maxAttempts" BETWEEN 1 AND 10);
ALTER TABLE "ApiCredential" ADD CONSTRAINT credential_rate CHECK ("limitPerHour" BETWEEN 1 AND 100000);
ALTER TABLE "SourceMatch" ADD CONSTRAINT match_event FOREIGN KEY ("eventId") REFERENCES "Event"(id) ON DELETE RESTRICT;

-- One live task per source across ALL workers. A row lock serializes acquisition.
CREATE FUNCTION claim_task(wanted text[], token text) RETURNS SETOF "CollectionTask"
LANGUAGE plpgsql AS $$
DECLARE slot text; selected text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('race-task-acquisition'));
  FOR slot IN SELECT source FROM "SourceSlot" WHERE source = ANY(wanted) ORDER BY source FOR UPDATE SKIP LOCKED LOOP
    UPDATE "CollectionTask" SET status=CASE WHEN attempt >= "maxAttempts" THEN 'failed' ELSE 'queued' END,
      "errorCode"='lease_expired', "leaseToken"=NULL, "leaseUntil"=NULL, "updatedAt"=now(),
      "finishedAt"=CASE WHEN attempt >= "maxAttempts" THEN now() ELSE NULL END
      WHERE source=slot AND status='running' AND "leaseUntil" < now();
    IF EXISTS (SELECT 1 FROM "CollectionTask" WHERE status='running' AND
      (source=slot OR (slot IN ('ticketsports','corridasbr','maintenance') AND source IN ('ticketsports','corridasbr','maintenance')))) THEN CONTINUE; END IF;
    SELECT id INTO selected FROM "CollectionTask" WHERE source=slot AND status='queued' AND "availableAt" <= now()
      ORDER BY "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF selected IS NOT NULL THEN
      RETURN QUERY UPDATE "CollectionTask" SET status='running', attempt=attempt+1, "leaseToken"=token,
        "leaseUntil"=now()+interval '90 seconds', "updatedAt"=now() WHERE id=selected RETURNING *;
      RETURN;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION heartbeat_task(task_id text, token text, counters jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "CollectionTask" SET "leaseUntil"=now()+interval '90 seconds', "updatedAt"=now(), progress=counters
    WHERE id=task_id AND status='running' AND "leaseToken"=token AND "leaseUntil">now();
  RETURN FOUND;
END $$;

CREATE FUNCTION finish_task(task_id text, token text, outcome text, counters jsonb, failure text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF outcome NOT IN ('completed','partial','failed') THEN RAISE EXCEPTION 'invalid outcome'; END IF;
  UPDATE "CollectionTask" SET
    status=CASE WHEN outcome='failed' AND attempt < "maxAttempts" THEN 'queued' ELSE outcome END,
    "availableAt"=now()+make_interval(secs => LEAST(1800, 30 * power(2, attempt)::int)),
    "finishedAt"=CASE WHEN outcome='failed' AND attempt < "maxAttempts" THEN NULL ELSE now() END,
    "leaseToken"=NULL, "leaseUntil"=NULL, "updatedAt"=now(), progress=counters, "errorCode"=failure
    WHERE id=task_id AND status='running' AND "leaseToken"=token AND "leaseUntil">now();
  RETURN FOUND;
END $$;

-- Backend-only tables: no direct reads/writes through anon/authenticated PostgREST.
-- The backend database role must be a trusted role with BYPASSRLS (never frontend).
DO $$ DECLARE item record; role_name text;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',item.tablename);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',item.tablename,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION claim_task(text[],text), heartbeat_task(text,text,jsonb), finish_task(text,text,text,jsonb,text) FROM PUBLIC;
