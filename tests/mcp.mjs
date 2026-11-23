import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler } from '../server/mcp.mjs';
import { adminActor, createSession, destroySession, sessionCookieName } from '../server/auth.mjs';

const token = 'mcp-integration-only-token-0123456789abcdef';
const actor = 'mcp:admin';
const limit = 4 * 1024 * 1024;
const failure = (status, message) => Object.assign(new Error(message), { status });
const contract = { openapi: '3.1.0', info: { title: 'Fixture API', version: '1' }, paths: {
  '/fixture': { get: { responses: { 200: { description: 'OK' } } } },
} };
const node = (id, type, body, extra = {}) => ({ id, parentId: 'root', sort: 0, title: id,
  type, body, draftVersion: 2, publishedVersion: 1, ...extra });
const initial = () => ({ revision: 7, published: { id: 'fixture-release', revision: 6 }, nodes: [
  node('second', 'group', '', { parentId: null, sort: 1 }),
  node('root', 'group', '', { parentId: null }),
  node('draft', 'markdown', '# Private draft'),
  node('api', 'api', JSON.stringify(contract), { sort: 1 }),
  node('broken', 'api', 'broken: [', { sort: 2 }),
] });
const mutations = [
  ['docs_node_create', 'saveNode', { revision: 7, id: 'new-doc', parentId: 'root', sort: 3, title: 'New', type: 'markdown', body: '# New' }],
  ['docs_node_update', 'saveNode', { revision: 7, id: 'draft', title: 'Changed' }],
  ['docs_node_move', 'moveNode', { revision: 7, id: 'draft', parentId: 'second', beforeId: null }],
  ['docs_node_delete', 'deleteNode', { revision: 7, id: 'draft', confirm: true }],
  ['docs_node_publish', 'publishNode', { revision: 7, id: 'draft', draftVersion: 2, confirm: true }],
  ['docs_tabs_save', 'saveTabs', { revision: 7, tabs: [{ id: 'root', title: 'Docs', sort: 1 }, { id: 'second', title: 'Other', sort: 0 }] }],
  ['docs_tab_delete', 'deleteTab', { revision: 7, id: 'second', confirm: true }],
  ['docs_tabs_publish', 'publishTabs', { revision: 7, confirm: true }],
  ['docs_site_update', 'setSiteName', { name: 'Fixture site' }],
];
const reads = [
  ['docs_workspace_get', {}], ['docs_node_get', { id: 'draft' }],
  ['docs_node_preview', { id: 'api' }], ['docs_tabs_list', {}], ['docs_site_get', {}],
];
const tools = [...reads, ...mutations.map(([name, , args]) => [name, args])];
const writeMethods = new Set(mutations.map(([, method]) => method));
const stagedMethods = new Set(['deleteNode', 'publishNode', 'deleteTab', 'publishTabs']);
const metadata = ({ body, ...rest }) => rest;

