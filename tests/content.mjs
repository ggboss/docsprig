import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { validate } from '@scalar/openapi-validator';
import { createContent } from '../server/content.mjs';

const api = `openapi: 3.1.0
info: {title: Docs, version: '1'}
paths:
  /items:
    get: {responses: {'200': {$ref: '#/components/responses/Ok'}}}
    post: {responses: {'201': {description: Created}}}
components: {responses: {Ok: {description: OK}}}
`;
const node = (id, type, parentId, sort, body = '') => ({ id, type, parentId, sort, title: id, body });
const nodes = [node('api','api','server-api',1,api), node('log','markdown','year',0,'![标识](./badge.svg)'),
  node('year','group','changelog',2), node('changelog','group',null,1), node('server-api','group',null,0),
  node('../../related','markdown','server-api',2,'Related'), node('first','markdown','changelog',0,'First')];
function setup() {
  const releases = new Map(), loads = [];
  const loadRelease = async id => {
    loads.push(id);
    return releases.get(id) ?? null;
  };
  const content = createContent({ loadRelease });
  const publish = async snapshot => {
    const release = await content.stage(snapshot);
    releases.set(release.id, structuredClone(snapshot));
    return release;
  };
  return { content, publish, releases, loads, loadRelease };
}

test('published snapshots retain flat navigation, release URLs, files and MIME types', async () => {
  const { content, publish } = setup();
  const a = await publish({ nodes, revision: 4 });
  const b = await publish({ nodes: nodes.filter(n => !['log','first'].includes(n.id)), revision: 4 });
  assert.notEqual(a.id, b.id); assert.equal(a.revision, 4);
  const read = key => content.read(`releases/${a.id}/${key}`);
  assert.equal((await read('api.yaml')).contentType, 'application/yaml');
  assert.equal((await read('tree.json')).contentType, 'application/json');
  assert.equal((await read('index.json')).contentType, 'application/json');
  const { nodes: flat } = JSON.parse((await read('tree.json')).body);
  assert.deepEqual(flat.map(n => n.id), ['server-api','api','../../related','changelog','first','year','log']);
  for (const item of flat) {
    assert.equal(item.parentId, nodes.find(n => n.id === item.id).parentId);
    assert.ok(!('body' in item) && !('children' in item));
    if (item.type === 'group') continue;
    assert.ok(item.url.startsWith(`/content/dev/releases/${a.id}/`));
    const obj = await content.read(item.url.slice('/content/dev/'.length));
    assert.ok(Buffer.isBuffer(obj.body));
    if (item.type === 'api') assert.deepEqual(JSON.parse(obj.body), parse(nodes.find(n => n.id === item.id).body));
    else assert.equal(obj.body.toString(), nodes.find(n => n.id === item.id).body);
    assert.equal(obj.contentType, item.type === 'api' ? 'application/json' : 'text/markdown; charset=utf-8');
    assert.match(item.url, item.type === 'api' ? /\/api\/[0-9a-f]{64}\.json$/ : /\/md\/[0-9a-f]{64}\.md$/);
  }
  const { entries } = JSON.parse((await read('index.json')).body);
  assert.deepEqual(entries, flat.filter(n => ['first','log'].includes(n.id)).map(n => ({ title: n.title, markdown: n.url })));
  const badgeURL = new URL('./badge.svg', new URL(entries[1].markdown,'https://portal.invalid'));
  assert.equal((await content.read(badgeURL.pathname.slice('/content/dev/'.length))).contentType, 'image/svg+xml');
  assert.deepEqual(JSON.parse((await content.read(`releases/${b.id}/index.json`)).body), { entries: [] });
});

test('full contract and Unicode markdown retain original bytes and the relative bundled badge', async () => {
  const { content, publish } = setup();
  const spec = api.replace('title: Docs', 'title: 文档').replace('get: {responses:', "get: {tags: [用户服务], summary: 查询用户信息, responses:");
  const notes = '## 发布记录\r\n\r\n![演示版本标识](./badge.svg)\r\n';
  const { id } = await publish({ revision: 0, nodes: nodes.map(n => n.id === 'api' ? { ...n, body: spec }
    : n.id === 'log' ? { ...n, body: notes } : n) });
  const read = async key => (await content.read(`releases/${id}/${key}`)).body;
  assert.deepEqual(await read('api.yaml'), Buffer.from(spec));
  const tree = JSON.parse(await read('tree.json')).nodes;
  assert.deepEqual(tree.find(n => n.id === 'api').detailRoutes, ['/api/用户服务#查询用户信息', '/api/~endpoints#post-items']);
  assert.deepEqual((await content.read(tree.find(n => n.id === 'log').url.slice('/content/dev/'.length))).body, Buffer.from(notes));
  assert.match((await read('md/badge.svg')).toString(), /<svg\b/);
});

