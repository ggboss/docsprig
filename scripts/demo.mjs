import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sessionCookieName } from '../server/auth.mjs';

const host = '127.0.0.1';
const self = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(self));
const random = () => randomBytes(32).toString('hex');
function port(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw Error(`Invalid ${name}`);
  return n;
}

async function probe(n) {
  const server = createTcpServer();
  server.listen(n, host);
  await once(server, 'listening');
  const actual = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return actual;
}

// Select ports before building the CSRF origin and proxy target. Explicit ports
// are strict; an occupied default may move to an ephemeral loopback port.
async function choosePort(name, fallback, excluded) {
  const preferred = port(name, fallback);
  if (preferred !== excluded) {
    try { return await probe(preferred); }
    catch (e) { if (e.code !== 'EADDRINUSE' || process.env[name]) throw e; }
  } else if (process.env[name]) throw Error(`Conflicting ${name}`);
  let actual;
  do { actual = await probe(0); } while (actual === excluded);
  return actual;
}

// Zudoku 0.93 owns its outer HTTP server and calls listen(port), ignoring Vite's
// server.host. Constrain that listener in the frontend child only; no port fallback.
async function frontend() {
  const expected = port('DEMO_WEB_PORT', 4180);
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (n, callback) {
    if (n !== expected || typeof callback !== 'function') throw Error('Unexpected Zudoku listener');
    return listen.call(this, n, host, callback);
  };
  const cli = fileURLToPath(import.meta.resolve('zudoku/package.json')).replace(/package\.json$/, 'cli.js');
  process.argv = [process.execPath, cli, 'dev', '--no-ssr', '--port', String(expected)];
  await import(cli);
}

