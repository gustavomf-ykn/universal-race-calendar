-- Queue timestamps use TIMESTAMPTZ, including databases created before Prisma.
-- Correct the helper without changing the checksum of an applied migration.
CREATE FUNCTION task_queue_priority(task_kind TEXT, created_at TIMESTAMPTZ, moment TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE SQL IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE
  WHEN created_at <= moment - interval '15 minutes' THEN 0
  WHEN task_kind IN ('export','export-selection') THEN 0
  WHEN task_kind IN ('catalog-sync','catalog-reconcile','catalog','catalog-process','curate-batch') THEN 2
  ELSE 1
 END;
$$;
DROP FUNCTION task_queue_priority(TEXT,TIMESTAMP,TIMESTAMPTZ);
REVOKE ALL ON FUNCTION task_queue_priority(TEXT,TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION task_queue_priority(TEXT,TIMESTAMPTZ,TIMESTAMPTZ) FROM %I',r);
  END IF;
 END LOOP;
END $$;
