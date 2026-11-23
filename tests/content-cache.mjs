import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createContent } from '../server/content.mjs';

const api = JSON.stringify({ openapi: '3.1.0', info: { title: 'Cache test', version: '1' },
  paths: { '/items': { get: { responses: { 200: { description: 'OK' } } } } } });
const node = (id, type, body = '') => ({ id, type, body, title: id, sort: 0, parentId: type === 'group' ? null : 'root' });
const asset = (id, type = 'md') => `${type}/${createHash('sha256').update(JSON.stringify(id)).digest('hex')}.${type === 'api' ? 'json' : 'md'}`;
const snapshot = () => ({ revision: 1, nodes: [node('root', 'group'), node('api', 'api', api),
  node('a', 'markdown', '你好'), node('b', 'markdown', '世界'), node('c', 'markdown', '测试')] });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function setup(options = {}) {
  const id = randomUUID(), saved = snapshot(), loads = [];
  let bodyReads = 0;
  Object.defineProperty(saved.nodes[1], 'body', { enumerable: true, get() { bodyReads++; return api; } });
  const content = createContent({ loadRelease: async release => { loads.push(release); return saved; }, ...options });
  return { content, saved, loads, id, bodyReads: () => bodyReads,
    read: resource => content.read(`releases/${id}/${resource}`) };
}

test('repeated and related API reads reuse one load and compilation with caller-owned buffers', async () => {
  const { read, loads, bodyReads } = setup();
  const tree = await read('tree.json');
  const reads = bodyReads();
  assert.ok(reads > 0);
  const contract = await read(asset('api', 'api'));
  assert.deepEqual(JSON.parse(contract.body), JSON.parse(api));
  assert.equal((await read('api.yaml')).body.toString(), api);
  assert.deepEqual(await read('tree.json'), tree);
  assert.equal(loads.length, 1);
  assert.equal(bodyReads(), reads, 'Cached reads must not re-enter prepare/compile');
  contract.body.fill(0);
  contract.contentType = 'corrupted';
  const fresh = await read(asset('api', 'api'));
  assert.deepEqual(JSON.parse(fresh.body), JSON.parse(api));
  assert.equal(fresh.contentType, 'application/json');
});

test('concurrent API/tree requests share load and render; each caller receives a distinct buffer', async () => {
  const gate = deferred();
  let loads = 0;
  const { read } = setup({ loadRelease: async () => { loads++; await gate.promise; return snapshot(); } });
  const requests = [read('tree.json'), read('api.yaml'), read(asset('api', 'api')), read('tree.json')];
  assert.equal(loads, 1);
  gate.resolve();
  const [tree, yaml, document, duplicate] = await Promise.all(requests);
  assert.equal(yaml.body.toString(), api);
  assert.deepEqual(JSON.parse(document.body), JSON.parse(api));
  assert.deepEqual(tree, duplicate);
  assert.notEqual(tree.body, duplicate.body);
  tree.body.fill(0);
  assert.deepEqual(await read('tree.json'), duplicate);
  assert.equal(loads, 1);
});

test('Markdown and index reads stay lazy, cache independently, and do not poison tree metadata', async () => {
  const { read, saved, loads } = setup();
  // If a lightweight read accidentally compiles the API this invalid contract fails.
  saved.nodes[1] = node('api', 'api', '[');
  assert.equal((await read(asset('a'))).body.toString(), '你好');
  assert.equal((await read(asset('a'))).contentType, 'text/markdown; charset=utf-8');
  assert.deepEqual(JSON.parse((await read('index.json')).body), { entries: [] });
  await read('index.json');
  assert.equal(loads.length, 2);
  await assert.rejects(read('tree.json'), { status: 400 });
  saved.nodes[1].body = api;
  const tree = JSON.parse((await read('tree.json')).body);
  assert.deepEqual(tree.nodes.find(row => row.id === 'api').detailRoutes, ['/api/~endpoints#get-items']);
  assert.equal(loads.length, 4);
});

test('repository failures coalesce without being cached and retry successfully', async () => {
  const gate = deferred();
  let loads = 0;
  const { read } = setup({ loadRelease: async () => {
    loads++;
    if (loads === 1) { await gate.promise; throw new Error('offline'); }
    return snapshot();
  } });
  const results = Promise.allSettled([read('tree.json'), read('api.yaml')]);
  assert.equal(loads, 1);
  gate.resolve();
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /offline/);
  }
  await read('tree.json');
  await read('api.yaml');
  assert.equal(loads, 2);
});