// The fake models only the adapter's return values and optimistic-write boundary.
// Domain validation and publication algorithms belong to the store tests. Nothing
// here creates a database pool, content artifacts, environment settings, or files.
async function fixture(t, configuredToken = token) {
  let state = initial(), site = { name: 'Original site' }, injected;
  const calls = [], stages = [], connections = new Set();
  const store = {};
  function record(method, args) {
    calls.push([method, ...args]);
    if (injected?.method === method) throw injected.error;
  }
  store.read = async () => { record('read', []); return structuredClone(state); };
  store.readNode = async id => { record('readNode', [id]); return structuredClone(state.nodes.find(n => n.id === id) ?? null); };
  store.siteName = async () => { record('siteName', []); return structuredClone(site); };
  store.setSiteName = async name => { record('setSiteName', [name]); site = { name }; return structuredClone(site); };
  for (const method of writeMethods) {
    if (method === 'setSiteName') continue;
    store[method] = async (...args) => {
      record(method, args);
      if (args[0] !== state.revision) throw failure(409, 'Workspace revision changed');
      const next = structuredClone(state);
      if (method === 'saveNode') {
        const value = args[1], old = next.nodes.find(n => n.id === value.id);
        const saved = { ...value, draftVersion: (old?.draftVersion ?? 0) + 1, publishedVersion: old?.publishedVersion ?? null };
        next.nodes = [...next.nodes.filter(n => n.id !== value.id), saved];
      } else if (method === 'moveNode') {
        const selected = next.nodes.find(n => n.id === args[1]);
        Object.assign(selected, { parentId: args[2], draftVersion: selected.draftVersion + 1 });
      } else if (method === 'deleteNode' || method === 'deleteTab') {
        next.nodes = next.nodes.filter(n => n.id !== args[1]);
      } else if (method === 'saveTabs') {
        next.nodes = [...next.nodes.filter(n => n.parentId !== null), ...args[1].map(tab => {
          const old = state.nodes.find(n => n.id === tab.id);
          return { ...node(tab.id, 'group', '', { parentId: null }), ...old, ...tab, draftVersion: (old?.draftVersion ?? 0) + 1 };
        })];
      } else if (method === 'publishNode') {
        const selected = next.nodes.find(n => n.id === args[1]);
        if (args[2] !== selected.draftVersion) throw failure(409, 'Node draft version changed');
        selected.publishedVersion = selected.draftVersion;
      } else if (method === 'publishTabs') {
        next.nodes.filter(n => n.parentId === null).forEach(n => { n.publishedVersion = n.draftVersion; });
      }
      if (stagedMethods.has(method)) {
        assert.equal(typeof args.at(-1), 'function', `${method} needs a stage callback`);
        next.published = await args.at(-1)({ revision: state.revision, nodes: structuredClone(next.nodes) });
      }
      next.revision++;
      state = next;
      return structuredClone(state);
    };
  }
  const content = { async stage(snapshot) {
    // Also exercises callbacks that must preserve the content receiver.
    assert.equal(this, content);
    stages.push(structuredClone(snapshot));
    if (injected?.method === 'stage') throw injected.error;
    return { id: `memory-release-${stages.length}`, revision: snapshot.revision };
  } };
  let handler;
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => { res.destroy(error); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createMcpHandler({ store, content, origin, token: configuredToken });
  t.after(async () => {
    await Promise.allSettled([...connections].map(client => client.close()));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  async function connect(headers = { Authorization: `Bearer ${token}` }) {
    const client = new Client({ name: 'mcp-integration-test', version: '1.0.0' });
    connections.add(client);
    const transport = new StreamableHTTPClientTransport(new URL('/mcp/admin', origin), { requestInit: { headers } });
    await client.connect(transport, { timeout: 5000 });
    return client;
  }
  // Native HTTP permits duplicate Authorization headers and chunked payloads,
  // which fetch normalizes. Every request still goes through the real handler.
  async function request({ method = 'POST', path = '/mcp/admin', headers = {}, raw, chunks, data = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } } = {}) {
    const payload = raw ?? JSON.stringify(data);
    const requestHeaders = { Host: new URL(origin).host, Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers };
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
    if (!chunks && method === 'POST') requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const req = httpRequest(origin + path, { method, headers: requestHeaders }, res => {
        const parts = [];
        res.on('data', part => parts.push(part));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString() }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
      req.on('error', reject);
      if (chunks) for (const chunk of chunks) req.write(chunk);
      req.end(chunks || method !== 'POST' ? undefined : payload);
    });
  }
  return { origin, connect, request, calls, stages, store, content,
    snapshot: () => structuredClone({ state, site }),
    inject: (method, error) => { injected = error ? { method, error } : undefined; },
    writes: () => calls.filter(([method]) => writeMethods.has(method)),
  };
}
async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
}
function success(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(typeof result.structuredContent, 'object');
  assert.notEqual(result.structuredContent, null);
  assert.deepEqual(JSON.parse(result.content.find(part => part.type === 'text').text), result.structuredContent);
  return result.structuredContent;
}
function toolError(result, status) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.error?.status, status, JSON.stringify(result));
  assert.equal(typeof result.structuredContent.error.message, 'string');
  assert.ok(result.structuredContent.error.message.length);
  assert.deepEqual(Object.keys(result.structuredContent), ['error']);
  assert.deepEqual(Object.keys(result.structuredContent.error).sort(), ['message', 'status']);
  assert.deepEqual(JSON.parse(result.content.find(part => part.type === 'text').text), result.structuredContent);
}
function httpError(result, status) {
  assert.equal(result.status, status, result.text);
  assert.equal(typeof JSON.parse(result.text).error, 'string');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.doesNotMatch(result.text, /Private draft|mcp-integration-only-token/);
}

