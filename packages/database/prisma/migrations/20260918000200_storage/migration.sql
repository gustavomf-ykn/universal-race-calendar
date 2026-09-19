-- Supabase-only resources remain versioned in the one Prisma migration history.
-- Plain PostgreSQL tests do not provide the storage schema.
DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
    VALUES ('race-exports','race-exports',false,52428800,ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
    ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
    -- No anon/authenticated policies are added. Backend service role alone accesses artifacts.
  END IF;
END $$;
