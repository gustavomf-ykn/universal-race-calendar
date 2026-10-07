-- Country is observed metadata; unknown historical matches remain unknown.
ALTER TABLE "SourceMatch" ADD COLUMN country TEXT;
-- Existing RLS and denied PUBLIC/anon/authenticated privileges remain in force.