test('MCP real SDK handshake and exact tool discovery', async t => {
  const f = await fixture(t), client = await f.connect();
  assert.ok(client.getServerVersion()?.name);
  assert.ok(client.getServerCapabilities()?.tools);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), tools.map(([name]) => name).sort());
  assert.equal(listed.nextCursor, undefined);
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.description?.length, tool.name);
    assert.equal(tool.annotations?.readOnlyHint, reads.some(([name]) => name === tool.name), tool.name);
    assert.equal(tool.annotations?.openWorldHint, false, tool.name);
  }
  assert.equal(listed.tools.find(tool => tool.name === 'docs_workspace_get').inputSchema.required?.includes('includeBodies') ?? false, false);
  assert.equal(f.calls.length, 0, 'handshake/discovery must not access storage');
  // Independent SDK clients can initialize and use the stateless endpoint.
  const second = await f.connect({ Authorization: `Bearer ${token}`, Origin: f.origin });
  await client.ping();
  assert.deepEqual(success(await call(second, 'docs_site_get')), { name: 'Original site' });
});

test('MCP authenticates every request independently of admin cookies and session headers', async t => {
  const f = await fixture(t);
  const key = createSession({ headers: {} }, process.env.DOCS_ADMIN_USERNAME ?? 'admin', process.env.DOCS_ADMIN_PASSWORD ?? 'admin');
  const cookie = `${sessionCookieName}=${key}`;
  t.after(() => destroySession({ headers: { cookie } }));
  assert.match(await adminActor({ headers: { cookie } }), /^standalone:/);
  for (const [name, args] of tools) {
    for (const Authorization of [undefined, 'Bearer wrong-token', `Basic ${token}`]) {
      httpError(await f.request({ headers: { Authorization, Cookie: cookie, 'Mcp-Session-Id': 'pretend-admin' },
        data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } } }), 401);
    }
  }
  for (const Authorization of [`Bearer  ${token}`, `bearer ${token}`, [`Bearer ${token}`, 'Bearer wrong-token']]) {
    httpError(await f.request({ headers: { Authorization } }), 401);
  }
  httpError(await f.request({ headers: { Authorization: `Bearer ${token}x` } }), 401);
  const denied = await f.request({ headers: { Authorization: undefined }, path: `/mcp/admin?token=${token}` });
  assert.ok([401, 404].includes(denied.status));
  // Generic and reader routes must remain unavailable, even with an admin
  // credential or a real browser administrator session.
  for (const path of ['/mcp', '/mcp/docs']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      for (const Authorization of [undefined, `Bearer ${token}`]) {
        httpError(await f.request({ path, method, headers: { Authorization, Cookie: cookie } }), 404);
      }
    }
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.stages.length, 0);
  await assert.rejects(f.connect({ Cookie: cookie }), error => error.code === 401);
  const client = await f.connect();
  success(await call(client, 'docs_site_get'));
  const count = f.calls.length;
  httpError(await f.request({ headers: { Authorization: undefined, Cookie: cookie } }), 401);
  assert.equal(f.calls.length, count, 'initialization must not grant subsequent requests access');
});

test('MCP disabled configuration and token constraints fail closed', async t => {
  // Explicit empty token disables the route regardless of the developer shell's env.
  const f = await fixture(t, '');
  for (const method of ['GET', 'POST', 'DELETE']) httpError(await f.request({ method }), 404);
  assert.equal(f.calls.length, 0);
  for (const invalid of ['x'.repeat(31), 'x'.repeat(513), 'x'.repeat(31) + ' ', 123, null]) {
    assert.throws(() => createMcpHandler({ store: f.store, content: f.content, origin: f.origin, token: invalid }), /token|32|512/i);
  }
  const enabled = await fixture(t, 'x'.repeat(32));
  const client = await enabled.connect({ Authorization: `Bearer ${'x'.repeat(32)}` });
  assert.equal((await client.listTools()).tools.length, 14);
});

test('MCP rejects foreign Host/Origin and unsupported methods before storage access', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Host: 'attacker.invalid' }, { Host: `${new URL(f.origin).host}.attacker.invalid` },
    { Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { Origin: f.origin + '/' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Host: 'attacker.invalid', 'X-Forwarded-Host': new URL(f.origin).host, 'X-Forwarded-Proto': 'http' },
    { Origin: 'https://attacker.invalid', 'X-Forwarded-Host': new URL(f.origin).host },
  ]) httpError(await f.request({ headers }), 403);
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
    const response = await f.request({ method });
    httpError(response, 405);
    assert.equal(response.headers.allow, 'POST');
  }
  for (const path of ['/mcp/admin/', '/mcp/admin?extra=1', '/other']) httpError(await f.request({ path }), 404);
  assert.equal(f.calls.length, 0);
});

