-- Explicit maintenance step, NOT run automatically by migrate.mjs.
-- Run in a transaction after backing up and verifying normalized data.
-- RESTRICT (no CASCADE) makes unexpected dependencies abort the cleanup.
DO $$
DECLARE old_revision integer; new_revision integer;
BEGIN
  SELECT revision INTO new_revision FROM public.docs_state WHERE singleton FOR UPDATE;
  IF new_revision IS NULL THEN RAISE EXCEPTION 'Normalized storage is not initialized'; END IF;
  IF (to_regclass('public.docs_workspace') IS NULL) <>
     (to_regclass('public.docs_history') IS NULL) THEN
    RAISE EXCEPTION 'Incomplete legacy storage';
  END IF;
  IF to_regclass('public.docs_workspace') IS NOT NULL THEN
    LOCK TABLE public.docs_workspace,public.docs_history IN ACCESS EXCLUSIVE MODE;
    SELECT revision INTO old_revision FROM public.docs_workspace WHERE singleton;
    IF old_revision IS NULL OR old_revision > new_revision THEN
      RAISE EXCEPTION 'Legacy workspace has not been migrated';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.docs_history h LEFT JOIN public.docs_audit a USING(revision)
      WHERE a.revision IS NULL OR a.action <> h.action OR a.actor <> h.actor
        -- The original JS backfill retained timestamp precision to milliseconds.
        OR date_trunc('milliseconds',a.recorded_at) <> date_trunc('milliseconds',h.recorded_at)
        OR a.release_id IS DISTINCT FROM h.release->>'id'
    ) THEN RAISE EXCEPTION 'Legacy history does not match normalized audit'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.docs_workspace w
      WHERE w.published IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.docs_releases r WHERE r.id=w.published->>'id'
      )
    ) THEN RAISE EXCEPTION 'Legacy publication is missing'; END IF;
    DROP TABLE public.docs_workspace,public.docs_history;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.docs_legacy_readonly();
