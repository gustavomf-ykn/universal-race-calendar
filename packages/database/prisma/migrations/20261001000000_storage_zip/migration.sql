-- Multi-edition and split exports are ZIP archives. Preserve the private bucket
-- and its existing size limit/policies; no artifacts or results are changed.
DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets
    SET allowed_mime_types = array_append(allowed_mime_types, 'application/zip')
    WHERE id = 'race-exports'
      AND allowed_mime_types IS NOT NULL
      AND NOT ('application/zip' = ANY(allowed_mime_types));
  END IF;
END $$;
