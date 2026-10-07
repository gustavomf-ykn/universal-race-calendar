-- Application allocations must be confirmed by an administrator. They are not
-- provider quotas. No credentials, plan upgrades or existing data are changed.
CREATE TABLE "CatalogCapacity" (
 id INTEGER PRIMARY KEY CHECK(id=1),
 "databaseBudgetBytes" BIGINT CHECK("databaseBudgetBytes">0),
 "storageBudgetBytes" BIGINT CHECK("storageBudgetBytes">0),
 "databaseHeadroomBytes" BIGINT NOT NULL DEFAULT 16777216 CHECK("databaseHeadroomBytes">=16777216),
 "storageHeadroomBytes" BIGINT NOT NULL DEFAULT 1048576 CHECK("storageHeadroomBytes">=1048576),
 "confirmedAt" TIMESTAMPTZ,
 "databaseBytes" BIGINT, "databaseMeasuredAt" TIMESTAMPTZ,
 "storageBytes" BIGINT, "storageMeasuredAt" TIMESTAMPTZ,
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK("databaseBudgetBytes" IS NULL OR "databaseBudgetBytes">"databaseHeadroomBytes"),
 CHECK("storageBudgetBytes" IS NULL OR "storageBudgetBytes">"storageHeadroomBytes")
);
INSERT INTO "CatalogCapacity" (id) VALUES (1);
CREATE TABLE "CapacityReservation" (
 "taskId" TEXT NOT NULL REFERENCES "CollectionTask"(id) ON DELETE CASCADE,
 "leaseToken" TEXT NOT NULL,
 bytes BIGINT NOT NULL CHECK(bytes>0),
 "expiresAt" TIMESTAMPTZ NOT NULL,
 PRIMARY KEY("taskId","leaseToken")
);
ALTER TABLE "CatalogCapacity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CapacityReservation" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "CatalogCapacity","CapacityReservation" FROM PUBLIC;