test('invalid contracts and invalid hierarchies fail without publishing or loading releases', async () => {
  const { content, releases, loads } = setup();
  for (const bad of ['[', 'openapi: 2.0', api.replace('paths:', 'paths: []\nother:'), api.replace('{description: Created}', 'false'),
    api.replace('#/components/responses/Ok','../other.yaml#/Ok'), api.replace('#/components/responses/Ok','https://example.invalid/api'),
    api.replace('#/components/responses/Ok','#/missing')]) {
    await assert.rejects(content.stage({ revision: 1, nodes: [{ ...nodes[0], body: bad }, ...nodes.slice(1)] }), { status: 400 });
  }
  for (const invalid of [nodes.filter(n => n.id !== 'server-api'), [...nodes, node('other','api','server-api',2,api)], [...nodes, nodes[0]],
    nodes.map(n => n.id === 'year' ? { ...n, parentId: 'year' } : n),
    [...nodes, node('orphan','markdown','missing',0)]]) await assert.rejects(content.stage({ nodes: invalid, revision: 1 }), { status: 400 });
  assert.equal(releases.size, 0);
  assert.deepEqual(loads, []);
});

test('stage validates and returns only release metadata without making content readable', async () => {
  const { content, releases, loads } = setup();
  const snapshot = { nodes: structuredClone(nodes), revision: 7 };
  const original = structuredClone(snapshot);
  const a = await content.stage(snapshot);
  const b = await content.stage(snapshot);
  assert.deepEqual(Object.keys(a).sort(), ['id', 'revision']);
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a.revision, 7);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(snapshot, original);
  assert.equal(releases.size, 0);
  assert.deepEqual(loads, []);
  await assert.rejects(content.read(`releases/${a.id}/tree.json`), { status: 404 });
  assert.deepEqual(loads, [a.id]);
  const standalone = await createContent().stage(snapshot);
  assert.deepEqual(Object.keys(standalone).sort(), ['id', 'revision']);
  assert.equal(standalone.revision, 7);
});

test('canonical keys reject traversal and malformed paths before loading any release', async () => {
  const { content, publish, loads } = setup();
  const { id } = await publish({ nodes, revision: 1 });
  const prefix = `releases/${id}/`;
  for (const key of [null, undefined, 1, {}, '../secret', '/etc/passwd', 'current/api.yaml',
    `releases/not-a-uuid/api.yaml`, `releases/${id.toUpperCase()}/api.yaml`,
    `${prefix}../api.yaml`, `${prefix}%2e%2e/api.yaml`, `${prefix}md/../../api.yaml`,
    `${prefix}md\\other.md`, `${prefix}api.yaml\n`, `${prefix}api.yaml?x`, `${prefix}api.yaml\0`,
    `${prefix}api.yaml#fragment`, `${prefix}/api.yaml`, `${prefix}./api.yaml`,
    `${prefix}md/%2fetc%2fpasswd`, `${prefix}md/${'a'.repeat(64)}.md/extra`])
    await assert.rejects(content.read(key), { status: 404 }, String(key));
  assert.deepEqual(loads, []);
});

test('unknown releases and missing assets return 404, including absent badges', async () => {
  const { content, publish } = setup();
  const { id } = await publish({ nodes: nodes.filter(n => n.id !== 'log'), revision: 1 });
  for (const key of [`releases/${randomUUID()}/tree.json`, `releases/${id}/unknown.json`,
    `releases/${id}/md/${'0'.repeat(64)}.md`, `releases/${id}/api/${'0'.repeat(64)}.json`,
    `releases/${id}/md/badge.svg`])
    await assert.rejects(content.read(key), { status: 404 }, key);
});

