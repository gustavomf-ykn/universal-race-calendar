-- Old identifiers/slugs remain reserved and resolve directly to the canonical edition.
CREATE TABLE "EventAlias" (
 id TEXT PRIMARY KEY, "oldSlug" TEXT NOT NULL UNIQUE, "canonicalEventId" TEXT NOT NULL,
 snapshot JSONB NOT NULL, "createdBy" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
 CONSTRAINT "EventAlias_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "Event"(id) ON DELETE RESTRICT,
 CONSTRAINT "EventAlias_not_self" CHECK (id <> "canonicalEventId")
);
CREATE INDEX "EventAlias_canonicalEventId_idx" ON "EventAlias"("canonicalEventId");
ALTER TABLE "EventAlias" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "EventAlias" FROM PUBLIC;

CREATE FUNCTION resolve_event_id(requested TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT "canonicalEventId" FROM "EventAlias" WHERE id=requested),requested)
$$;

-- Serialize identity reservation with reconciliation before touching an Event row.
CREATE FUNCTION protect_event_alias_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.slug IS DISTINCT FROM OLD.slug THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('event_id:'||NEW.id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('event_slug:'||NEW.slug,0));
  IF EXISTS(SELECT FROM "EventAlias" WHERE id=NEW.id OR "oldSlug"=NEW.slug) THEN
   RAISE EXCEPTION 'event_alias_identity_reserved';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER event_alias_identity BEFORE INSERT OR UPDATE OF id,slug ON "Event"
 FOR EACH ROW EXECUTE FUNCTION protect_event_alias_identity();

-- A claim and a merge cannot both commit while believing the edition is idle.
-- Existing task payloads/hashes are immutable; consumers resolve aliases at execution time.
CREATE FUNCTION lock_claimed_event_editions() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE event_ids TEXT[];
BEGIN
 IF NEW.status <> 'running' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status='running' AND NEW."leaseToken" IS NOT DISTINCT FROM OLD."leaseToken" THEN RETURN NEW; END IF;
 END IF;
 -- Take the shared gate before resolving identifiers: a union may have deleted
 -- the original Event while acquisition waited. The next statement sees the
 -- committed alias and locks its current canonical row, including chained unions.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('race_event_reconciliation',0));
 SELECT array_agg(DISTINCT resolve_event_id(value)) INTO event_ids FROM (
  SELECT NEW.payload->>'eventId' AS value
  UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.payload->'eventIds')='array'
   THEN NEW.payload->'eventIds' ELSE '[]'::jsonb END)
  UNION ALL SELECT r."eventId" FROM "EventSourceReference" r WHERE r."sourceId"=NEW.payload->>'sourceId'
  UNION ALL SELECT a."eventId" FROM "ExportArtifact" a WHERE a."taskId"=NEW.id
  UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.selection->'eventIds')='array'
   THEN a.selection->'eventIds' ELSE '[]'::jsonb END) FROM "ExportArtifact" a WHERE a."taskId"=NEW.id
  UNION ALL SELECT c."eventId" FROM "ResultCheckpoint" c WHERE c."activeTaskId"=NEW.id
 ) identifiers WHERE value IS NOT NULL;
 PERFORM id FROM "Event" WHERE id=ANY(event_ids) ORDER BY id FOR SHARE;
 RETURN NEW;
END $$;
CREATE TRIGGER claimed_event_editions BEFORE INSERT OR UPDATE OF status,"leaseToken" ON "CollectionTask"
 FOR EACH ROW EXECUTE FUNCTION lock_claimed_event_editions();

REVOKE ALL ON FUNCTION resolve_event_id(TEXT),protect_event_alias_identity(),lock_claimed_event_editions() FROM PUBLIC;
DO $$ DECLARE r TEXT; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON TABLE "EventAlias" FROM %I',r);
   EXECUTE format('REVOKE ALL ON FUNCTION resolve_event_id(TEXT),protect_event_alias_identity(),lock_claimed_event_editions() FROM %I',r);
  END IF;
 END LOOP;
END $$;
