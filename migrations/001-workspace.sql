CREATE TABLE IF NOT EXISTS docs_workspace (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision integer NOT NULL CHECK (revision >= 0),
  nodes jsonb NOT NULL CHECK (jsonb_typeof(nodes) = 'array'),
  published jsonb CHECK (jsonb_typeof(published) = 'object')
);

CREATE TABLE IF NOT EXISTS docs_history (
  revision integer PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('save', 'publish')),
  actor jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Publish records retain the exact source tree independently of subsequent saves.
  nodes jsonb NOT NULL,
  release jsonb,
  CHECK ((action = 'publish') = (release IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS docs_release_id ON docs_history ((release->>'id'))
  WHERE action = 'publish';
