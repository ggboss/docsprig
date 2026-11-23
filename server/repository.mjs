import { createHash } from 'node:crypto';

// Content addressing deliberately excludes placement and numeric edit counters:
// moving a node or publishing an unchanged sibling never copies its full body.
const versionId = n => createHash('sha256').update(JSON.stringify([n.id,n.title,n.type,n.body])).digest('hex');
const rowsFor = nodes => nodes.map((n, ordinal) => ({
  node_id:n.id, parent_id:n.parentId, sort:n.sort, ordinal, version_id:versionId(n),
  title:n.title, type:n.type, body:n.body, draft_version:n.draftVersion,
  published_version:n.publishedVersion, pending_placement:n.pendingPlacement ?? null, keep_live_rank:n.keepLiveRank ?? null,
}));
const recordType = `node_id text,parent_id text,sort integer,ordinal integer,version_id text,title text,type text,body text,
  draft_version integer,published_version integer,pending_placement boolean,keep_live_rank boolean`;
const columns = 'node_id,parent_id,sort,ordinal,version_id,draft_version,published_version,pending_placement,keep_live_rank';

async function versions(client, rows) {
  const json = JSON.stringify(rows);
  await client.query(`INSERT INTO docs_node_identities(id) SELECT x.node_id FROM jsonb_to_recordset($1) AS x(${recordType})
    ON CONFLICT DO NOTHING`, [json]);
  await client.query(`INSERT INTO docs_document_versions(id,node_id,title,type,body)
    SELECT version_id,node_id,title,type,body FROM jsonb_to_recordset($1) AS x(${recordType}) ON CONFLICT DO NOTHING`, [json]);
  // Fail closed on corrupt pre-existing content (including an unlikely digest collision).
  const {rows:[check]} = await client.query(`SELECT EXISTS (SELECT 1 FROM jsonb_to_recordset($1) AS x(${recordType})
    JOIN docs_document_versions v ON v.id=x.version_id
    WHERE (v.node_id,v.title,v.type,v.body) IS DISTINCT FROM (x.node_id,x.title,x.type,x.body)) AS conflict`,[json]);
  if (check.conflict) throw new Error('Immutable document version content mismatch');
  return json;
}

export async function saveDrafts(client, nodes) {
  const json = await versions(client, rowsFor(nodes));
  await client.query('DELETE FROM docs_drafts WHERE NOT (node_id=ANY($1::text[]))', [nodes.map(n=>n.id)]);
  await client.query(`INSERT INTO docs_drafts(${columns}) SELECT ${columns} FROM jsonb_to_recordset($1) AS x(${recordType})
    ON CONFLICT (node_id) DO UPDATE SET parent_id=excluded.parent_id,sort=excluded.sort,ordinal=excluded.ordinal,
    version_id=excluded.version_id,draft_version=excluded.draft_version,published_version=excluded.published_version,
    pending_placement=excluded.pending_placement,keep_live_rank=excluded.keep_live_rank
    WHERE (docs_drafts.parent_id,docs_drafts.sort,docs_drafts.ordinal,docs_drafts.version_id,
      docs_drafts.draft_version,docs_drafts.published_version,docs_drafts.pending_placement,docs_drafts.keep_live_rank)
    IS DISTINCT FROM (excluded.parent_id,excluded.sort,excluded.ordinal,excluded.version_id,
      excluded.draft_version,excluded.published_version,excluded.pending_placement,excluded.keep_live_rank)`, [json]);
  await client.query(`UPDATE docs_node_identities i SET deleted_at=CASE WHEN EXISTS
    (SELECT 1 FROM docs_drafts d WHERE d.node_id=i.id) THEN NULL ELSE coalesce(i.deleted_at,clock_timestamp()) END
    WHERE (i.deleted_at IS NULL) IS DISTINCT FROM EXISTS (SELECT 1 FROM docs_drafts d WHERE d.node_id=i.id)`);
}

export async function insertRelease(client, published, nodes, revision = published.revision, createdAt = null) {
  const json = await versions(client, rowsFor(nodes));
  await client.query(`INSERT INTO docs_releases(id,revision,revision_present,created_at)
    VALUES ($1,$2,$3,coalesce($4::timestamptz,clock_timestamp()))`, [published.id,revision,Object.hasOwn(published,'revision'),createdAt]);
  await client.query(`INSERT INTO docs_release_nodes(release_id,${columns})
    SELECT $2,${columns} FROM jsonb_to_recordset($1) AS x(${recordType})`, [json,published.id]);
}

