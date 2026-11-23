-- Installed only after the normalized backfill has passed verification. An old
-- server must fail loudly after cutover instead of writing a divergent store.
CREATE OR REPLACE FUNCTION docs_legacy_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Legacy document storage is read-only after normalized cutover' USING ERRCODE = '55000';
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['docs_workspace','docs_history'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname='normalized_cutover') THEN
      EXECUTE format('CREATE TRIGGER normalized_cutover BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION docs_legacy_readonly()',t);
    END IF;
  END LOOP;
END $$;
