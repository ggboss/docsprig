import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { handler } from '../server/http.mjs';

const origin = 'https://docs.example.invalid';
const token = 'mcp-config-test-only-token-0123456789abcdef';
const cookie = 'docs_session=synthetic-test-session';

async function fixture(t, mcpToken = token) {
  // Always inject synthetic credentials; never consult the shell's MCP token.
  const server = createServer(handler({ origin, mcpToken, store: {}, content: {},
    authenticate: async req => {
      if (req.headers.cookie !== cookie) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return 'test:admin';
    },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async ({ method = 'POST', headers = {} } = {}) => {
    const requestHeaders = { origin, cookie, ...headers };
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
    const response = await fetch(`http://127.0.0.1:${server.address().port}/manage/mcp-config`, {
      method, headers: requestHeaders,
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const text = await response.text();
    if (response.status !== 200) {
      assert.ok(!text.includes(token), 'Errors must not expose the configured token');
      if (typeof mcpToken === 'string' && mcpToken) assert.ok(!text.includes(mcpToken));
      assert.ok(!text.includes('Authorization'));
    }
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
}

test('MCP config requires the existing management authentication', async t => {
  const request = await fixture(t);
  for (const headers of [{ cookie: '' }, { cookie: 'docs_session=forged' },
    { cookie: '', authorization: `Bearer ${token}` }]) {
    const response = await request({ headers });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Unauthorized' });
  }
});

test('MCP config requires an exact Origin and rejects cross-site requests', async t => {
  const request = await fixture(t);
  for (const headers of [{ origin: undefined }, { origin: '' }, { origin: 'null' }, { origin: 'https://foreign.invalid' },
    { origin: `${origin}/` }, { origin: 'http://docs.example.invalid' },
    { origin: `${origin}.foreign.invalid` }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await request({ headers });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: '请求来源未获授权' });
  }
});

test('MCP config returns the configured origin and bearer client configuration', async t => {
  for (const mcpToken of [token, 'x'.repeat(32), 'x'.repeat(512)]) {
    const request = await fixture(t, mcpToken);
    const response = await request({ headers: { host: 'foreign.invalid', 'x-forwarded-host': 'foreign.invalid',
      'x-forwarded-proto': 'http', 'sec-fetch-site': 'same-origin' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const name = 'docsprig-admin', url = `${origin}/mcp/admin`;
    assert.deepEqual(response.body, { name, url, config: { mcpServers: {
      [name]: { url, headers: { Authorization: `Bearer ${mcpToken}` } },
    } } });
  }
});

test('MCP config fails generically for missing or invalid tokens', async t => {
  for (const mcpToken of ['', null, 123, false, {}, 'x'.repeat(31), 'x'.repeat(513),
    `${'x'.repeat(31)} `, `${'x'.repeat(31)}\t`, `${'x'.repeat(31)}\n`, `${'x'.repeat(31)}\u00a0`]) {
    const request = await fixture(t, mcpToken);
    const response = await request();
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'MCP 配置暂时不可用' });
    assert.equal((await request({ headers: { cookie: '' } })).status, 401);
    assert.equal((await request({ headers: { origin: 'https://foreign.invalid' } })).status, 403);
  }
});

test('MCP config rejects methods other than POST without returning credentials', async t => {
  const request = await fixture(t);
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request({ method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    assert.deepEqual(response.body, method === 'HEAD' ? null : { error: '只支持 POST' });
    assert.equal((await request({ method, headers: { cookie: '' } })).status, 401);
  }
});
