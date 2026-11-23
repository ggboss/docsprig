import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../server/http.mjs';
import { adminActor } from '../server/auth.mjs';

// Route inventory mirrors server/http.mjs. Authentication endpoints are covered by
// auth-http.mjs; site-name reads intentionally use the anonymous public endpoint.
const mutations = [
  { path: '/manage/node', method: 'PUT', store: 'saveNode', data: { node: { id: 'draft', type: 'markdown', title: 'Draft', body: '# Changed' } } },
  { path: '/manage/node', method: 'DELETE', store: 'deleteNode', data: { id: 'draft' }, stage: true },
  { path: '/manage/node/move', method: 'POST', store: 'moveNode', data: { id: 'draft', parentId: 'tab', beforeId: null } },
  { path: '/manage/publish', method: 'POST', store: 'publishNode', data: { id: 'draft', draftVersion: 1 }, stage: true },
  { path: '/manage/tabs', method: 'PUT', store: 'saveTabs', data: { tabs: [{ id: 'tab', title: 'Docs', sort: 0 }] } },
  { path: '/manage/tabs', method: 'DELETE', store: 'deleteTab', data: { id: 'tab' }, stage: true },
  { path: '/manage/tabs/publish', method: 'POST', store: 'publishTabs', data: {}, stage: true },
  { path: '/manage/site-name', method: 'PUT', store: 'setSiteName', data: { name: 'New title' }, setting: true },
];
const methodsByPath = {
  '/manage/workspace': ['GET'], '/manage/preview': ['GET'], '/manage/session': ['GET'],
  '/manage/node': ['PUT', 'DELETE'], '/manage/node/move': ['POST'], '/manage/publish': ['POST'],
  '/manage/tabs': ['PUT', 'DELETE'], '/manage/tabs/publish': ['POST'], '/manage/site-name': ['PUT'],
  '/content/site-name.json': ['GET'],
};
const failure = (status, message) => Object.assign(new Error(message), { status });

