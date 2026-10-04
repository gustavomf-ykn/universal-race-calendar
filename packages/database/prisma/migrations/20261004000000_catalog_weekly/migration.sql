-- Disabled by default. No tasks, source requests or schedule activation.
CREATE TABLE "CatalogWeeklySchedule" (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled BOOLEAN NOT NULL DEFAULT false,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 "coordinatorVersion" INTEGER NOT NULL DEFAULT 1 CHECK("coordinatorVersion">0),
 "ownerId" TEXT NOT NULL DEFAULT '', weekday INTEGER NOT NULL DEFAULT 1 CHECK(weekday BETWEEN 1 AND 7),
 hour INTEGER NOT NULL DEFAULT 8 CHECK(hour BETWEEN 0 AND 23),
 minute INTEGER NOT NULL DEFAULT 0 CHECK(minute BETWEEN 0 AND 59),
 options JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(options)='object'),
 "nextLocalDate" TEXT, "nextScheduledAt" TIMESTAMPTZ(3), "lastSuccessAt" TIMESTAMPTZ(3),
 "waitReason" TEXT CHECK("waitReason" IS NULL OR "waitReason" ~ '^[a-z_]{1,80}$'),
 "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
 CHECK(("nextLocalDate" IS NULL)=("nextScheduledAt" IS NULL)),
 CHECK(NOT enabled OR ("ownerId"<>'' AND "nextLocalDate" IS NOT NULL))
);
INSERT INTO "CatalogWeeklySchedule"(id) VALUES(1);

CREATE TABLE "CatalogWeeklyOccurrence" (
 id TEXT PRIMARY KEY, "scheduleId" INTEGER NOT NULL DEFAULT 1 REFERENCES "CatalogWeeklySchedule"(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL CHECK(revision>0), "coordinatorVersion" INTEGER NOT NULL DEFAULT 1 CHECK("coordinatorVersion">0),
 "ownerId" TEXT NOT NULL, "localDate" TEXT NOT NULL, "firstDueLocalDate" TEXT NOT NULL,
 "scheduledAt" TIMESTAMPTZ(3) NOT NULL, "coalescedWeeks" INTEGER NOT NULL DEFAULT 0 CHECK("coalescedWeeks">=0),
 "shiftedMinutes" INTEGER NOT NULL DEFAULT 0 CHECK("shiftedMinutes" BETWEEN 0 AND 180),
 status TEXT NOT NULL DEFAULT 'discovery' CHECK(status IN ('discovery','enrichment','reconciliation','blocked','completed','completed_with_review','partial','cancelled')),
 options JSONB NOT NULL CHECK(jsonb_typeof(options)='object'),
 "sourceSyncs" JSONB NOT NULL CHECK(jsonb_typeof("sourceSyncs")='object'),
 "reconciliationId" TEXT, summary JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(summary)='object'),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), "finishedAt" TIMESTAMPTZ(3),
 UNIQUE("scheduleId",revision,"localDate")
);
CREATE INDEX "CatalogWeeklyOccurrence_scheduleId_createdAt_idx" ON "CatalogWeeklyOccurrence"("scheduleId","createdAt");
CREATE UNIQUE INDEX "CatalogWeeklyOccurrence_one_active" ON "CatalogWeeklyOccurrence"("scheduleId")
 WHERE status NOT IN ('completed','completed_with_review','partial','cancelled');
ALTER TABLE "CatalogWeeklySchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogWeeklyOccurrence" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "CatalogWeeklySchedule","CatalogWeeklyOccurrence" FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON "CatalogWeeklySchedule","CatalogWeeklyOccurrence" FROM %I',r);
  END IF;
 END LOOP;
END $$;
