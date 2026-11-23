import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationSettings } from '../migrations/migrate.mjs';

test('migration defaults to empty development and requires explicit production target', () => {
  assert.deepEqual(migrationSettings({}), { expected: 'docs_dev', seed: 'empty' });
  assert.deepEqual(migrationSettings({ NODE_ENV: 'production' }), { expected: 'docs_dev', seed: 'empty' });
  assert.deepEqual(migrationSettings({ DOCS_DATABASE: 'docs_prod' }), { expected: 'docs_prod', seed: 'empty' });
});
test('demo initialization is explicit and never allowed for production', () => {
  assert.deepEqual(migrationSettings({ DOCS_SEED: 'demo' }), { expected: 'docs_dev', seed: 'demo' });
  assert.throws(() => migrationSettings({ DOCS_DATABASE: 'docs_prod', DOCS_SEED: 'demo' }), /must be empty/);
  for (const DOCS_DATABASE of ['postgres', 'template0', 'template1', '', 'docs/prod', 'docs prod', 'bad;sql'])
    assert.throws(() => migrationSettings({ DOCS_DATABASE }), /Unsupported/);
  for (const DOCS_SEED of ['', 'true', 'reset']) assert.throws(() => migrationSettings({ DOCS_SEED }), /Unknown/);
});
test('custom databases are supported and production mode never seeds demo data', async () => {
  assert.deepEqual(migrationSettings({ DOCS_DATABASE: 'custom_docs' }), { expected: 'custom_docs', seed: 'empty' });
  assert.deepEqual(migrationSettings({}, { production: true }), { expected: 'docs_prod', seed: 'empty' });
  assert.throws(() => migrationSettings({ DOCS_DATABASE: 'custom_docs', DOCS_SEED: 'demo' }, { production: true }), /must be empty/);
  assert.throws(() => migrationSettings({ DOCS_DATABASE: 'custom_docs', DOCS_SEED: 'demo', NODE_ENV: 'production' }), /must be empty/);
  const pool = { connect() { assert.fail('Must not connect'); } };
  await assert.rejects(migrate(pool, 'custom_docs', { production: true, seed: 'demo' }), /must be empty/);
  await assert.rejects(migrate(pool, 'postgres'), /Unsupported/);
});
test('unsafe initialization is rejected before acquiring a database connection', async () => {
  const pool = { connect() { assert.fail('Must not connect'); } };
  await assert.rejects(migrate(pool, 'docs_prod', { seed: 'demo' }), /must be empty/);
  await assert.rejects(migrate(pool, 'docs_dev', { seed: 'unknown' }), /Unknown/);
});
test('wrong actual database rolls back without creating or seeding tables', async () => {
  const queries = [];
  let released = false;
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith('SELECT current_database')) return { rows: [{ db: 'docs_prod' }] };
    return { rows: [] };
  }, release() { released = true; } };
  await assert.rejects(migrate({ connect: async () => client }, 'docs_dev', { seed: 'empty' }), /Unexpected migration database/);
  assert.equal(released, true);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.length, 3);
});

function normalizedPool({ workspace = false, history = false, initialized = true, populated = false } = {}) {
  const queries = [];
  const client = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT current_database')) return { rows: [{ db: 'docs_dev' }] };
    if (sql.includes("to_regclass('public.docs_workspace')")) return { rows: [{ workspace, history }] };
    if (sql === 'SELECT 1 FROM docs_state WHERE singleton') return { rows: [], rowCount: initialized ? 1 : 0 };
    if (sql.includes('AS conflict')) return { rows: [{ conflict: false }] };
    if (sql.includes('AS populated')) return { rows: [{ populated }] };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  return { queries, pool: { connect: async () => client } };
}
test('migrating a cleaned installation never recreates legacy tables or their trigger', async () => {
  const { pool, queries } = normalizedPool();
  await migrate(pool);
  const sql = queries.map(q => q.sql).join('\n');
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS docs_(workspace|history)|docs_legacy_readonly|normalized_cutover/);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});
test('fresh empty initialization writes normalized storage directly without legacy tables', async () => {
  const { pool, queries } = normalizedPool({ initialized: false });
  await migrate(pool);
  const sql = queries.map(q => q.sql).join('\n');
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS docs_(workspace|history)|INSERT INTO docs_workspace|docs_legacy_readonly/);
  assert.match(sql, /INSERT INTO docs_state/);
  assert.match(sql, /INSERT INTO docs_audit/);
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS /g) ?? []).length, 8);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});
test('partial legacy tables or orphaned normalized data stop migration instead of resetting data', async () => {
  for (const options of [{ workspace: true }, { history: true }, { initialized: false, populated: true }]) {
    const { pool, queries } = normalizedPool(options);
    await assert.rejects(migrate(pool), /manual recovery/);
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
    assert.ok(!queries.some(q => q.sql.startsWith('DELETE FROM docs_drafts')));
  }
});
