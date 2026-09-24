CREATE TABLE "WorkerPresence" (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL CHECK (runtime IN ('typescript','python')),
  capabilities TEXT[] NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','busy','stopping','stopped')),
  "activeTaskId" TEXT,
  version TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "WorkerPresence_lastSeenAt_idx" ON "WorkerPresence"("lastSeenAt");
ALTER TABLE "WorkerPresence" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "WorkerPresence" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "WorkerPresence" FROM %I',r);
    END IF;
  END LOOP;
END $$;
