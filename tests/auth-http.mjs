import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../server/http.mjs';
import { adminActor, sessionCookieName } from '../server/auth.mjs';

// Exercise the real HTTP boundary and in-process sessions, with no database/IAM.
test('real management authentication protects every route and preserves anonymous published reads', async t => {
  const envNames = ['DOCS_ADMIN_USERNAME', 'DOCS_ADMIN_PASSWORD'];
  const previous = envNames.map(name => process.env[name]);
  envNames.forEach(name => delete process.env[name]);
  t.after(() => envNames.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  }));
  const origin = 'http://127.0.0.1:4180';
  let reads = 0, writes = 0;
  const workspace = { revision: 0, nodes: [{ id: 'draft', type: 'markdown', body: 'PRIVATE DRAFT' }] };
  const write = async () => { writes++; return { revision: writes }; };
  const server = createServer(handler({ origin, authenticate: adminActor, store: {
    read: async () => { reads++; return workspace; },
    saveNode: write, publishNode: write, saveTabs: write, publishTabs: write,
    deleteNode: write, deleteTab: write, moveNode: write, setSiteName: write,
    current: async () => ({ id: 'published' }), hasRelease: async id => id === 'published',
  }, content: {
    read: async () => ({ body: Buffer.from('{"published":true}'), contentType: 'application/json' }),
    stage: () => assert.fail('Unauthorized requests must never stage content'),
  } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', cookie, headers = {}, body, raw } = {}) {
    const response = await fetch(base + path, { method, redirect: 'error',
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const protectedRoutes = [
    ['/manage/workspace', 'GET'], ['/manage/preview', 'GET'],
    ['/manage/preview?doc=draft', 'GET'], ['/manage/tabs', 'PUT'],
    ['/manage/tabs/publish', 'POST'], ['/manage/node', 'PUT'],
    ['/manage/publish', 'POST'], ['/manage/node', 'DELETE'], ['/manage/tabs', 'DELETE'],
    ['/manage/node/move', 'POST'], ['/manage/site-name', 'PUT'], ['/manage/logout', 'POST'], ['/manage/session', 'GET'], ['/manage/anything', 'GET'],
  ];
  async function denied(cookie) {
    for (const [path, method] of protectedRoutes) {
      const result = await request(path, { method, cookie, headers: { origin } });
      assert.equal(result.status, 401, `${method} ${path} must require a session`);
      assert.equal(typeof result.body.error, 'string');
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.ok(!JSON.stringify(result.body).includes('PRIVATE DRAFT'));
    }
  }

  await t.test('anonymous known and unknown management routes return 401 before storage access', async () => {
    await denied();
    assert.equal(reads, 0); assert.equal(writes, 0);
    const published = await request('/content/dev/current/tree.json');
    assert.equal(published.status, 200); assert.deepEqual(published.body, { published: true });
    assert.equal(reads, 0);
  });

  await t.test('forged cookies and identity headers cannot impersonate an administrator', async () => {
    for (const cookie of [`${sessionCookieName}=${'0'.repeat(64)}`, `${sessionCookieName}=admin`, 'JSESSIONID=admin']) await denied(cookie);
    assert.equal((await request('/manage/workspace', { headers: { authorization: 'Bearer admin', 'x-forwarded-user': 'admin' } })).status, 401);
    assert.equal(reads, 0); assert.equal(writes, 0);
  });

  let cookie;
  await t.test('wrong password fails; admin/admin sets a session usable for session and workspace', async () => {
    const bad = await request('/manage/login', { method: 'POST', headers: { origin }, body: { username: 'admin', password: 'wrong' } });
    assert.equal(bad.status, 401); assert.equal(bad.headers.get('set-cookie'), null);
    const good = await request('/manage/login', { method: 'POST', headers: { origin }, body: { username: 'admin', password: 'admin' } });
    assert.equal(good.status, 200); assert.deepEqual(good.body, { admin: true });
    const setCookie = good.headers.get('set-cookie');
    assert.match(setCookie, new RegExp(`^${sessionCookieName}=[a-f0-9]{64};`));
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(';')[0];
    const session = await request('/manage/session', { cookie });
    assert.equal(session.status, 200); assert.deepEqual(session.body, { admin: true });
    const draft = await request('/manage/workspace', { cookie });
    assert.equal(draft.status, 200); assert.deepEqual(draft.body, workspace);
    assert.equal(reads, 1);
    assert.equal((await request('/manage/anything', { cookie })).status, 404);
  });

  await t.test('malformed login and failed relogin preserve the existing session', async () => {
    for (const body of [null, [], {}, { username: 1, password: 'admin' }, { username: 'admin', password: null }]) {
      const result = await request('/manage/login', { method: 'POST', cookie, headers: { origin }, body });
      assert.equal(result.status, 400); assert.equal(result.headers.get('set-cookie'), null);
    }
    for (const [raw, headers, expected] of [['{', { origin }, 400], ['{}', { origin, 'content-type': 'text/plain' }, 415], ['x'.repeat(4097), { origin }, 413]]) {
      const result = await request('/manage/login', { method: 'POST', cookie, raw, headers });
      assert.equal(result.status, expected); assert.equal(result.headers.get('set-cookie'), null);
    }
    for (const credentials of [{ username: 'wrong', password: 'admin' }, { username: 'admin', password: 'wrong' }]) {
      const result = await request('/manage/login', { method: 'POST', cookie, headers: { origin }, body: credentials });
      assert.equal(result.status, 401); assert.equal(result.headers.get('set-cookie'), null);
    }
    for (const path of ['/manage/login', '/manage/logout']) for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS'])
      assert.equal((await request(path, { method, cookie, headers: { origin } })).status, 405);
    assert.equal((await request('/manage/session', { cookie })).status, 200);
    await denied(`${cookie}; ${cookie}`);
    assert.equal((await request('/manage/session', { cookie })).status, 200, 'Ambiguous cookies must not revoke the valid token');
    assert.equal(reads, 1); assert.equal(writes, 0);
  });

  await t.test('successful relogin rotates the token and invalidates replay', async () => {
    const old = cookie;
    const result = await request('/manage/login', { method: 'POST', cookie, headers: { origin }, body: { username: 'admin', password: 'admin' } });
    assert.equal(result.status, 200); cookie = result.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, old); await denied(old);
    assert.equal((await request('/manage/session', { cookie })).status, 200);
  });

  await t.test('cross-origin login and authenticated writes are refused without mutation', async () => {
    const mutations = [
      ['/manage/login', 'POST', { username: 'admin', password: 'admin' }],
      ['/manage/logout', 'POST', {}],
      ['/manage/node', 'DELETE', { revision: 0, id: 'draft' }],
      ['/manage/tabs', 'DELETE', { revision: 0, id: 'tab' }],
      ['/manage/node/move', 'POST', { revision: 0, id: 'draft', parentId: 'tab', beforeId: null }],
      ['/manage/site-name', 'PUT', { name: 'Changed' }], ['/manage/tabs', 'PUT', { revision: 0, tabs: [] }],
      ['/manage/tabs/publish', 'POST', { revision: 0 }],
      ['/manage/node', 'PUT', { revision: 0, node: { id: 'draft' } }],
      ['/manage/publish', 'POST', { revision: 0, id: 'draft', draftVersion: 1 }],
    ];
    for (const [path, method, body] of mutations) {
      for (const headers of [{ origin: 'https://other.invalid' }, {}, { origin: 'null' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
        const result = await request(path, { method, cookie, headers, body });
        assert.equal(result.status, 403, `${method} ${path} must reject untrusted Origin`);
        assert.equal(result.headers.get('set-cookie'), null);
      }
    }
    assert.equal(writes, 0); assert.equal(reads, 1);
    assert.equal((await request('/manage/session', { cookie })).status, 200);
  });

  await t.test('logout requires authentication and destroys the old session', async () => {
    assert.equal((await request('/manage/logout', { method: 'POST', headers: { origin } })).status, 401);
    const result = await request('/manage/logout', { method: 'POST', cookie, headers: { origin } });
    assert.equal(result.status, 200); assert.deepEqual(result.body, { admin: false });
    assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
    await denied(cookie);
    assert.equal((await request('/manage/logout', { method: 'POST', cookie, headers: { origin } })).status, 401);
    assert.equal(reads, 1); assert.equal(writes, 0);
    assert.equal((await request('/content/dev/current/tree.json')).status, 200);
  });
});
