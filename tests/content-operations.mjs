import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { createContent, validateApiDraft } from '../server/content.mjs';

const root = { id: 'root', parentId: null, type: 'group', title: 'API', sort: 0, body: '' };
const ok = { responses: { 200: { description: 'OK' } } };
const document = (path = '/one', operation = ok, extra = {}) => ({
  openapi: '3.1.0', 'x-open-docs-document-kind': 'operation', info: { title: path, version: '1' },
  paths: { [path]: { get: structuredClone(operation) } }, ...extra,
});
const row = (value, i) => ({ id: `api-${i}`, parentId: root.id, type: 'api', title: `API ${i}`, sort: i, body: JSON.stringify(value) });
async function publish(values) {
  const snapshot = { nodes: [root, ...values.map(row)], revision: 1 };
  const registry = new Map();
  const service = createContent({ loadRelease: async id => registry.get(id) ?? null });
  const { id } = await service.stage(snapshot);
  registry.set(id, snapshot);
  const read = async path => (await service.read(`releases/${id}/${path}`)).body;
  const tree = JSON.parse(await read('tree.json'));
  const documents = await Promise.all(tree.nodes.filter(n => n.type === 'api').map(async n =>
    JSON.parse((await service.read(n.url.slice('/content/dev/'.length))).body)));
  return { api: parse((await read('api.yaml')).toString()), documents, tree };
}

test('multiple marked documents publish standalone with exact metadata and 3.1 schema semantics', async () => {
  const first = document('/one', { ...ok, operationId: 'one', tags: ['First'] }, {
    info: { title: 'First', version: '2', summary: 'Own summary', license: { name: 'MIT', identifier: 'MIT' } },
    components: { schemas: { Value: { type: ['string', 'null'], const: 'ok' }, Never: false } },
    tags: [{ name: 'First', description: 'First tag' }],
    externalDocs: { url: 'https://example.invalid/docs' }, 'x-owner': { team: 'docs' },
  });
  const second = document('/two', { ...ok, operationId: 'two' }, {
    components: { schemas: { Other: { type: 'number', exclusiveMinimum: 0 } } },
  });
  const { api, documents, tree } = await publish([first, second]);
  assert.deepEqual(documents, [first, second]);
  assert.equal(api.openapi, '3.1.0');
  assert.deepEqual(api.components.schemas, { ...first.components.schemas, ...second.components.schemas });
  assert.deepEqual(api.tags, first.tags);
  assert.deepEqual(api.externalDocs, first.externalDocs);
  assert.deepEqual(api['x-owner'], first['x-owner']);
  assert.equal(api['x-open-docs-document-kind'], undefined);
  assert.deepEqual(Object.keys(api.paths), ['/one', '/two']);
  assert.deepEqual(tree.nodes[1].detailRoutes, ['/api/first#one']);
});

test('marked documents scope default auth and servers without inheriting a base or sibling settings', async () => {
  const base = { openapi: '3.1.0', info: { title: 'Base', version: '1' },
    servers: [{ url: 'https://base.invalid' }], security: [{ token: [] }],
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } }, paths: { '/base': { get: ok } } };
  const own = document('/own', ok, { servers: [{ url: 'https://own.invalid' }], security: [{ token: [] }], components: base.components });
  const plain = document('/plain');
  const override = document('/override', { ...ok, security: [], servers: [{ url: 'https://operation.invalid' }] },
    { security: [{ token: [] }], components: base.components, servers: [{ url: 'https://document.invalid' }] });
  const pathServer = document('/path');
  pathServer.paths['/path'].servers = [{ url: 'https://path.invalid' }];
  const legacy = { path: '/legacy', method: 'POST', operation: ok };
  const { api, documents } = await publish([base, own, plain, override, pathServer, legacy]);
  assert.deepEqual(documents.slice(0, 5), [base, own, plain, override, pathServer]);
  assert.deepEqual(api.info, base.info);
  assert.deepEqual(api.paths['/own'].get.servers, own.servers);
  assert.deepEqual(api.paths['/own'].get.security, own.security);
  assert.deepEqual(api.paths['/plain'].get.security, []);
  assert.deepEqual(api.paths['/plain'].get.servers, [{ url: '/' }]);
  assert.deepEqual(api.paths['/override'].get, override.paths['/override'].get);
  assert.deepEqual(api.paths['/path'].get.servers, pathServer.paths['/path'].servers);
  assert.deepEqual(documents[5].security, base.security);
  assert.deepEqual(documents[5].servers, base.servers);
});

