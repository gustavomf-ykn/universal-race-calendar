-- Additive provenance for comparison. Existing associations and canonical data are untouched.
ALTER TABLE "EventSourceReference" ADD COLUMN observation JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "EventSourceReference" ADD COLUMN "lastValidatedAt" TIMESTAMPTZ;
-- The table already has RLS and no anon/authenticated grants; do not create public policies.