-- Called inside each fenced write transaction. The singleton lock serializes
-- capacity checks/writes. Measurements are live, never a stale cached zero.
CREATE FUNCTION check_catalog_capacity(resource TEXT, growth_bytes BIGINT DEFAULT 0,
 task_id TEXT DEFAULT NULL, token TEXT DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE gate "CatalogCapacity"; db_bytes BIGINT; storage_bytes BIGINT;
 complete BOOLEAN; unknown_sizes BIGINT; reservations BIGINT;
BEGIN
 IF resource NOT IN ('database','storage') OR growth_bytes<0 OR growth_bytes IS NULL THEN
  RAISE EXCEPTION 'capacity_arguments_invalid';
 END IF;
 IF resource='storage' AND growth_bytes>0 THEN
  PERFORM id FROM "CollectionTask" WHERE id=task_id AND status='running'
   AND "leaseToken"=token AND "leaseUntil">now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lease_lost'; END IF;
 END IF;
 SELECT * INTO gate FROM "CatalogCapacity" WHERE id=1 FOR UPDATE;
 IF gate."confirmedAt" IS NULL OR gate."databaseBudgetBytes" IS NULL
  OR (resource='storage' AND gate."storageBudgetBytes" IS NULL) THEN
  RETURN 'capacity_unconfigured';
 END IF;
 BEGIN
  SELECT sum(pg_database_size(datname))::BIGINT INTO db_bytes FROM pg_database;
 EXCEPTION WHEN OTHERS THEN db_bytes:=NULL;
 END;
 UPDATE "CatalogCapacity" SET "databaseBytes"=db_bytes,
  "databaseMeasuredAt"=CASE WHEN db_bytes IS NOT NULL THEN clock_timestamp() ELSE NULL END,"updatedAt"=now() WHERE id=1;
 IF db_bytes IS NULL THEN RETURN 'capacity_measurement_unavailable'; END IF;
 IF db_bytes+gate."databaseHeadroomBytes"+(CASE WHEN resource='database' THEN growth_bytes ELSE 0 END)
  >=gate."databaseBudgetBytes" THEN RETURN 'capacity_database_limit'; END IF;
 IF resource='database' THEN RETURN 'allowed'; END IF;
 BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
   SELECT has_table_privilege(c.oid,'SELECT') AND
    (NOT c.relrowsecurity OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls)
     OR (pg_has_role(c.relowner,'USAGE') AND NOT c.relforcerowsecurity)) INTO complete
   FROM pg_class c WHERE c.oid=to_regclass('storage.objects');
   IF complete THEN
    EXECUTE 'SELECT count(*) FILTER (WHERE coalesce(metadata->>''size'','''') !~ ''^[0-9]+$''),
      coalesce(sum(CASE WHEN metadata->>''size'' ~ ''^[0-9]+$'' THEN (metadata->>''size'')::numeric ELSE 0 END),0)::bigint
      FROM storage.objects' INTO unknown_sizes,storage_bytes;
    IF unknown_sizes>0 THEN storage_bytes:=NULL; END IF;
   END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN storage_bytes:=NULL;
 END;
 UPDATE "CatalogCapacity" SET "storageBytes"=storage_bytes,
  "storageMeasuredAt"=CASE WHEN storage_bytes IS NOT NULL THEN clock_timestamp() ELSE NULL END,"updatedAt"=now() WHERE id=1;
 IF storage_bytes IS NULL THEN RETURN 'capacity_measurement_unavailable'; END IF;
 SELECT greatest(growth_bytes,coalesce((SELECT bytes FROM "CapacityReservation"
  WHERE "taskId"=task_id AND "leaseToken"=token AND "expiresAt">now()),0)) INTO growth_bytes;
 SELECT coalesce(sum(bytes),0) INTO reservations FROM "CapacityReservation"
  WHERE "expiresAt">now() AND NOT ("taskId" IS NOT DISTINCT FROM task_id AND "leaseToken" IS NOT DISTINCT FROM token);
 IF storage_bytes+reservations+growth_bytes+gate."storageHeadroomBytes">=gate."storageBudgetBytes" THEN
  RETURN 'capacity_storage_limit';
 END IF;
 IF growth_bytes>0 THEN
  INSERT INTO "CapacityReservation" ("taskId","leaseToken",bytes,"expiresAt")
   VALUES(task_id,token,growth_bytes,now()+interval '30 minutes')
   ON CONFLICT("taskId","leaseToken") DO UPDATE SET bytes=excluded.bytes,
    "expiresAt"=excluded."expiresAt";
 END IF;
 RETURN 'allowed';
END $$;

CREATE FUNCTION defer_capacity_task(task_id TEXT, token TEXT, counters JSONB, reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF reason NOT IN ('capacity_unconfigured','capacity_measurement_unavailable','capacity_database_limit','capacity_storage_limit')
  THEN RAISE EXCEPTION 'capacity_arguments_invalid'; END IF;
 UPDATE "CollectionTask" SET status='queued',attempt=greatest(0,attempt-1),
  "executionHold"=true,"holdReason"='capacity_wait',"errorCode"=reason,
  "leaseToken"=NULL,"leaseUntil"=NULL,"finishedAt"=NULL,"updatedAt"=now(),
  progress=progress||counters||jsonb_build_object('stage','capacity_wait','capacityResource',coalesce(counters->>'capacityResource','database'))
 WHERE id=task_id AND status='running' AND "leaseToken"=token AND "leaseUntil">now();
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION check_catalog_capacity(TEXT,BIGINT,TEXT,TEXT),defer_capacity_task(TEXT,TEXT,JSONB,TEXT) FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON TABLE "CatalogCapacity","CapacityReservation" FROM %I',r);
   EXECUTE format('REVOKE ALL ON FUNCTION check_catalog_capacity(TEXT,BIGINT,TEXT,TEXT),defer_capacity_task(TEXT,TEXT,JSONB,TEXT) FROM %I',r);
  END IF;
 END LOOP;
END $$;