test('save validation rejects invalid marked documents and publication cannot repair missing references', async () => {
  const invalid = [
    document('/one', ok, { openapi: '3.0.3' }),
    document('/one', ok, { 'x-open-docs-document-kind': 'unknown' }),
    document('/one', ok, { paths: {} }),
    document('/one', ok, { paths: { '/one': { get: ok, post: ok } } }),
    document('/one', ok, { paths: { '/one': { get: ok }, '/two': { get: ok } } }),
    document('/one', ok, { webhooks: { callback: { post: ok } } }),
    document('/one', { responses: { 200: { $ref: '#/components/responses/Missing' } } }),
    document('/one/{id}'),
    document('/one', { ...ok, callbacks: { notify: { '{$request.body#/url}': { post: ok } } } }),
    document('/one', ok, { components: { pathItems: { Callback: { post: ok } } } }),
    document('/one', ok, { components: { schemas: { Bad: { $id: 'https://example.invalid/schema' } } } }),
    document('/one', ok, { paths: { '/one': { $ref: '#/components/pathItems/One' } }, components: { pathItems: { One: { get: ok } } } }),
    document('/one', { responses: { 200: { description: 'OK', links: { bad: { operationId: 'missing' } } } } }),
  ];
  for (const value of invalid) {
    assert.throws(() => validateApiDraft(JSON.stringify(value)), { status: 400 });
    await assert.rejects(publish([value]), { status: 400 });
  }
  for (const body of ['null', '[]', '[', 'openapi: 3.1.0\nopenapi: 3.1.0'])
    assert.throws(() => validateApiDraft(body), { status: 400 });
  const missing = invalid[6];
  const donor = document('/donor', ok, { components: { responses: { Missing: { description: 'Donated' } } } });
  await assert.rejects(publish([donor, missing]), /Unresolved OpenAPI reference/);
});

test('nonmergeable metadata and 3.0 bases fail explicitly instead of silently changing semantics', async () => {
  const schema = type => ({ schemas: { Shared: { type } } });
  const one = document('/one', ok, { components: schema('string') });
  const two = document('/two', ok, { components: schema('number') });
  await assert.rejects(publish([one, two]), /Conflicting component schemas: Shared/);
  for (const [key, left, right] of [
    ['x-owner', 'one', 'two'], ['externalDocs', { url: 'https://one.invalid' }, { url: 'https://two.invalid' }],
    ['tags', [{ name: 'Shared', description: 'one' }], [{ name: 'Shared', description: 'two' }]],
  ]) await assert.rejects(publish([document('/one', ok, { [key]: left }), document('/two', ok, { [key]: right })]), /Conflicting/);
  await assert.rejects(publish([document('/one', ok, { jsonSchemaDialect: 'https://example.invalid/dialect' })]), /jsonSchemaDialect/);
  const base = { openapi: '3.0.3', info: { title: 'Base', version: '1' }, paths: {} };
  await assert.rejects(publish([base, document()]), { status: 422, message: /OpenAPI 3\.0 基础契约.*完整迁移.*不要只修改版本号/ });
  const same = document('/one', { ...ok, operationId: 'duplicate' });
  await assert.rejects(publish([same, document('/two', { ...ok, operationId: 'duplicate' })]), /Duplicate operationId/);
  await assert.rejects(publish([document(), document()]), /Conflicting operation/);
});

test('unmarked one-operation full contracts remain bases and legacy fragments inherit them', async () => {
  const base = document('/base', ok, { components: { responses: { Shared: { description: 'OK' } } } });
  delete base['x-open-docs-document-kind'];
  const legacy = { path: '/legacy', method: 'GET', operation: { responses: { 200: { $ref: '#/components/responses/Shared' } } } };
  validateApiDraft(JSON.stringify(legacy), [row(base, 0)]);
  const { api, documents } = await publish([base, legacy]);
  assert.deepEqual(documents[0], base);
  assert.deepEqual(documents[1].components, base.components);
  assert.deepEqual(Object.keys(api.paths), ['/base', '/legacy']);
  await assert.rejects(publish([base, base]), /at most one base contract/);
});


test('shared paths require compatible context regardless of node order', async () => {
  const first = document('/same');
  first.paths['/same'].parameters = [{ name: 'filter', in: 'query', schema: { type: 'string' } }];
  first.paths['/same'].summary = 'Shared summary';
  first.paths['/same']['x-path'] = 'preserved';
  const second = document('/same', ok, { paths: { '/same': { ...first.paths['/same'], get: undefined, post: ok } } });
  delete second.paths['/same'].get;
  const { api, documents } = await publish([first, second]);
  assert.deepEqual(documents, [first, second]);
  assert.deepEqual(api.paths['/same'].parameters, first.paths['/same'].parameters);
  assert.equal(api.paths['/same']['x-path'], 'preserved');
  const legacy = { path: '/same', method: 'post', operation: ok };
  for (const pair of [[first, legacy], [legacy, first]])
    await assert.rejects(publish(pair), /Conflicting path metadata/);
  const base = { openapi: '3.1.0', info: { title: 'Base', version: '1' },
    paths: { '/same': { parameters: first.paths['/same'].parameters } } };
  await assert.rejects(publish([base, document('/same')]), /Conflicting path metadata/);
});


test('an existing marked operation cannot lose or change its document kind on save', () => {
  const original = document();
  const previousBody = JSON.stringify(original);
  const unmarked = { ...original };
  delete unmarked['x-open-docs-document-kind'];
  for (const replacement of [unmarked, { ...original, 'x-open-docs-document-kind': 'base' },
    { ...original, 'x-open-docs-document-kind': null }, { path: '/one', method: 'get', operation: ok }]) {
    assert.throws(() => validateApiDraft(JSON.stringify(replacement), [], previousBody),
      { status: 422, message: /请保留 x-open-docs-document-kind: operation 标记/ });
  }
  validateApiDraft(JSON.stringify({ ...original, info: { title: 'Edited', version: '2' } }), [], previousBody);
  validateApiDraft(JSON.stringify(unmarked)); // New, explicitly unmarked base remains supported.
  validateApiDraft(previousBody, [], JSON.stringify(unmarked)); // Explicit conversion to standalone is allowed.
  validateApiDraft(previousBody, [], '['); // A legacy unfinished draft can be repaired.
});
