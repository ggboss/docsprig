-- Legacy workspace/history are retained as a read-only migration source.
CREATE TABLE IF NOT EXISTS docs_node_identities (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS docs_document_versions (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  node_id text NOT NULL REFERENCES docs_node_identities(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND btrim(title) <> ''),
  type text NOT NULL CHECK (type IN ('group','markdown','api')),
  body text NOT NULL,
  UNIQUE (node_id,id)
);
CREATE TABLE IF NOT EXISTS docs_releases (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  revision integer NOT NULL CHECK (revision >= 0),
  revision_present boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE IF NOT EXISTS docs_state (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision integer NOT NULL CHECK (revision >= 0),
  site_name text NOT NULL CHECK (char_length(site_name) BETWEEN 1 AND 64 AND btrim(site_name) = site_name AND site_name !~ '[[:cntrl:]]'),
  current_release_id text REFERENCES docs_releases(id)
);
CREATE TABLE IF NOT EXISTS docs_drafts (
  node_id text PRIMARY KEY REFERENCES docs_node_identities(id),
  parent_id text REFERENCES docs_drafts(node_id) DEFERRABLE INITIALLY DEFERRED,
  sort integer NOT NULL CHECK (sort >= 0),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  version_id text NOT NULL,
  draft_version integer NOT NULL CHECK (draft_version > 0),
  published_version integer CHECK (published_version > 0 AND published_version <= draft_version),
  pending_placement boolean,
  keep_live_rank boolean,
  CHECK (parent_id IS DISTINCT FROM node_id),
  FOREIGN KEY (node_id,version_id) REFERENCES docs_document_versions(node_id,id)
);
CREATE TABLE IF NOT EXISTS docs_release_nodes (
  release_id text NOT NULL REFERENCES docs_releases(id),
  node_id text NOT NULL REFERENCES docs_node_identities(id),
  parent_id text,
  sort integer NOT NULL CHECK (sort >= 0),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  version_id text NOT NULL,
  draft_version integer NOT NULL CHECK (draft_version > 0),
  published_version integer NOT NULL CHECK (published_version > 0 AND published_version <= draft_version),
  pending_placement boolean,
  keep_live_rank boolean,
  PRIMARY KEY (release_id,node_id),
  UNIQUE (release_id,ordinal),
  CHECK (parent_id IS DISTINCT FROM node_id),
  FOREIGN KEY (node_id,version_id) REFERENCES docs_document_versions(node_id,id),
  FOREIGN KEY (release_id,parent_id) REFERENCES docs_release_nodes(release_id,node_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS docs_draft_parent ON docs_drafts(parent_id,sort,node_id);
CREATE INDEX IF NOT EXISTS docs_release_parent ON docs_release_nodes(release_id,parent_id,sort,node_id);
CREATE TABLE IF NOT EXISTS docs_audit (
  revision integer PRIMARY KEY CHECK (revision >= 0),
  action text NOT NULL CHECK (action IN ('save','publish')),
  actor jsonb NOT NULL,
  creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  release_id text REFERENCES docs_releases(id),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK ((action = 'publish') = (release_id IS NOT NULL))
);
-- Keep reruns safe for databases initialized during the normalized rollout.
ALTER TABLE docs_audit ADD COLUMN IF NOT EXISTS creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE OR REPLACE FUNCTION docs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
CREATE OR REPLACE FUNCTION docs_release_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM docs_releases WHERE id=NEW.release_id AND creation_xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Cannot append to a committed release' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
-- Parent FKs are scoped to each snapshot, never to the mutable draft tree.
CREATE OR REPLACE FUNCTION docs_tree_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('docs.tree_checked','false',true);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION docs_check_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invalid boolean;
BEGIN
  -- Deferred row triggers share this transaction-local guard. Statement triggers
  -- dirty it again if SET CONSTRAINTS IMMEDIATE is followed by more writes.
  IF current_setting('docs.tree_checked',true) = 'true' THEN RETURN NULL; END IF;
  WITH RECURSIVE nodes AS MATERIALIZED (
    SELECT ''::text AS scope,d.node_id,d.parent_id,v.type FROM docs_drafts d JOIN docs_document_versions v ON v.id=d.version_id
    UNION ALL
    SELECT n.release_id,n.node_id,n.parent_id,v.type FROM docs_release_nodes n
      JOIN docs_releases r ON r.id=n.release_id AND r.creation_xid=pg_current_xact_id()
      JOIN docs_document_versions v ON v.id=n.version_id
  ), paths AS (
    SELECT scope,node_id,parent_id,1 AS depth,ARRAY[node_id] AS visited,false AS cycle FROM nodes
    UNION ALL
    SELECT p.scope,p.node_id,n.parent_id,p.depth+1,p.visited || n.node_id,n.node_id=ANY(p.visited)
    FROM paths p JOIN nodes n ON n.scope=p.scope AND n.node_id=p.parent_id WHERE NOT p.cycle AND p.depth<=16
  ) SELECT EXISTS (SELECT 1 FROM paths WHERE cycle OR depth>16) OR EXISTS (
    SELECT 1 FROM nodes n LEFT JOIN nodes p ON p.scope=n.scope AND p.node_id=n.parent_id
    WHERE (n.parent_id IS NULL AND n.type<>'group') OR (n.parent_id IS NOT NULL AND p.type IS DISTINCT FROM 'group')
  ) OR EXISTS (SELECT scope FROM nodes GROUP BY scope HAVING count(*)>1000) INTO invalid;
  IF invalid THEN RAISE EXCEPTION 'Invalid document hierarchy' USING ERRCODE = '23514'; END IF;
  PERFORM set_config('docs.tree_checked','true',true);
  RETURN NULL;
END $$;
CREATE TABLE IF NOT EXISTS docs_draft_changes (
  revision integer NOT NULL REFERENCES docs_audit(revision),
  node_id text NOT NULL REFERENCES docs_node_identities(id),
  deleted boolean NOT NULL DEFAULT false,
  parent_id text REFERENCES docs_node_identities(id),
  sort integer CHECK (sort >= 0),
  ordinal integer CHECK (ordinal >= 0),
  version_id text,
  draft_version integer CHECK (draft_version > 0),
  published_version integer CHECK (published_version > 0 AND published_version <= draft_version),
  pending_placement boolean,
  keep_live_rank boolean,
  PRIMARY KEY (revision,node_id),
  FOREIGN KEY (node_id,version_id) REFERENCES docs_document_versions(node_id,id),
  CHECK ((deleted AND version_id IS NULL AND draft_version IS NULL) OR
    (NOT deleted AND version_id IS NOT NULL AND draft_version IS NOT NULL AND sort IS NOT NULL AND ordinal IS NOT NULL))
);
CREATE OR REPLACE FUNCTION docs_draft_change_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM docs_audit WHERE revision=NEW.revision AND creation_xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Cannot append to a committed draft revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['docs_document_versions','docs_releases','docs_release_nodes','docs_audit','docs_draft_changes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname='immutable_rows') THEN
      EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION docs_immutable()',t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='docs_draft_changes'::regclass AND tgname='draft_change_insert') THEN
    CREATE TRIGGER draft_change_insert BEFORE INSERT ON docs_draft_changes FOR EACH ROW EXECUTE FUNCTION docs_draft_change_insert();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='docs_release_nodes'::regclass AND tgname='release_insert') THEN
    CREATE TRIGGER release_insert BEFORE INSERT ON docs_release_nodes FOR EACH ROW EXECUTE FUNCTION docs_release_insert();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='docs_drafts'::regclass AND tgname='valid_tree') THEN
    CREATE TRIGGER tree_dirty BEFORE INSERT OR UPDATE OR DELETE ON docs_drafts FOR EACH STATEMENT EXECUTE FUNCTION docs_tree_dirty();
    CREATE TRIGGER tree_dirty BEFORE INSERT ON docs_release_nodes FOR EACH STATEMENT EXECUTE FUNCTION docs_tree_dirty();
    CREATE CONSTRAINT TRIGGER valid_tree AFTER INSERT OR UPDATE OR DELETE ON docs_drafts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION docs_check_tree();
    CREATE CONSTRAINT TRIGGER valid_tree AFTER INSERT ON docs_release_nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION docs_check_tree();
  END IF;
END $$;
