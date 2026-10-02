-- Intermediate extraction data is private and separate from published results.
CREATE TABLE "ResultCheckpoint" (
 "rootTaskId" TEXT PRIMARY KEY REFERENCES "CollectionTask"(id) ON DELETE CASCADE,
 "activeTaskId" TEXT REFERENCES "CollectionTask"(id) ON DELETE SET NULL,
 "eventId" TEXT NOT NULL REFERENCES "Event"(id) ON DELETE RESTRICT,
 "externalId" TEXT NOT NULL, "sourceUrl" TEXT NOT NULL,
 "parserVersion" INTEGER NOT NULL CHECK("parserVersion">0),
 "pageSize" INTEGER NOT NULL CHECK("pageSize">0),
 "manifestHash" TEXT NOT NULL, manifest JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','ready','invalid','published','expired')),
 "errorCode" TEXT, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT now()+interval '7 days'
);
CREATE INDEX "ResultCheckpoint_expiry" ON "ResultCheckpoint"("expiresAt");
CREATE TABLE "ResultCheckpointGroup" (
 "rootTaskId" TEXT NOT NULL REFERENCES "ResultCheckpoint"("rootTaskId") ON DELETE CASCADE,
 "modalityValue" TEXT NOT NULL, gender TEXT NOT NULL CHECK(gender IN ('F','M')),
 status TEXT NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','completed')),
 "nextOffset" INTEGER NOT NULL DEFAULT 0 CHECK("nextOffset">=0),
 "expectedTotal" INTEGER CHECK("expectedTotal">=0),
 "recordCount" INTEGER NOT NULL DEFAULT 0 CHECK("recordCount">=0),
 "pageCount" INTEGER NOT NULL DEFAULT 0 CHECK("pageCount">=0),
 PRIMARY KEY("rootTaskId","modalityValue",gender)
);
CREATE TABLE "ResultCheckpointPage" (
 "rootTaskId" TEXT NOT NULL, "modalityValue" TEXT NOT NULL, gender TEXT NOT NULL,
 "offset" INTEGER NOT NULL CHECK("offset">=0), "nextOffset" INTEGER NOT NULL,
 "hasMore" BOOLEAN NOT NULL, "expectedTotal" INTEGER, "contentHash" TEXT NOT NULL,
 "recordCount" INTEGER NOT NULL CHECK("recordCount">=0),
 PRIMARY KEY("rootTaskId","modalityValue",gender,"offset"),
 FOREIGN KEY("rootTaskId","modalityValue",gender)
  REFERENCES "ResultCheckpointGroup"("rootTaskId","modalityValue",gender) ON DELETE CASCADE
);
CREATE TABLE "ResultCheckpointRow" (
 "rootTaskId" TEXT NOT NULL, "recordKey" TEXT NOT NULL, "dedupeKey" TEXT NOT NULL,
 "modalityValue" TEXT NOT NULL, gender TEXT NOT NULL, record JSONB NOT NULL,
 PRIMARY KEY("rootTaskId","recordKey"), UNIQUE("rootTaskId","dedupeKey"),
 FOREIGN KEY("rootTaskId","modalityValue",gender)
  REFERENCES "ResultCheckpointGroup"("rootTaskId","modalityValue",gender) ON DELETE CASCADE
);
-- A retained root task may have a failed status while a retry uses its checkpoint.
-- Protect active/unexpired work from operational history cleanup, including roots.
CREATE FUNCTION protect_result_checkpoint_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT FROM "ResultCheckpoint" c
  LEFT JOIN "CollectionTask" t ON t.id=c."activeTaskId"
  WHERE c."rootTaskId"=OLD.id AND
   (t.status IN ('queued','running') OR (c.status IN ('collecting','ready') AND c."expiresAt">now()))) THEN
  RETURN NULL;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER result_checkpoint_history BEFORE DELETE ON "CollectionTask"
 FOR EACH ROW EXECUTE FUNCTION protect_result_checkpoint_history();
REVOKE ALL ON FUNCTION protect_result_checkpoint_history() FROM PUBLIC;
DO $$ DECLARE tbl TEXT; r TEXT; BEGIN
 FOREACH tbl IN ARRAY ARRAY['ResultCheckpoint','ResultCheckpointGroup','ResultCheckpointPage','ResultCheckpointRow'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',tbl);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
    EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',tbl,r);
   END IF;
  END LOOP;
 END LOOP;
END $$;