test('MCP enforces JSON and 4 MiB byte limit including chunked input', async t => {
  const f = await fixture(t);
  for (const raw of ['{', '', 'not JSON']) httpError(await f.request({ raw }), 400);
  for (const value of [undefined, 'text/plain', 'application/jsonp']) {
    httpError(await f.request({ headers: { 'Content-Type': value } }), 415);
  }
  httpError(await f.request({ raw: ' '.repeat(limit + 1) }), 413);
  // Multibyte input verifies bytes, rather than JavaScript character count.
  httpError(await f.request({ chunks: ['"', '界'.repeat(Math.ceil(limit / 3)), '"'] }), 413);
  assert.equal(f.calls.length, 0);
  const json = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  for (const options of [
    { raw: json + ' '.repeat(limit - Buffer.byteLength(json)) },
    { chunks: [json.slice(0, 15), json.slice(15)] },
    { raw: json, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  ]) {
    const response = await f.request(options);
    assert.equal(response.status, 200, response.text);
    assert.equal(JSON.parse(response.text).result.tools.length, 14);
  }
  assert.equal(f.calls.length, 0);
});

test('MCP read tools and API preview return useful data without writes or publication', async t => {
  const f = await fixture(t), client = await f.connect(), before = f.snapshot();
  for (const args of [{}, { includeBodies: false }]) {
    const data = success(await call(client, 'docs_workspace_get', args));
    assert.deepEqual(data, { ...before.state, nodes: before.state.nodes.map(metadata) });
  }
  assert.deepEqual(success(await call(client, 'docs_workspace_get', { includeBodies: true })), before.state);
  assert.deepEqual(success(await call(client, 'docs_node_get', { id: 'draft' })), {
    revision: 7, published: before.state.published, node: before.state.nodes.find(n => n.id === 'draft'),
  });
  assert.deepEqual(success(await call(client, 'docs_node_preview', { id: 'api' })), { revision: 7, contract });
  toolError(await call(client, 'docs_node_get', { id: 'missing' }), 404);
  for (const [id, status] of [['missing', 404], ['draft', 400], ['broken', 422]]) toolError(await call(client, 'docs_node_preview', { id }), status);
  const tabs = success(await call(client, 'docs_tabs_list'));
  assert.deepEqual(tabs, { revision: 7, published: before.state.published,
    tabs: before.state.nodes.filter(n => n.parentId === null).sort((a, b) => a.sort - b.sort).map(metadata) });
  assert.deepEqual(success(await call(client, 'docs_site_get')), before.site);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.writes().length, 0);
  assert.equal(f.stages.length, 0);
});

test('MCP every mutation dispatches exact store arguments, audit actor and publication callback', async t => {
  for (const [name, method, args] of mutations) await t.test(name, async t => {
    const f = await fixture(t), client = await f.connect(), before = f.snapshot();
    const data = success(await call(client, name, args));
    const expected = {
      docs_node_create: [7, Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'revision')), actor],
      docs_node_update: [7, { ...before.state.nodes.find(n => n.id === 'draft'), title: 'Changed' }, actor],
      docs_node_move: [7, 'draft', 'second', null, actor], docs_node_delete: [7, 'draft', actor],
      docs_node_publish: [7, 'draft', 2, actor], docs_tabs_save: [7, args.tabs, actor],
      docs_tab_delete: [7, 'second', actor], docs_tabs_publish: [7, actor], docs_site_update: ['Fixture site'],
    }[name];
    assert.equal(f.writes().length, 1);
    const [actualMethod, ...actual] = f.writes()[0];
    assert.equal(actualMethod, method);
    if (stagedMethods.has(method)) {
      assert.equal(actual.length, expected.length + 1);
      assert.equal(typeof actual.pop(), 'function');
    }
    assert.deepEqual(actual, expected);
    assert.equal(f.stages.length, stagedMethods.has(method) ? 1 : 0);
    if (method === 'setSiteName') assert.deepEqual(data, { name: 'Fixture site' });
    else {
      assert.equal(data.revision, 8);
      assert.deepEqual(data.published, f.snapshot().state.published);
      if (['saveNode', 'moveNode', 'publishNode'].includes(method)) {
        const id = name === 'docs_node_create' ? 'new-doc' : 'draft';
        assert.deepEqual(data.node, metadata(f.snapshot().state.nodes.find(n => n.id === id)));
      }
      if (method === 'saveTabs') assert.deepEqual(data.tabs, f.snapshot().state.nodes.filter(n => n.parentId === null).map(metadata));
      assert.equal(Object.hasOwn(data, 'nodes'), false, 'mutation response must not dump every document body');
      if (!stagedMethods.has(method)) assert.deepEqual(data.published, before.state.published);
      else assert.equal(f.stages[0].revision, 7);
    }
  });
});

