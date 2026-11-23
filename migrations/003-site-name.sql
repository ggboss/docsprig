-- Site branding is immediate, not part of a draft revision or published release.
ALTER TABLE docs_workspace ADD COLUMN IF NOT EXISTS site_name text NOT NULL DEFAULT '文档平台'
  CHECK (char_length(site_name) BETWEEN 1 AND 64 AND site_name = btrim(site_name) AND site_name !~ '[[:cntrl:]]');
