ALTER TABLE "WorkerPresence" ADD COLUMN resources JSONB;
ALTER TABLE "WorkerPresence" DROP CONSTRAINT "WorkerPresence_state_check";
ALTER TABLE "WorkerPresence" ADD CONSTRAINT "WorkerPresence_state_check"
 CHECK(state IN ('available','busy','resource_wait','stopping','stopped'));

CREATE FUNCTION defer_local_resource_task(task_id TEXT, token TEXT, counters JSONB, reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF reason IS NULL OR counters IS NULL OR reason NOT IN ('local_memory_limit','local_disk_limit','local_resource_measurement_unavailable')
  OR jsonb_typeof(counters)<>'object' THEN RAISE EXCEPTION 'local_resource_control_invalid'; END IF;
 UPDATE "CollectionTask" SET status='queued',attempt=greatest(0,attempt-1),"availableAt"=now(),
  "executionHold"=true,"holdReason"='local_resource_wait',"errorCode"=reason,
  "leaseToken"=NULL,"leaseUntil"=NULL,"finishedAt"=NULL,"updatedAt"=now(),
  progress=counters||jsonb_build_object('stage','local_resource_wait')
 WHERE id=task_id AND status='running' AND "leaseToken"=token AND "leaseUntil">now();
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION defer_local_resource_task(TEXT,TEXT,JSONB,TEXT) FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION defer_local_resource_task(TEXT,TEXT,JSONB,TEXT) FROM %I',r);
  END IF;
 END LOOP;
END $$;
