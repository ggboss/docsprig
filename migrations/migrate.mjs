import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { backfillNormalized, saveDrafts, recordDraftChanges } from '../server/repository.mjs';

const text = url => readFile(new URL(url, import.meta.url), 'utf8');
async function seedNodes() {
  const [api, manifest] = await Promise.all([
    text('../public/content/dev/current/api.yaml'),
    text('../public/content/dev/current/index.json'),
  ]);
  const entry = JSON.parse(manifest).entries[0];
  const notes = await text(`../public/content/dev/current/${entry.markdown}`);
  const oldSeed = [
    { id: 'server-api', parentId: null, sort: 0, title: '服务端 API', type: 'group', body: '' },
    { id: 'api', parentId: 'server-api', sort: 0, title: '接口契约', type: 'api', body: api },
    { id: 'changelog', parentId: null, sort: 1, title: '更新日志', type: 'group', body: '' },
    { id: 'notes', parentId: 'changelog', sort: 0, title: entry.title, type: 'markdown', body: notes },
  ];
  const path = '/demo/v1/user/info', method = 'get';
  const fixture = parse(api), { security, ...operation } = fixture.paths[path][method];
  // The independently publishable demo has no base contract. Keep auth as
  // documentation (including its exact schemes), not an unresolved requirement.
  operation.description += '\n鉴权示例：Authorization: Bearer <token>（仅演示，不发送请求）。';
  operation['x-demo-authentication'] = { security, securitySchemes: fixture.components.securitySchemes };
  const fragment = { path, method, operation };
  const nodes = oldSeed.map(n => n.id === 'api'
    ? { ...n, title: operation.summary, body: stringify(fragment) } : n);
  return nodes.map(n => ({ ...n, draftVersion: 1, publishedVersion: null }));
}

function validateTarget(expected) {
  if (typeof expected !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(expected) ||
      ['postgres', 'template0', 'template1'].includes(expected)) throw new Error('Unsupported docs database');
}

export async function migrate(pool, expectedDatabase = 'docs_dev', { seed = 'empty', production = false } = {}) {
  validateTarget(expectedDatabase);
  if (!['demo', 'empty'].includes(seed)) throw new Error('Unknown initialization mode');
  if ((production || expectedDatabase === 'docs_prod') && seed !== 'empty') throw new Error('Production initialization must be empty');
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const { rows: [target] } = await client.query('SELECT current_database() AS db');
    if (target.db !== expectedDatabase) throw new Error('Unexpected migration database');
    await client.query('SET LOCAL search_path TO public');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('docs_workspace_migration'))");
    const { rows: [legacy] } = await client.query(`SELECT
      to_regclass('public.docs_workspace') IS NOT NULL AS workspace,
      to_regclass('public.docs_history') IS NOT NULL AS history`);
    if (legacy.workspace !== legacy.history) throw new Error('Incomplete legacy storage; manual recovery required');
    await client.query(await text('./004-normalized.sql'));
    if ((await client.query('SELECT 1 FROM docs_state WHERE singleton')).rowCount) {
      // A cleaned database must never recreate retired tables or their trigger.
      if (legacy.workspace) await client.query(await text('./005-freeze-legacy.sql'));
      await client.query('COMMIT');
      return;
    }
    if (legacy.workspace) {
      // Upgrade an existing installation; explicit cleanup remains a separate step.
      await client.query(await text('./002-node-versions.sql'));
      await client.query(await text('./003-site-name.sql'));
      await backfillNormalized(client);
      await client.query(await text('./005-freeze-legacy.sql'));
    } else {
      // New installations write the normalized model directly: exactly eight tables.
      const { rows: [existing] } = await client.query(`SELECT EXISTS (
        SELECT 1 FROM docs_node_identities UNION ALL SELECT 1 FROM docs_releases
        UNION ALL SELECT 1 FROM docs_audit
      ) AS populated`);
      if (existing.populated) throw new Error('Uninitialized normalized data; manual recovery required');
      const nodes = seed === 'empty' ? [] : await seedNodes();
      await saveDrafts(client, nodes);
      await client.query(`INSERT INTO docs_audit(revision,action,actor,metadata)
        VALUES(0,'save','{}','{"initialized":true,"draftSnapshot":true}')`);
      await recordDraftChanges(client, 0, [], nodes);
      await client.query(`INSERT INTO docs_state(singleton,revision,site_name,current_release_id)
        VALUES(true,0,'文档平台',NULL)`);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

export function migrationSettings(env = process.env, { production = false } = {}) {
  const expected = env.DOCS_DATABASE ?? (production ? 'docs_prod' : 'docs_dev');
  validateTarget(expected);
  const seed = env.DOCS_SEED ?? 'empty';
  if (!['demo', 'empty'].includes(seed)) throw new Error('Unknown initialization mode');
  if ((production || env.NODE_ENV === 'production' || expected === 'docs_prod') && seed !== 'empty') throw new Error('Production initialization must be empty');
  return { expected, seed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the intended docs database');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--production')) throw new Error('Unsupported migration arguments');
    const production = args[0] === '--production';
    // Real environments start empty; demo fixtures are explicitly opted into.
    const { expected, seed } = migrationSettings(process.env, { production });
    await migrate(pool, expected, { seed, production });
    console.log(`Docs workspace migration complete: ${expected}`);
  }
  catch { console.error('Docs workspace migration failed'); process.exitCode = 1; }
  finally { await pool.end(); }
}
