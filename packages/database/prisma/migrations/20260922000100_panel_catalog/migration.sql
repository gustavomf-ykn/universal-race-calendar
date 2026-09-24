CREATE TABLE "CatalogSync" (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, "ownerId" TEXT NOT NULL,
 options JSONB NOT NULL, snapshot JSONB NOT NULL DEFAULT '[]', cursor INTEGER NOT NULL DEFAULT 0,
 page INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ready',
 coverage TEXT NOT NULL DEFAULT 'not_started', discovered INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE "AdminAudit" (
 id TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, action TEXT NOT NULL,
 "eventId" TEXT, "taskId" TEXT, details JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "AdminAudit_eventId_createdAt_idx" ON "AdminAudit"("eventId","createdAt");
ALTER TABLE "ExportArtifact" ALTER COLUMN "eventId" DROP NOT NULL;
ALTER TABLE "ExportArtifact" ADD COLUMN kind TEXT NOT NULL DEFAULT 'results';
ALTER TABLE "ExportArtifact" ADD COLUMN selection JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ExportArtifact" ADD COLUMN "contentType" TEXT;
ALTER TABLE "RaceResult" ADD COLUMN "distanceKm" DOUBLE PRECISION;
ALTER TABLE "RaceResult" ADD COLUMN gap TEXT;
ALTER TABLE "CatalogSync" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminAudit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "CatalogSync","AdminAudit" FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON TABLE "CatalogSync","AdminAudit" FROM %I',r);
  END IF;
 END LOOP;
END $$;