test('draft edits and later releases preserve all old bytes, including after service recreation', async () => {
  const { content, publish, releases, loadRelease } = setup();
  const draft = { nodes: structuredClone(nodes), revision: 1 };
  const old = await publish(draft);
  const prefix = `releases/${old.id}/`;
  const manifest = JSON.parse((await content.read(prefix + 'tree.json')).body);
  const keys = ['api.yaml', 'tree.json', 'index.json', 'md/badge.svg',
    ...manifest.nodes.filter(n => n.url).map(n => n.url.slice(`/content/dev/${prefix}`.length))];
  const before = new Map();
  for (const key of keys) {
    const file = await content.read(prefix + key);
    before.set(key, { body: Buffer.from(file.body), contentType: file.contentType });
  }
  const saved = structuredClone(releases.get(old.id));
  draft.nodes.find(n => n.id === 'api').body = api.replace('title: Docs', 'title: Draft');
  draft.nodes.find(n => n.id === 'log').body = 'Unpublished draft';
  draft.nodes.push(node('private', 'markdown', 'changelog', 4, 'Draft only'));
  draft.revision = 2;
  const staged = await content.stage(draft);
  await assert.rejects(content.read(`releases/${staged.id}/tree.json`), { status: 404 });
  for (const [key, file] of before) assert.deepEqual(await content.read(prefix + key), file);
  const next = await publish(draft);
  assert.notEqual(next.id, old.id);
  assert.match((await content.read(`releases/${next.id}/api.yaml`)).body.toString(), /title: Draft/);
  const recreated = createContent({ loadRelease });
  for (const [key, file] of before) assert.deepEqual(await recreated.read(prefix + key), file);
  assert.deepEqual(releases.get(old.id), saved, 'Rendering must not mutate the published snapshot');
  // Returned buffers belong to the caller; corrupting one must not affect future reads.
  (await content.read(prefix + 'api.yaml')).body.fill(0);
  assert.deepEqual(await content.read(prefix + 'api.yaml'), before.get('api.yaml'));
});

const leaf = (id, path, method, operation) => node(id, 'api', 'server-api', 1, JSON.stringify({ path, method, operation }));
const rootsOnly = nodes.filter(n => n.parentId === null);
const ok = { responses: { 200: { description: 'OK' } } };
async function published(publish, content, rows) {
  const { id } = await publish({ revision: 0, nodes: [...rootsOnly, ...rows] });
  const read = async key => (await content.read(`releases/${id}/${key}`)).body.toString();
  const spec = parse(await read('api.yaml'));
  assert.equal(validate(spec).valid, true);
  return { spec, rows: JSON.parse(await read('tree.json')).nodes.filter(n => n.type === 'api') };
}

test('no API leaves produces a valid empty spec', async () => {
  const { content, publish } = setup();
  const { spec, rows } = await published(publish, content, []);
  assert.deepEqual(spec.paths, {});
  assert.deepEqual(rows, []);
});

const endpointRows = [
  leaf('a-post', '/items', 'POST', { ...ok, tags: ['Café'], summary: 'See items', operationId: 'create' }),
  leaf('b-get', '/items', 'get', { ...ok, tags: ['Café', 'CAFÉ!'], summary: 'See items', operationId: 'list' }),
  leaf('c&=', '/status', 'GET', ok),
];
test('compiles leaves and maps every tag/operation anchor to its stable node (Zudoku method order)', async () => {
  const { content, publish } = setup();
  const { spec, rows } = await published(publish, content, endpointRows);
  assert.deepEqual(spec.paths['/items'].post, JSON.parse(endpointRows[0].body).operation);
  assert.deepEqual(rows.map(({ id, detailRoutes }) => [id, detailRoutes]), [
    ['a-post', ['/api/cafe#see-items-2']], ['b-get', ['/api/cafe#see-items','/api/cafe-2#see-items']],
    ['c&=', ['/api/~endpoints#get-status']],
  ]);
});

test('historical 3.0 contract supplies metadata and components to new leaves', async () => {
  const { content, publish } = setup();
  const response = { $ref: '#/components/responses/Ok' };
  const { spec, rows } = await published(publish, content, [leaf('new', '/extra', 'get', { operationId: 'readExtra', responses: { 200: response } }),
    { ...nodes[0], body: api.replace('3.1.0','3.0.3') }]);
  assert.equal(spec.openapi, '3.0.3');
  assert.deepEqual(spec.components, parse(api).components);
  assert.deepEqual(spec.paths['/extra'].get.responses['200'], response);
  assert.deepEqual(rows.find(n => n.id === 'new').detailRoutes, ['/api/~endpoints#readextra']);
  assert.equal(rows.find(n => n.id === 'api').detailRoutes.length, 2);
});

