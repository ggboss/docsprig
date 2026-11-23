import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createStore } from '../server/store.mjs';
import { createContent } from '../server/content.mjs';
import { handler } from '../server/http.mjs';

// Run: OPEN_TEST_PG_DOCKER=1 node --test tests/database-publication.mjs
// Never consumes DATABASE_URL, an existing database, CONTENT_DIR or OSS credentials.
// The child has no filesystem write permission and cannot read public/ fixtures.
const filename = fileURLToPath(import.meta.url);
const repo = dirname(dirname(filename));
if (process.argv.includes('--publication-worker')) {
  const pool = new Pool(JSON.parse(process.env.PUBLICATION_TEST_CONNECTION));
  const store = createStore(pool);
  const content = createContent({ loadRelease: id => store.releaseNodes(id) });
  let api;
  const server = createServer((req, res) => api(req, res));
  server.listen(0, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    api = handler({ store, content, origin, authenticate: async req => {
      if (req.headers.authorization !== `Bearer ${process.env.PUBLICATION_TEST_TOKEN}`)
        throw Object.assign(new Error('Unauthorized test request'), { status: 401 });
      return { id: 'isolated-publication-test' };
    } });
    console.log(JSON.stringify({ origin, pid: process.pid,
      contentDir: process.env.CONTENT_DIR ?? null,
      fixtureReadable: process.permission.has('fs.read', join(repo, 'public/content/dev/current/api.yaml')),
      filesWritable: process.permission.has('fs.write', process.cwd()) }));
  });
  process.once('SIGTERM', () => {
    server.close(async () => { await pool.end(); });
    server.closeAllConnections();
  });
} else {
  test('DB publication survives process restart without content files and isolates drafts', {
    skip: process.env.OPEN_TEST_PG_DOCKER !== '1' && 'set OPEN_TEST_PG_DOCKER=1 for disposable Docker PostgreSQL',
    timeout: 120_000,
  }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'open-publication-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const container = `open-publication-${randomUUID()}`;
    const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }).trim();
    docker('run', '--rm', '--pull=never', '-d', '--name', container,
      '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=docs_test', 'postgres:16-alpine');
    t.after(() => docker('rm', '-f', container));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'docs_test'); ready = true; break; }
      catch { await sleep(200); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const mapped = docker('port', container, '5432/tcp').match(/^127\.0\.0\.1:(\d+)$/);
    assert.ok(mapped, 'Only use the loopback port of our newly created container');
    const connection = { host: '127.0.0.1', port: Number(mapped[1]), user: 'docs_test',
      password: '', database: 'postgres', ssl: false, max: 2, connectionTimeoutMillis: 3000 };
    const pool = new Pool(connection);
    try {
      const { migrate } = await import('../migrations/migrate.mjs');
      await migrate(pool, 'postgres', { seed: 'demo' });
    } finally { await pool.end(); }

    const token = randomUUID();
    async function start() {
      const child = spawn(process.execPath, ['--permission',
        `--allow-fs-read=${filename}`, `--allow-fs-read=${join(repo, 'package.json')}`,
        `--allow-fs-read=${join(repo, 'server')}`, `--allow-fs-read=${join(repo, 'migrations')}`,
        `--allow-fs-read=${join(repo, 'node_modules')}`,
        filename, '--publication-worker'], {
        cwd: root, env: { PATH: process.env.PATH, PUBLICATION_TEST_CONNECTION: JSON.stringify(connection),
          PUBLICATION_TEST_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '', stdout = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const stopped = once(child, 'exit');
      const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { await stopped; } finally { clearTimeout(timer); }
      };
      t.after(stop);
      const info = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker startup timeout: ${stderr}`)), 15_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${stderr}`)); });
        child.stdout.on('data', chunk => {
          stdout += chunk;
          if (!stdout.includes('\n')) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); }
        });
      });
      assert.equal(info.contentDir, null);
      assert.equal(info.fixtureReadable, false, 'Release fixtures must be inaccessible in the serving process');
      assert.equal(info.filesWritable, false, 'Publisher cannot persist hidden filesystem artifacts');
      return { ...info, stop };
    }
    let app = await start();
    const request = (path, options = {}) => fetch(app.origin + path, { ...options, signal: AbortSignal.timeout(10_000) });
    async function management(path, method = 'GET', body, expected = 200) {
      const response = await request(path, { method, headers: { Origin: app.origin,
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
      return value;
    }
    let state = await management('/manage/workspace');
    const node = id => state.nodes.find(n => n.id === id);
    const save = async value => { state = await management('/manage/node', 'PUT', { revision: state.revision, node: value }); };
    const publish = async id => { state = await management('/manage/publish', 'POST', {
      revision: state.revision, id, draftVersion: node(id).draftVersion }); };
    const rootNode = { id: 'persistence', parentId: null, sort: 20, title: 'Persistence', type: 'group', body: '' };
    const markdown = { id: 'persistence-md', parentId: rootNode.id, sort: 0, title: 'Released guide', type: 'markdown', body: '# Saved release\n数据库持久化。\n' };
    const apiNode = { id: 'persistence-api', parentId: rootNode.id, sort: 1, title: 'Released API', type: 'api', body: JSON.stringify({
      openapi: '3.1.0', 'x-open-docs-document-kind': 'operation', info: { title: 'Persisted', version: '1' },
      paths: { '/persisted': { get: { operationId: 'persisted', summary: 'Saved API', responses: { 200: { description: 'Saved response' } } } } },
    }) };
    assert.equal((await request('/content/dev/current/tree.json')).status, 404);
    for (const value of [rootNode, markdown, apiNode]) { await save(value); await publish(value.id); }
    const release = structuredClone(state.published);
    const prefix = `/content/dev/releases/${release.id}/`;
    const hash = id => createHash('sha256').update(JSON.stringify(id)).digest('hex');
    const markdownURL = `${prefix}md/${hash(markdown.id)}.md`;
    const apiURL = `${prefix}api/${hash(apiNode.id)}.json`;
    const paths = [prefix + 'tree.json', prefix + 'index.json', prefix + 'api.yaml', markdownURL, apiURL];
    async function snapshot(path) {
      const response = await request(path);
      assert.equal(response.status, 200, path);
      return { body: await response.text(), type: response.headers.get('content-type'),
        cache: response.headers.get('cache-control'), length: response.headers.get('content-length') };
    }
    const saved = new Map();
    for (const path of paths) saved.set(path, await snapshot(path));
    const tree = JSON.parse(saved.get(prefix + 'tree.json').body);
    assert.equal(tree.nodes.find(n => n.id === markdown.id).url, markdownURL, 'Markdown URL contract is unchanged');
    assert.equal(tree.nodes.find(n => n.id === apiNode.id).url, apiURL, 'Per-node OpenAPI URL contract is unchanged');
    assert.deepEqual(tree.nodes.find(n => n.id === apiNode.id).detailRoutes, ['/api/~endpoints#saved-api'],
      'Historical API bookmark routing must survive lazy DB-backed rendering');
    assert.equal(saved.get(markdownURL).body, markdown.body);
    assert.equal(saved.get(markdownURL).type, 'text/markdown; charset=utf-8');
    assert.equal(saved.get(apiURL).type, 'application/json');
    assert.equal(saved.get(prefix + 'api.yaml').type, 'application/yaml');
    assert.ok(JSON.parse(saved.get(apiURL).body).paths['/persisted'].get);
    for (const value of saved.values()) assert.equal(value.cache, 'public, max-age=31536000, immutable');

    await save({ ...node(markdown.id), title: 'PRIVATE TITLE', body: 'PRIVATE MARKDOWN' });
    const beforeInvalid = structuredClone(state);
    await management('/manage/node', 'PUT', { revision: state.revision,
      node: { ...node(apiNode.id), body: 'PRIVATE INVALID YAML: [' } }, 400);
    assert.deepEqual(await management('/manage/workspace'), beforeInvalid, 'Invalid API save rolls back');
    const privateDocument = JSON.parse(apiNode.body);
    privateDocument.paths['/persisted'].get.summary = 'PRIVATE API';
    await save({ ...node(apiNode.id), body: JSON.stringify(privateDocument) });
    await save({ ...markdown, id: 'private-only', body: 'PRIVATE NEW NODE' });
    const draft = structuredClone(state);
    await management('/manage/publish', 'POST', { revision: state.revision,
      id: apiNode.id, draftVersion: node(apiNode.id).draftVersion - 1 }, 409);
    assert.deepEqual(await management('/manage/workspace'), draft, 'Rejected publication rolls back revision, drafts and pointer');
    await management('/manage/node', 'PUT', { revision: state.revision - 1, node: markdown }, 409);
    assert.deepEqual(await management('/manage/workspace'), draft, 'Stale write cannot alter saved drafts');

    const firstPid = app.pid;
    await app.stop();
    app = await start();
    assert.notEqual(app.pid, firstPid, 'Reads must come from a genuinely new serving process');
    assert.deepEqual(await management('/manage/workspace'), draft, 'Drafts and published pointer survive restart');
    for (const [path, expected] of saved) assert.deepEqual(await snapshot(path), expected, `Immutable URL after restart: ${path}`);
    for (const file of ['tree.json', 'index.json', 'api.yaml']) {
      const current = await snapshot(`/content/dev/current/${file}`);
      assert.equal(current.body, saved.get(prefix + file).body);
      assert.equal(current.cache, 'no-store');
      assert.ok(!current.body.includes('PRIVATE'), 'Public response cannot include unpublished drafts');
    }
    assert.equal((await request(`${prefix}md/${hash('private-only')}.md`)).status, 404);
    assert.equal((await request(`/content/dev/releases/${randomUUID()}/tree.json`)).status, 404);
    const head = await request(markdownURL, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), saved.get(markdownURL).length);

    // Publish one valid edit while an unrelated API draft remains pending.
    await save({ ...node(markdown.id), title: 'Released second guide', body: '# Second release\n' });
    await publish(markdown.id);
    assert.notEqual(state.published.id, release.id);
    const nextTree = JSON.parse((await snapshot('/content/dev/current/tree.json')).body);
    assert.ok(!nextTree.nodes.some(n => n.id === 'private-only'));
    assert.equal((await snapshot(nextTree.nodes.find(n => n.id === markdown.id).url)).body, '# Second release\n');
    assert.equal(JSON.parse((await snapshot(nextTree.nodes.find(n => n.id === apiNode.id).url)).body).paths['/persisted'].get.summary, 'Saved API');
    for (const [path, expected] of saved) assert.deepEqual(await snapshot(path), expected, `Old URL after newer publication: ${path}`);
    assert.deepEqual(await readdir(root), [], 'No content directory or generated release files were created');
    await app.stop();
  });
}
