-- Preserve counters/checkpoint references already persisted by task heartbeats,
-- even when an executor reports resource pressure before its first work step.
CREATE OR REPLACE FUNCTION defer_local_resource_task(task_id TEXT, token TEXT, counters JSONB, reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF reason IS NULL OR counters IS NULL OR reason NOT IN ('local_memory_limit','local_disk_limit','local_resource_measurement_unavailable')
  OR jsonb_typeof(counters)<>'object' THEN RAISE EXCEPTION 'local_resource_control_invalid'; END IF;
 UPDATE "CollectionTask" SET status='queued',attempt=greatest(0,attempt-1),"availableAt"=now(),
  "executionHold"=true,"holdReason"='local_resource_wait',"errorCode"=reason,
  "leaseToken"=NULL,"leaseUntil"=NULL,"finishedAt"=NULL,"updatedAt"=now(),
  progress=progress||counters||jsonb_build_object('stage','local_resource_wait')
 WHERE id=task_id AND status='running' AND "leaseToken"=token AND "leaseUntil">now();
 RETURN FOUND;
END $$;