export async function recordDraftChanges(client, revision, before, after) {
  const old = new Map(rowsFor(before).map(n=>[n.node_id,n]));
  const rows = rowsFor(after).filter(n=>JSON.stringify(n)!==JSON.stringify(old.get(n.node_id)));
  const json = await versions(client, rows);
  await client.query(`INSERT INTO docs_draft_changes(revision,${columns})
    SELECT $2,${columns} FROM jsonb_to_recordset($1) AS x(${recordType})`,[json,revision]);
  const removed = before.filter(n=>!after.some(a=>a.id===n.id)).map(n=>n.id);
  if (removed.length) await client.query(`INSERT INTO docs_draft_changes(revision,node_id,deleted)
    SELECT $1,unnest($2::text[]),true`,[revision,removed]);
}

export const nodeJSON = alias => `jsonb_build_object('id',${alias}.node_id,'parentId',${alias}.parent_id,'sort',${alias}.sort,
  'title',v.title,'type',v.type,'body',v.body,'draftVersion',${alias}.draft_version,'publishedVersion',${alias}.published_version)
  || CASE WHEN ${alias}.pending_placement IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('pendingPlacement',${alias}.pending_placement) END
  || CASE WHEN ${alias}.keep_live_rank IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('keepLiveRank',${alias}.keep_live_rank) END`;
export const releaseJSON = `CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id)
  || CASE WHEN r.revision_present THEN jsonb_build_object('revision',r.revision) ELSE '{}'::jsonb END END`;

export async function loadRelease(client, id) {
  const { rows:[release] } = await client.query(`SELECT r.revision,
    coalesce((SELECT jsonb_agg(${nodeJSON('n')} ORDER BY n.ordinal) FROM docs_release_nodes n
      JOIN docs_document_versions v ON v.id=n.version_id WHERE n.release_id=r.id),'[]'::jsonb) AS nodes
    FROM docs_releases r WHERE r.id=$1`, [id]);
  return release ?? null;
}

export async function backfillNormalized(client) {
  if ((await client.query('SELECT 1 FROM docs_state WHERE singleton')).rowCount) return;
  // Lock the legacy source while constructing and verifying the complete normalized model.
  await client.query('LOCK TABLE docs_workspace, docs_history IN SHARE ROW EXCLUSIVE MODE');
  const {rows:[legacy]} = await client.query('SELECT * FROM docs_workspace WHERE singleton');
  if (!legacy) throw new Error('Missing legacy workspace');
  const {rows:history} = await client.query('SELECT * FROM docs_history ORDER BY revision');
  for (const h of history) {
    if (h.action === 'publish') {
      const nodes = h.nodes.map(n=>({...n,draftVersion:n.draftVersion ?? 1,publishedVersion:n.publishedVersion ?? 1}));
      const revision = h.release.revision ?? Math.max(0,h.revision-1);
      await insertRelease(client,h.release,nodes,revision,h.recorded_at);
      const actual = await loadRelease(client,h.release.id);
      // JSON key order is immaterial. Compare all preserved node fields in SQL.
      const {rows:[verified]} = await client.query('SELECT $1::jsonb=$2::jsonb AS ok',[JSON.stringify(actual.nodes),JSON.stringify(nodes)]);
      if (!verified.ok || actual.revision !== revision) throw new Error(`Release backfill verification failed: ${h.release.id}`);
    }
    const snapshot = h.revision === legacy.revision ? legacy.nodes : h.action === 'save' ? h.nodes : null;
    await client.query(`INSERT INTO docs_audit(revision,action,actor,recorded_at,release_id,metadata)
      VALUES ($1,$2,$3,$4,$5,$6)`,[h.revision,h.action,JSON.stringify(h.actor),h.recorded_at,h.release?.id ?? null,
        JSON.stringify({migrated:true,draftSnapshot:snapshot !== null,historicalDraftUnavailable:snapshot === null})]);
    if (snapshot) await recordDraftChanges(client,h.revision,[],snapshot.map(n=>({...n,draftVersion:n.draftVersion ?? 1,publishedVersion:n.publishedVersion ?? null})));

  }
  await saveDrafts(client,legacy.nodes);
  if (!history.some(h=>h.revision===legacy.revision)) {
    await client.query(`INSERT INTO docs_audit(revision,action,actor,metadata) VALUES ($1,'save','{}','{"migrated":true,"draftSnapshot":true}')`,[legacy.revision]);
    await recordDraftChanges(client,legacy.revision,[],legacy.nodes);
  }
  const {rows:[verified]} = await client.query(`SELECT coalesce(jsonb_agg(${nodeJSON('d')} ORDER BY d.ordinal),'[]'::jsonb)=$1::jsonb AS ok
    FROM docs_drafts d JOIN docs_document_versions v ON v.id=d.version_id`,[JSON.stringify(legacy.nodes)]);
  if (!verified.ok) throw new Error('Draft backfill verification failed');
  await client.query(`INSERT INTO docs_state(singleton,revision,site_name,current_release_id) VALUES(true,$1,$2,$3)`,
    [legacy.revision,legacy.site_name,legacy.published?.id ?? null]);
}
