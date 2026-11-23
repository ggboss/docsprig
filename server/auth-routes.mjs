import { adminActor, createSession, destroySession, sessionCookie } from './auth.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
async function credentials(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(415, '需要 application/json');
  const limit = 4096;
  if (Number(req.headers['content-length']) > limit) throw fail(413, '登录请求过大');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, '登录请求过大');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'JSON 格式错误'); }
  if (!data || typeof data.username !== 'string' || typeof data.password !== 'string') throw fail(400, '请输入账号和密码');
  return data;
}
// Errors use the HTTP handler's existing {status,message} -> {error} contract.
export async function handleAuthRoute(req, res, allowedOrigin) {
  const path = (req.url ?? '').split('?')[0];
  if (!['/manage/login', '/manage/logout'].includes(path)) return false;
  if (req.method !== 'POST') throw fail(405, '只允许 POST');
  if (req.headers.origin !== new URL(allowedOrigin).origin || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '请求来源未获授权');
  let value = '';
  if (path === '/manage/login') {
    const data = await credentials(req);
    value = createSession(req, data.username, data.password);
  } else {
    await adminActor(req);
    destroySession(req);
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Set-Cookie': sessionCookie(value, allowedOrigin) });
  res.end(JSON.stringify({ admin: !!value }));
  return true;
}
