-- Durable history must not turn campaign/cycle observation into quadratic scans.
CREATE INDEX "CollectionTask_sync_scope_idx" ON "CollectionTask"((payload->>'syncId'));
CREATE INDEX "CollectionTask_retry_parent_idx" ON "CollectionTask"((payload->>'retryOf'));
CREATE INDEX "CollectionTask_reconciliation_scope_idx" ON "CollectionTask"((payload->>'runId'));