test('absent releases, missing resources, and invalid snapshots never populate the cache', async () => {
  let current = null, loads = 0;
  const { read } = setup({ loadRelease: async () => { loads++; return current; } });
  for (let i = 0; i < 2; i++) await assert.rejects(read('tree.json'), { status: 404 });
  assert.equal(loads, 2);
  current = snapshot();
  for (const resource of [asset('missing'), asset('missing', 'api'), 'md/badge.svg']) {
    const before = loads;
    for (let i = 0; i < 2; i++) await assert.rejects(read(resource), { status: 404 });
    assert.equal(loads - before, 2);
  }
  current.nodes[1].body = '[';
  for (let i = 0; i < 2; i++) await assert.rejects(read('tree.json'), { status: 400 });
  assert.equal(loads, 10);
  current.nodes[1].body = api;
  await read('tree.json');
  await read('tree.json');
  assert.equal(loads, 11);
});

test('entry limit evicts the least recently used entry', async () => {
  const { read, loads } = setup({ cacheMaxEntries: 2 });
  await read(asset('a'));
  await read(asset('b'));
  await read(asset('a')); // a is now most recently used.
  await read(asset('c')); // b is evicted.
  await read(asset('a'));
  assert.equal(loads.length, 3);
  await read(asset('b'));
  assert.equal(loads.length, 4);
});

test('byte limit counts UTF-8 payloads and resource names and evicts at the boundary', async () => {
  const entryBytes = Buffer.byteLength('你好') + Buffer.byteLength(asset('a'));
  const { read, loads } = setup({ cacheMaxBytes: 2 * entryBytes - 1 });
  await read(asset('a'));
  await read(asset('a'));
  assert.equal(loads.length, 1);
  await read(asset('b'));
  await read(asset('a'));
  assert.equal(loads.length, 3, 'Two entries must not fit one byte below their combined size');
  const exact = setup({ cacheMaxBytes: entryBytes });
  await exact.read(asset('a'));
  await exact.read(asset('a'));
  assert.equal(exact.loads.length, 1, 'An entry at the byte limit fits');
});

test('oversized compiled bundles are served but not retained and do not evict small entries', async () => {
  const { read, loads } = setup({ cacheMaxBytes: 100 });
  await read(asset('a'));
  await read('tree.json');
  await read('tree.json');
  await read(asset('a'));
  assert.equal(loads.length, 3);
});

test('cache is per service and release, and stage never seeds published reads', async () => {
  const { content, read, loads } = setup();
  await read('tree.json');
  const staged = await content.stage(snapshot());
  assert.equal(loads.length, 1);
  await content.read(`releases/${staged.id}/tree.json`);
  assert.equal(loads.length, 2);
  const isolated = createContent({ loadRelease: async () => null });
  await assert.rejects(isolated.read(`releases/${staged.id}/tree.json`), { status: 404 });
});

test('coalescing map has bounded entries while overflow reads still succeed', async () => {
  const gate = deferred();
  let loads = 0;
  const { read } = setup({ cacheMaxEntries: 1, loadRelease: async () => {
    loads++; await gate.promise; return snapshot();
  } });
  const requests = [read(asset('a')), read(asset('a')), read(asset('b')), read(asset('b'))];
  assert.equal(loads, 3, 'Only the first pending key is retained for coalescing');
  gate.resolve();
  const files = await Promise.all(requests);
  assert.deepEqual(files.map(file => file.body.toString()), ['你好', '你好', '世界', '世界']);
});

test('zero limits disable retention and invalid limits fail fast', async () => {
  for (const options of [{ cacheMaxEntries: 0 }, { cacheMaxBytes: 0 }]) {
    const { read, loads } = setup(options);
    await read('tree.json');
    await read('tree.json');
    assert.equal(loads.length, 2);
  }
  for (const name of ['cacheMaxEntries', 'cacheMaxBytes'])
    for (const value of [-1, 0.5, Infinity, NaN, '1'])
      assert.throws(() => createContent({ [name]: value }), TypeError);
});

test('published search reuses Markdown bytes already prepared with the release tree', async()=>{
  const {read,loads}=setup();
  await read('tree.json');
  assert.equal((await read(asset('a'))).body.toString(),'你好');
  assert.equal((await read(asset('b'))).body.toString(),'世界');
  assert.equal(loads.length,1,'Reading published documents after listing must not reload each snapshot');
});
