import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { adminActor, sessionCookieName } from '../server/auth.mjs';
import { handleAuthRoute } from '../server/auth-routes.mjs';

const origin = 'http://127.0.0.1:4180';
function req(path, { method = 'POST', body, cookie, headers = {} } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(stream, { url: path, method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers } });
  return stream;
}
function res() {
  return { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = JSON.parse(body); } };
}
async function login(cookie, body = { username: 'admin', password: 'admin' }, allowed = origin) {
  const response = res();
  assert.equal(await handleAuthRoute(req('/manage/login', { body, cookie, headers: { origin: allowed } }), response, allowed), true);
  assert.equal(response.status, 200); assert.deepEqual(response.body, { admin: true });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  return { cookie: response.headers['Set-Cookie'].split(';')[0], header: response.headers['Set-Cookie'] };
}
const status = n => error => error.status === n;

test('standalone sessions authenticate locally, rotate, and logout invalidates replay', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('External authentication must not be contacted'); });
  for (const request of [undefined, { headers: {} }, { headers: { cookie: 'JSESSIONID=unrelated', authorization: 'Bearer admin', 'x-forwarded-user': 'admin' } }])
    await assert.rejects(adminActor(request), status(401));
  const first = await login();
  assert.match(first.cookie, new RegExp(`^${sessionCookieName}=[a-f0-9]{64}$`));
  assert.match(first.header, /Path=\/manage; HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.equal(await adminActor({ headers: { cookie: first.cookie } }), 'standalone:admin');
  await assert.rejects(adminActor({ headers: { cookie: `${first.cookie}; ${first.cookie}` } }), status(401));
  await assert.rejects(adminActor({ headers: { cookie: `${sessionCookieName}=${'0'.repeat(64)}` } }), status(401));
  const second = await login(first.cookie);
  assert.notEqual(second.cookie, first.cookie);
  await assert.rejects(adminActor({ headers: { cookie: first.cookie } }), status(401));
  const response = res();
  assert.equal(await handleAuthRoute(req('/manage/logout', { cookie: second.cookie }), response, origin), true);
  assert.deepEqual(response.body, { admin: false });
  assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
  await assert.rejects(adminActor({ headers: { cookie: second.cookie } }), status(401));
  await assert.rejects(handleAuthRoute(req('/manage/logout'), res(), origin), status(401));
  assert.equal(fetch.mock.callCount(), 0);
});

test('auth routes reject wrong credentials, methods, origins and invalid input', async () => {
  for (const body of [{ username: 'admin', password: 'wrong' }, { username: 'wrong', password: 'admin' }])
    await assert.rejects(handleAuthRoute(req('/manage/login', { body }), res(), origin), status(401));
  for (const path of ['/manage/login', '/manage/logout']) {
    await assert.rejects(handleAuthRoute(req(path, { method: 'GET' }), res(), origin), status(405));
    for (const headers of [{ origin: undefined }, { origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }])
      await assert.rejects(handleAuthRoute(req(path, { headers }), res(), origin), status(403));
  }
  for (const body of ['{', 'null', [], {}, { username: 1, password: 'admin' }])
    await assert.rejects(handleAuthRoute(req('/manage/login', { body }), res(), origin), status(400));
  await assert.rejects(handleAuthRoute(req('/manage/login', { body: 'x'.repeat(4097) }), res(), origin), status(413));
  await assert.rejects(handleAuthRoute(req('/manage/login', { headers: { 'content-length': '4097' } }), res(), origin), status(413));
  await assert.rejects(handleAuthRoute(req('/manage/login', { headers: { 'content-type': 'text/plain' } }), res(), origin), status(415));
  for (const path of ['/manage/session', '/manage/workspace', '/manage/preview', '/manage/node', '/manage/tabs', '/manage/publish', '/content/dev/current/tree.json'])
    assert.equal(await handleAuthRoute(req(path), res(), origin), false);
});

test('logout CSRF rejection preserves the session', async () => {
  const { cookie } = await login();
  await assert.rejects(handleAuthRoute(req('/manage/logout', { cookie, headers: { origin: 'https://evil.invalid' } }), res(), origin), status(403));
  assert.equal(await adminActor({ headers: { cookie } }), 'standalone:admin');
  await handleAuthRoute(req('/manage/logout', { cookie }), res(), origin);
});

test('sessions expire and HTTPS cookies are Secure', async t => {
  const { cookie, header } = await login(undefined, undefined, 'https://docs.example.com');
  assert.match(header, /; Secure$/);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 8 * 60 * 60 * 1000 + 1);
  await assert.rejects(adminActor({ headers: { cookie } }), status(401));
});

test('environment overrides both default credentials', async () => {
  const names = ['DOCS_ADMIN_USERNAME', 'DOCS_ADMIN_PASSWORD'];
  const before = names.map(name => process.env[name]);
  try {
    process.env.DOCS_ADMIN_USERNAME = 'owner'; process.env.DOCS_ADMIN_PASSWORD = 'custom-secret';
    await assert.rejects(login(), status(401));
    const { cookie } = await login(undefined, { username: 'owner', password: 'custom-secret' });
    assert.equal(await adminActor({ headers: { cookie } }), 'standalone:owner');
    await handleAuthRoute(req('/manage/logout', { cookie }), res(), origin);
  } finally {
    names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
  }
});