test('administrator CRUD HTTP matrix uses real sessions and an isolated memory store spy', async t => {
  const env = ['DOCS_ADMIN_USERNAME', 'DOCS_ADMIN_PASSWORD'];
  const previous = env.map(name => process.env[name]);
  process.env.DOCS_ADMIN_USERNAME = 'http-admin'; process.env.DOCS_ADMIN_PASSWORD = 'memory-only-password';
  t.after(() => env.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  const origin = 'https://docs.example.invalid';
  const contract = { openapi: '3.1.0', info: { title: 'Private preview', version: '1' }, paths: { '/draft': { get: { responses: { 200: { description: 'OK' } } } } } };
  const initial = { revision: 7, nodes: [
    { id: 'draft', type: 'markdown', title: 'Private draft', body: 'PRIVATE DRAFT' },
    { id: 'api', type: 'api', title: 'API', body: JSON.stringify(contract) },
    { id: 'invalid', type: 'api', body: 'broken: [' },
  ], published: { id: 'fixture-published', revision: 6 }, tabs: [{ id: 'tab', title: 'Docs', sort: 0 }] };
  let state = structuredClone(initial), site = { name: 'Original title' }, injectedFailure;
  const calls = [], stages = [];
  const store = {
    read: async () => { calls.push(['read']); return structuredClone(state); },
    siteName: async () => { calls.push(['siteName']); return structuredClone(site); },
  };
  // Deliberately a spy, not a replacement store implementation. Domain errors are
  // injected before mutation to test HTTP error propagation and retry safety.
  for (const route of mutations) store[route.store] = async (...args) => {
    calls.push([route.store, ...args.filter(arg => typeof arg !== 'function')]);
    if (injectedFailure) throw failure(injectedFailure, `保留原状态 ${injectedFailure}`);
    if (route.setting) { site = { name: args[0] }; return structuredClone(site); }
    if (args[0] !== state.revision) throw failure(409, '草稿版本冲突，请重新读取');
    const next = { ...structuredClone(state), revision: state.revision + 1 };
    if (route.stage) {
      const stage = args.at(-1);
      assert.equal(typeof stage, 'function');
      next.published = await stage(next);
    }
    state = next;
    return structuredClone(state);
  };
  let cookie;
  const server = createServer(handler({ origin, authenticate: adminActor, store, content: {
    // No real content generation, release persistence, filesystem or network.
    stage: snapshot => { stages.push(structuredClone(snapshot)); return { id: 'memory-release', revision: snapshot.revision }; },
    read: () => assert.fail('Management tests must not read release artifacts'),
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { if (cookie) await request('/manage/logout', { method: 'POST', cookie, headers: { origin } }); }
    finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', cookie, body, raw, headers = {} } = {}) {
    const res = await fetch(base + path, { method, redirect: 'error', headers: {
      ...(cookie ? { cookie } : {}), ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
    }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  const login = await request('/manage/login', { method: 'POST', headers: { origin }, body: { username: 'http-admin', password: 'memory-only-password' } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /; Secure$/);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const payload = route => route.setting ? structuredClone(route.data) : { revision: state.revision, ...structuredClone(route.data) };
  const write = (route, options = {}) => request(route.path, { method: route.method, cookie, headers: { origin }, body: payload(route), ...options });
  const snapshot = () => structuredClone({ state, site, stages });
  function assertError(result, status) {
    assert.equal(result.status, status);
    assert.equal(typeof result.body.error, 'string');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('set-cookie'), null);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE DRAFT|memory-only-password/);
  }

  await t.test('all mutation routes deny anonymous access before reading or changing storage', async () => {
    for (const route of mutations) {
      const before = snapshot(); const count = calls.length;
      assertError(await write(route, { cookie: undefined }), 401);
      assert.equal(calls.length, count); assert.deepEqual(snapshot(), before);
    }
  });

  await t.test('authenticated session/workspace/preview and anonymous site-name reads are read-only', async () => {
    const before = snapshot();
    assert.deepEqual((await request('/manage/session', { cookie })).body, { admin: true });
    assert.deepEqual((await request('/manage/workspace', { cookie })).body, state);
    assert.deepEqual((await request('/manage/preview?doc=api&v=0', { cookie })).body, contract);
    assert.deepEqual((await request('/content/site-name.json')).body, site);
    assert.deepEqual(snapshot(), before);
    assertError(await request('/manage/site-name', { cookie }), 405);
  });

  await t.test('every route rejects unsupported methods before store access', async () => {
    for (const [path, allowed] of Object.entries(methodsByPath)) for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      if (allowed.includes(method)) continue;
      const count = calls.length, before = snapshot();
      const result = await request(path, { method, cookie, headers: { origin } });
      assert.equal(result.status, 405, `${method} ${path}`);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(calls.length, count); assert.deepEqual(snapshot(), before);
    }
  });

  await t.test('all authenticated mutations reject CSRF and retain session, draft and published state', async () => {
    for (const route of mutations) for (const headers of [{}, { origin: 'null' }, { origin: 'https://evil.invalid' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
      const count = calls.length, before = snapshot();
      assertError(await write(route, { headers }), 403);
      assert.equal(calls.length, count); assert.deepEqual(snapshot(), before);
    }
    assert.equal((await request('/manage/session', { cookie })).status, 200);
  });

  await t.test('all mutation parsers reject malformed JSON, media types and invalid revisions without dispatch', async () => {
    for (const route of mutations) {
      const cases = [
        { raw: '{', expected: 400 },
        { headers: { origin, 'content-type': 'text/plain' }, expected: 415 },
        ...[null, [], {}, 1, 'bad'].map(body => ({ body, expected: 400 })),
        ...(!route.setting ? [-1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, null].map(revision => ({ body: { ...payload(route), revision }, expected: 400 })) : []),
      ];
      for (const { expected, ...options } of cases) {
        const count = calls.length, before = snapshot();
        assertError(await write(route, options), expected);
        assert.equal(calls.length, count, `${route.method} ${route.path} invalid payload dispatched`);
        assert.deepEqual(snapshot(), before);
      }
    }
  });

  await t.test('route-specific invalid payloads are rejected before a mutation callback', async () => {
    const cases = [
      [0, { node: null }], [0, { node: [] }], [0, { nodes: [] }],
      [1, { id: '../draft' }], [1, { id: '' }], [1, { id: 'draft', extra: true }],
      [2, { id: 'draft', parentId: null, beforeId: null }],
      [2, { id: 'draft', parentId: 'tab' }],
      [2, { id: 'draft', parentId: 'tab', beforeId: '../bad' }],
      [2, { id: 'draft', parentId: 'tab', beforeId: null, extra: true }],
      [3, { id: 'draft', draftVersion: 0 }], [3, { id: 'draft', draftVersion: '1' }], [3, { id: '../draft', draftVersion: 1 }],
      [4, { tabs: [], extra: true }], [5, { id: '' }], [5, { id: 'tab', extra: true }], [6, { extra: true }],
      [7, { name: 1 }], [7, { name: 'Title', extra: true }],
    ];
    for (const [index, data] of cases) {
      const route = mutations[index], count = calls.length, before = snapshot();
      assertError(await write(route, { body: { ...(route.setting ? {} : { revision: state.revision }), ...data } }), 400);
      assert.equal(calls.length, count); assert.deepEqual(snapshot(), before);
    }
    for (const [index, size] of [[0, 4 * 1024 * 1024 + 1], [7, 4097]]) {
      const count = calls.length;
      assertError(await write(mutations[index], { raw: 'x'.repeat(size) }), 413);
      assert.equal(calls.length, count);
    }
  });

  await t.test('preview validates query and draft content without mutation or staging', async () => {
    const before = snapshot();
    for (const query of ['', '?doc=', '?doc=api&doc=api', '?doc=../api', '?doc=api&extra=1', '?doc=api&v=-1', '?doc=api&v=1&v=2']) {
      const count = calls.length;
      assertError(await request('/manage/preview' + query, { cookie }), 400);
      assert.equal(calls.length, count);
    }
    for (const [id, status] of [['missing', 404], ['draft', 400], ['invalid', 422]])
      assertError(await request('/manage/preview?doc=' + id, { cookie }), status);
    assert.deepEqual(snapshot(), before);
  });

  await t.test('store 409/422 failures propagate without altering state, staging or revoking the session', async () => {
    for (const route of mutations) for (const status of [409, 422]) {
      const before = snapshot(), count = calls.length;
      injectedFailure = status;
      try {
        const result = await write(route);
        assertError(result, status); assert.equal(result.body.error, `保留原状态 ${status}`);
        assert.equal(calls.length, count + 1); assert.equal(calls.at(-1)[0], route.store);
        assert.deepEqual(snapshot(), before);
      } finally { injectedFailure = undefined; }
      assert.equal((await request('/manage/session', { cookie })).status, 200);
    }
  });

  await t.test('every allowed mutation dispatches exact arguments and real actor; staged callbacks remain memory-only', async () => {
    for (const route of mutations) {
      const data = payload(route), count = calls.length, stageCount = stages.length;
      const result = await write(route);
      assert.equal(result.status, 200, `${route.method} ${route.path}`);
      assert.equal(calls.length, count + 1);
      const expected = {
        saveNode: [data.revision, data.node, 'standalone:http-admin'],
        deleteNode: [data.revision, data.id, 'standalone:http-admin'],
        moveNode: [data.revision, data.id, data.parentId, data.beforeId, 'standalone:http-admin'],
        publishNode: [data.revision, data.id, data.draftVersion, 'standalone:http-admin'],
        saveTabs: [data.revision, data.tabs, 'standalone:http-admin'],
        deleteTab: [data.revision, data.id, 'standalone:http-admin'],
        publishTabs: [data.revision, 'standalone:http-admin'], setSiteName: [data.name],
      }[route.store];
      assert.deepEqual(calls.at(-1), [route.store, ...expected]);
      assert.equal(stages.length, stageCount + (route.stage ? 1 : 0));
      assert.deepEqual(result.body, route.setting ? site : state);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual((await request('/content/site-name.json')).body, { name: 'New title' });
    const before = snapshot();
    assertError(await write(mutations[0], { body: { revision: initial.revision, ...mutations[0].data } }), 409);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual((await request('/manage/workspace', { cookie })).body, state);
  });
});