test('MCP creates every node type with optional IDs as drafts and updates only requested fields', async t => {
  const f = await fixture(t), client = await f.connect();
  for (const type of ['markdown', 'api', 'group']) {
    const before = f.snapshot();
    const args = { revision: before.state.revision, parentId: 'root', sort: 3, title: `New ${type}`, type,
      body: type === 'api' ? JSON.stringify(contract) : type === 'group' ? '' : '# New draft' };
    const data = success(await call(client, 'docs_node_create', args));
    assert.match(data.node.id, /^[A-Za-z0-9_-]{1,128}$/);
    assert.ok(!before.state.nodes.some(n => n.id === data.node.id));
    assert.equal(data.node.type, type);
    assert.equal(data.node.draftVersion, 1);
    assert.equal(data.node.publishedVersion, null);
    assert.deepEqual(data.published, before.state.published);
  }
  for (const changes of [{ title: 'Renamed' }, { body: '' }, { title: 'Both', body: '# Both changed' }]) {
    const before = f.snapshot(), old = before.state.nodes.find(n => n.id === 'draft');
    success(await call(client, 'docs_node_update', { revision: before.state.revision, id: 'draft', ...changes }));
    const [, revision, saved, audit] = f.writes().at(-1);
    assert.equal(revision, before.state.revision);
    assert.deepEqual(saved, { ...old, ...changes });
    assert.equal(audit, actor);
  }
  const before = f.snapshot(), count = f.writes().length;
  toolError(await call(client, 'docs_node_create', { ...mutations[0][2], revision: before.state.revision, id: 'draft' }), 409);
  toolError(await call(client, 'docs_node_update', { revision: before.state.revision, id: 'missing', body: 'No' }), 404);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.writes().length, count);
  assert.equal(f.stages.length, 0, 'create/update must never stage or publish');
});

test('MCP strict tool schemas reject unknown arguments before any storage access', async t => {
  const f = await fixture(t), client = await f.connect();
  for (const [name, args] of tools) await t.test(name, async () => {
    const count = f.calls.length;
    const response = await call(client, name, { ...args, unexpected: 'must not be stripped' });
    assert.equal(response.isError, true, JSON.stringify(response));
    assert.equal(f.calls.length, count, name);
  });
  const cases = [
    ['docs_workspace_get', { includeBodies: 'true' }],
    ['docs_node_get', { id: '../draft' }], ['docs_node_get', {}],
    ['docs_node_update', { revision: 7, id: 'draft' }],
    ['docs_node_update', { revision: 7, id: 'draft', type: 'api', body: 'x' }],
    ['docs_node_update', { revision: 7, id: 'draft', title: '' }],
    ['docs_node_update', { revision: 7, id: 'draft', body: null }],
    ['docs_node_create', { ...mutations[0][2], type: 'html' }],
    ['docs_node_create', { ...mutations[0][2], parentId: null }],
    ['docs_node_create', { ...mutations[0][2], sort: -1 }],
    ['docs_node_create', { ...mutations[0][2], sort: 2147483648 }],
    ['docs_node_create', { ...mutations[0][2], id: 'x'.repeat(129) }],
    ['docs_node_move', { revision: 7, id: 'draft', parentId: 'root' }],
    ['docs_node_move', { revision: 7, id: 'draft', parentId: 'root', beforeId: 0 }],
    ['docs_tabs_save', { revision: 7, tabs: [{ id: 'root', title: 'Docs', sort: 0, body: 'unexpected' }] }],
    ['docs_site_update', { name: '' }], ['docs_site_update', { name: 'x'.repeat(65) }],
  ];
  for (const [name, , args] of mutations.filter(([, , args]) => 'revision' in args)) {
    for (const revision of [-1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1]) cases.push([name, { ...args, revision }]);
    if ('confirm' in args) for (const confirm of [false, 'true', undefined]) cases.push([name, { ...args, confirm }]);
  }
  for (const draftVersion of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    cases.push(['docs_node_publish', { ...mutations[4][2], draftVersion }]);
  }
  for (const [name, args] of cases) {
    const count = f.calls.length;
    assert.equal((await call(client, name, args)).isError, true, `${name}: ${JSON.stringify(args)}`);
    assert.equal(f.calls.length, count, `${name}: invalid arguments accessed storage`);
  }
  assert.equal(f.stages.length, 0);
});