test('rejects conflicting or malformed leaves and unresolved references before publication', async () => {
  const { content, releases, loads } = setup();
  for (const rows of [
    [...endpointRows, leaf('dup', '/items', 'pOsT', ok)],
    [nodes[0], endpointRows[0]],
    [...endpointRows, leaf('dup', '/other', 'post', { ...ok, operationId: 'list' })],
    [leaf('bad', 'items', 'get', ok)], [leaf('bad', '/items', 'connect', ok)], [leaf('bad', '/items', 'get', [])],
    [leaf('bad', '/items/{id}', 'get', ok)],
    ...['#/missing','file.yaml#/x','#/%zz','#/~3'].map($ref => [leaf('bad','/items','get', { responses: { 200: { $ref } } })]),
    [node('bad','api','server-api',0,'path: /one\npath: /two\nmethod: get\noperation: {}')],
  ]) await assert.rejects(content.stage({ revision: 1, nodes: [...rootsOnly, ...rows] }), { status: 400 });
  assert.equal(releases.size, 0);
  assert.deepEqual(loads, []);
});

test('checks callback operation IDs and Link targets without interpreting example data as operations', async () => {
  const { content, publish, releases, loads } = setup();
  const op = { ...ok, operationId: 'read', callbacks: { notify: { '{$request.body#/url}': { post: { ...ok, operationId: 'read' } } } } };
  const run = op => published(publish, content, [leaf('example', '/example', 'get', op)]);
  await assert.rejects(run(op), /Duplicate operationId/);
  for (const link of [{ operationId: 'missing' }, { operationRef: '#/info' }]) {
    await assert.rejects(run({ responses: { 200: { description: 'OK', links: { next: link } } } }), { status: 400 });
  }
  assert.equal(releases.size, 0);
  assert.deepEqual(loads, []);
  op.callbacks.notify['{$request.body#/url}'].post.operationId = 'received';
  op.responses = { 200: { description: 'OK', links: { next: { operationId: 'received' } } } };
  op['x-example'] = { operationId: 'received' };
  await run(op);
});

// Public navigation and read-only behavior are covered on the built site by browser-smoke.mjs.
test('dynamic roots sort freely and API nodes publish separate contracts in any branch', async () => {
  const { content, publish } = setup();
  const shared = {
    openapi: '3.1.0', info: { title: 'Shared', version: '1' },
    servers: [{ url: 'https://api.example.invalid' }], security: [{ bearer: [] }],
    components: { schemas: { Item: { type: 'object', properties: { id: { type: 'string' } } } },
      responses: { Item: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths: { '/items': { summary: 'Shared path context', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      post: { responses: { 201: { description: 'Created' } } } } },
  };
  const selected = { path: '/items', method: 'get', operation: { responses: { 200: { $ref: '#/components/responses/Item' } } } };
  const rows = [node('custom-z', 'group', null, 0), node('custom-a', 'group', null, 0),
    node('old', 'group', null, 8), node('base', 'api', 'custom-z', 0, JSON.stringify(shared)),
    node('selected', 'api', 'custom-a', 0, JSON.stringify(selected)),
    node('other', 'api', 'old', 0, JSON.stringify({ path: '/unrelated', method: 'get', operation: ok }))];
  const { id } = await publish({ nodes: rows, revision: 8 });
  const manifest = JSON.parse((await content.read(`releases/${id}/tree.json`)).body);
  assert.deepEqual(manifest.roots, ['custom-a', 'custom-z', 'old']);
  assert.deepEqual(manifest.nodes.filter(n => n.parentId === null).map(n => n.id), manifest.roots);
  const apiNodes = manifest.nodes.filter(n => n.type === 'api');
  assert.equal(new Set(apiNodes.map(n => n.url)).size, 3);
  const read = async id => {
    const row = apiNodes.find(n => n.id === id);
    assert.match(row.url, /\/api\/[a-f0-9]{64}\.json$/);
    const file = await content.read(row.url.slice('/content/dev/'.length));
    assert.equal(file.contentType, 'application/json');
    return JSON.parse(file.body);
  };
  const api = await read('selected');
  assert.deepEqual(api.paths, { '/items': { summary: shared.paths['/items'].summary,
    parameters: shared.paths['/items'].parameters, get: selected.operation } });
  for (const key of ['components', 'servers', 'security', 'info']) assert.deepEqual(api[key], shared[key]);
  assert.deepEqual(await read('base'), shared, 'Full base document excludes added leaf operations');
  assert.deepEqual(Object.keys((await read('other')).paths), ['/unrelated']);
  const rootOnly = await publish({ nodes: [node('brand-new', 'group', null, 3)], revision: 0 });
  assert.deepEqual(JSON.parse((await content.read(`releases/${rootOnly.id}/tree.json`)).body).roots, ['brand-new']);
});
