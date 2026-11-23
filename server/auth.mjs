import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sessionCookieName = 'docs_session';
const sessions = new Map();
const lifetime = 8 * 60 * 60 * 1000;
const unauthorized = () => Object.assign(new Error('请先登录文档管理；登录已失效时请重新登录。'), { status: 401 });
const digest = value => createHash('sha256').update(value).digest();
function token(req) {
  const values = (req?.headers?.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${sessionCookieName}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(sessionCookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export async function adminActor(req) {
  const key = token(req), session = sessions.get(key);
  if (!session || session.expires <= Date.now()) {
    if (key) sessions.delete(key);
    throw unauthorized();
  }
  return session.actor;
}
export function createSession(req, username, password) {
  const expectedUser = process.env.DOCS_ADMIN_USERNAME ?? 'admin';
  const expectedPassword = process.env.DOCS_ADMIN_PASSWORD ?? 'admin';
  const userOK = typeof username === 'string' && timingSafeEqual(digest(username), digest(expectedUser));
  const passwordOK = typeof password === 'string' && timingSafeEqual(digest(password), digest(expectedPassword));
  if (!userOK || !passwordOK) throw Object.assign(new Error('账号或密码错误，请重试。'), { status: 401 });
  for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
  sessions.delete(token(req));
  const key = randomBytes(32).toString('hex');
  sessions.set(key, { actor: `standalone:${expectedUser}`, expires: Date.now() + lifetime });
  return key;
}
export function destroySession(req) { sessions.delete(token(req)); }
export function sessionCookie(value, allowedOrigin) {
  return `${sessionCookieName}=${value}; Path=/manage; HttpOnly; SameSite=Strict; Max-Age=${value ? lifetime / 1000 : 0}${new URL(allowedOrigin).protocol === 'https:' ? '; Secure' : ''}`;
}