test('MCP SDK schema validation failures return error text without accessing storage', async t => {
  const f = await fixture(t), client = await f.connect();
  for (const [name, args] of [
    ['docs_node_get', { id: '../invalid' }],
    ['docs_node_update', { revision: 7, id: 'draft' }],
    ['docs_site_get', { unexpected: true }],
  ]) await t.test(name, async () => {
    const before = f.snapshot();
    const result = await call(client, name, args);
    // SDK validation runs before the tool callback and need not include the
    // application's structuredContent error envelope.
    assert.equal(result.isError, true, JSON.stringify(result));
    const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    assert.match(text, /validation|invalid arguments/i);
    assert.ok(text.includes(name), 'validation error identifies the rejected tool');
    assert.equal(f.calls.length, 0);
    assert.equal(f.stages.length, 0);
    assert.deepEqual(f.snapshot(), before);
  });
});

test('MCP stale revisions fail once without retries, writes, or publication', async t => {
  for (const [name, method, args] of mutations.filter(([, , args]) => 'revision' in args)) await t.test(name, async t => {
    const f = await fixture(t), client = await f.connect(), before = f.snapshot();
    toolError(await call(client, name, { ...args, revision: 6 }), 409);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.stages.length, 0);
    if (name === 'docs_node_create' || name === 'docs_node_update') {
      assert.deepEqual(f.calls, [['read']], 'stale read must not be followed by saveNode');
    } else {
      assert.equal(f.calls.length, 1, 'store conflicts must not trigger retries');
      assert.equal(f.calls[0][0], method);
      assert.equal(f.calls[0][1], 6);
    }
  });
  await t.test('a conflict after the create/update pre-read is not retried', async t => {
    const f = await fixture(t), client = await f.connect(), before = f.snapshot();
    f.inject('saveNode', failure(409, 'Concurrent writer won'));
    for (const [name, , args] of mutations.slice(0, 2)) {
      const count = f.calls.length;
      toolError(await call(client, name, args), 409);
      assert.deepEqual(f.calls.slice(count).map(([method]) => method), ['read', 'saveNode']);
    }
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.stages.length, 0);
  });
  await t.test('draft-version conflict does not stage', async t => {
    const f = await fixture(t), client = await f.connect(), before = f.snapshot();
    toolError(await call(client, 'docs_node_publish', { ...mutations[4][2], draftVersion: 1 }), 409);
    assert.equal(f.calls.length, 1);
    assert.equal(f.stages.length, 0);
    assert.deepEqual(f.snapshot(), before);
  });
});

test('MCP tool errors preserve safe domain failures and redact SQL/internal secrets', async t => {
  const secret = 'postgres://private-user:secret-password@hidden-db/private SELECT * FROM docs_state /private/signing-key';
  for (const [name, method, args] of mutations) await t.test(name, async t => {
    const f = await fixture(t), client = await f.connect(), before = f.snapshot();
    for (const status of [409, 422]) {
      f.inject(method, failure(status, `Safe domain failure ${status}`));
      const count = f.writes().length;
      const response = await call(client, name, args);
      toolError(response, status);
      assert.equal(response.structuredContent.error.message, `Safe domain failure ${status}`);
      assert.equal(f.writes().length, count + 1);
    }
    for (const error of [new Error(secret), Object.assign(new Error(secret), { code: '23505', detail: secret, query: secret })]) {
      f.inject(method, error);
      const count = f.writes().length;
      const response = await call(client, name, args);
      toolError(response, 500);
      assert.doesNotMatch(JSON.stringify(response), /private-user|secret-password|hidden-db|SELECT|docs_state|signing-key|23505/);
      assert.equal(f.writes().length, count + 1);
    }
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.stages.length, 0);
  });
  await t.test('read and stage errors are also redacted and do not commit', async t => {
    const f = await fixture(t), client = await f.connect(), before = f.snapshot();
    for (const [method, name, args] of [['read', 'docs_workspace_get', {}], ['siteName', 'docs_site_get', {}],
      ['stage', 'docs_node_publish', mutations[4][2]]]) {
      f.inject(method, new Error(secret));
      const response = await call(client, name, args);
      toolError(response, 500);
      assert.doesNotMatch(JSON.stringify(response), /secret-password|SELECT|hidden-db|signing-key/);
    }
    assert.deepEqual(f.snapshot(), before);
  });
});