async function launch() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || ![undefined, '--built', '--smoke', '--smoke-built'].includes(mode)) {
    throw Error('Usage: node scripts/demo.mjs [--built | --smoke | --smoke-built]');
  }
  const built = mode === '--built' || mode === '--smoke-built';
  const smoke = mode === '--smoke' || mode === '--smoke-built';
  if (built) await access(path.join(root, 'dist/admin.html')).catch(() => { throw Error('Missing built editor; run pnpm build first'); });
  const apiPort = await choosePort('DEMO_API_PORT', 4191);
  const web = built ? apiPort : await choosePort('DEMO_WEB_PORT', 4180, apiPort);
  let api = apiPort;
  if (built) do { api = await probe(0); } while (api === web);
  const origin = `http://${host}:${web}`;
  const key = createHash('sha256').update(root).digest('hex').slice(0, 12) + (built ? '-built' : '');
  const state = smoke ? await mkdtemp(path.join(tmpdir(), 'open-demo-')) : path.join(homedir(), '.local/share/docsprig-demo', key);
  const instance = `open-docs-demo-${smoke ? random().slice(0, 16) : key}`;
  const volume = `${instance}-pgdata`;
  const children = new Set();
  const env = { HOME: homedir(), PATH: process.env.PATH, NODE_ENV: 'development' };
  let stop, problem, container, volumeMade, gateway, socket;
  const stopped = new Promise(resolve => { stop = resolve; });
  let stopping = false;
  function finish(err) {
    if (!stopping) { stopping = true; problem = err; stop(); }
  }
  const onSignal = () => finish();
  for (const sig of ['SIGINT', 'SIGTERM', 'disconnect']) process.on(sig, onSignal);
  function check() { if (stopping) throw problem ?? Error('Stopped'); }
  async function docker(...args) {
    // No remote daemon or pull fallback. Never include the password in argv.
    const { stdout } = await promisify(execFile)('docker', [...(socket ? ['--host', socket] : []), ...args], { env, timeout: 45_000 });
    return stdout.trim();
  }
  function child(label, args, extra, service = false) {
    check();
    const p = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'inherit', 'inherit'] });
    children.add(p);
    const done = new Promise((resolve, reject) => {
      p.once('error', reject);
      p.once('close', code => { children.delete(p); code === 0 ? resolve() : reject(Error(`${label} stopped (${code})`)); });
    });
    done.then(() => { if (service) finish(Error(`${label} exited`)); }, finish);
    return done;
  }
  async function waitFor(label, test, attempts) {
    for (let i = 0; i < attempts; i++) {
      check();
      if (await test()) return;
      await Promise.race([stopped, sleep(250)]);
    }
    throw Error(`${label} did not become ready`);
  }
  try {
    socket = await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
    if (!/^unix:\/\/\//.test(socket)) { socket = undefined; throw Error('A local Unix-socket Docker context is required'); }
    await mkdir(state, { recursive: true, mode: 0o700 });
    const pwFile = path.join(state, 'pg-password');
    try { await writeFile(pwFile, random(), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const pw = await readFile(pwFile, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(pw)) throw Error('Invalid local database password file');
    check();
    await docker('volume', 'create', volume); volumeMade = true;
    container = await docker('run', '--rm', '--pull=never', '-d', '--name', instance,
      '-p', `${host}::5432`, '-v', `${volume}:/var/lib/postgresql/data`,
      '--mount', `type=bind,src=${pwFile},dst=/run/demo-password,readonly`,
      '-e', 'POSTGRES_PASSWORD_FILE=/run/demo-password', '-e', 'POSTGRES_USER=demo', '-e', 'POSTGRES_DB=docs_dev', 'postgres:16-alpine');
    const mapped = (await docker('port', container, '5432/tcp')).match(/^127\.0\.0\.1:(\d+)$/);
    if (!mapped) throw Error('Docker did not bind exclusively to IPv4 loopback');
    await waitFor('PostgreSQL', () => docker('exec', container, 'pg_isready', '-h', host, '-U', 'demo', '-d', 'docs_dev').then(() => true, () => false), 120);
    const DATABASE_URL = `postgres://demo:${pw}@${host}:${mapped[1]}/docs_dev`;
    await child('Migration', ['migrations/migrate.mjs'], { DATABASE_URL, DOCS_SEED: 'demo' });
    check();

    gateway = createServer((req, res) => {
      if (req.headers.host !== `${host}:${web}` || !/^\/(?!\/)/.test(req.url)) return res.writeHead(404).end();
      // Forward Origin and only the standalone session cookie for management requests.
      const headers = {};
      for (const key of ['accept', 'content-type', 'content-length', 'origin', 'sec-fetch-site', 'if-none-match', 'if-modified-since', 'range']) {
        if (req.headers[key] !== undefined) headers[key] = req.headers[key];
      }
      if (req.url.split('?')[0].startsWith('/manage/')) {
        const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${sessionCookieName}=`));
        if (cookies.length === 1) headers.cookie = cookies[0];
      }
      const upstream = request({ hostname: host, port: api, path: req.url, method: req.method, headers }, reply => {
        const { 'set-cookie': ignored, ...responseHeaders } = reply.headers;
        if (req.url.split('?')[0].startsWith('/manage/') && ignored) {
          responseHeaders['set-cookie'] = ignored.filter(value => value.startsWith(`${sessionCookieName}=`));
        }
        res.writeHead(reply.statusCode, responseHeaders);
        reply.on('error', () => res.destroy()).pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    });
    gateway.listen(built ? web : 0, host); await once(gateway, 'listening');
    const gatewayOrigin = `http://${host}:${gateway.address().port}`;
    child('API', ['server/index.mjs'], { DATABASE_URL, DOCS_BIND: host, PORT: String(api),
      DOCS_PUBLIC_ORIGIN: origin, DOCS_ADMIN_USERNAME: process.env.DOCS_ADMIN_USERNAME ?? 'admin',
      DOCS_ADMIN_PASSWORD: process.env.DOCS_ADMIN_PASSWORD ?? 'admin' }, true);
    if (!built) child('Frontend', [self, '--frontend-child'], { DEMO_WEB_PORT: String(web), OPEN_DOCS_BACKEND: gatewayOrigin, OPEN_DEMO_GATEWAY: gatewayOrigin }, true);
    // Anonymous probe also verifies that Vite proxies /manage instead of serving HTML.
    await waitFor('Frontend /manage proxy', async () => {
      try {
        const r = await fetch(`${origin}/manage/workspace`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
        await r.body?.cancel(); return r.status === 401 && /^application\/json/.test(r.headers.get('content-type') ?? '');
      } catch { return false; }
    }, 180);
    check();
    console.log(`Demo: ${origin}/admin`);
    if (smoke && process.send) process.send({ type: 'demo-ready', origin, authMode: 'standalone' });
    else console.log('Standalone management: open /admin and log in (default admin/admin; DOCS_ADMIN_USERNAME / DOCS_ADMIN_PASSWORD override).');
    await stopped;
  } catch (e) { finish(e); }
  finally {
    const exited = [...children].map(p => { const done = once(p, 'close').catch(() => {}); p.kill('SIGTERM'); return done; });
    if (gateway?.listening) { gateway.close(); gateway.closeAllConnections(); }
    await Promise.race([Promise.all(exited), sleep(3000, undefined, { ref: false })]);
    for (const p of children) p.kill('SIGKILL');
    if (container) await docker('rm', '-f', container);
    if (smoke && volumeMade) await docker('volume', 'rm', volume);
    if (smoke) await rm(state, { recursive: true, force: true });
    for (const sig of ['SIGINT', 'SIGTERM', 'disconnect']) process.off(sig, onSignal);
    if (process.connected) process.disconnect();
  }
  if (problem) throw problem;
}

try { if (process.argv[2] === '--frontend-child') await frontend(); else await launch(); }
catch (e) { console.error(e.message); process.exitCode = 1; }
