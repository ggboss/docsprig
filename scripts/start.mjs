import { configuredOrigins } from '../server/origins.mjs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const modes = new Set(['development', 'production']);

export function selectEnvironment(args = []) {
  if (args.length === 0) return 'development';
  if (args.length === 1 && args[0] === '--production') return 'production';
  throw Error('Usage: pnpm start | pnpm start:prod');
}

export function validateDatabaseUrl(value, mode) {
  if (!modes.has(mode)) throw Error('Unsupported startup environment');
  // Never include the supplied URL or parser details in errors.
  const invalid = () => Error('DATABASE_URL must be a PostgreSQL URL with a database name');
  let url, database;
  try { url = new URL(value); database = decodeURIComponent(url.pathname.slice(1)); }
  catch { throw invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !database || /[\u0000-\u001f/\\]/.test(database) || url.hash) throw invalid();
  // pg connection-string query parameters can override pathname/host/user.
  // Only explicitly supported, non-routing connection options are accepted.
  const allowed = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'application_name']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw invalid();
  return value;
}

export async function loadEnvironment({ args = [], env = process.env, directory = root } = {}) {
  const mode = selectEnvironment(args);
  const filename = `.env.${mode}.local`;
  let local;
  try { local = parseEnv(await readFile(resolve(directory, filename), 'utf8')); }
  catch { throw Error(`Cannot read ${filename}; create it from .env.example`); }
  // The selected private file is the sole source of DATABASE_URL. Shell variables,
  // .env, .env.local, and NODE_ENV must never silently select a different database.
  const databaseUrl = validateDatabaseUrl(local.DATABASE_URL, mode);
  const settings = { ...env, ...local };
  return { mode, filename, env: { ...settings, DATABASE_URL: databaseUrl, NODE_ENV: mode } };
}

export async function loadStartConfig({ args = [], env = process.env, directory = root } = {}) {
  const { mode, filename, env: settings } = await loadEnvironment({ args, env, directory });
  const port = settings.PORT ?? '4391';
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw Error('PORT must be an integer from 1 to 65535');
  const bind = settings.DOCS_BIND || '127.0.0.1';
  let origin = settings.DOCS_PUBLIC_ORIGIN;
  if (!origin) {
    if (!['127.0.0.1', '::1'].includes(bind)) throw Error('DOCS_PUBLIC_ORIGIN required for a non-loopback binding');
    origin = `http://${bind === '::1' ? '[::1]' : bind}:${Number(port)}`;
  }
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== origin) throw Error();
  } catch { throw Error('DOCS_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials or a path'); }
  configuredOrigins(origin, settings.DOCS_ALLOWED_ORIGINS);
  for (const page of ['doc.html', 'admin.html']) {
    try { if (!(await stat(resolve(directory, 'dist', page))).isFile()) throw Error(); }
    catch { throw Error('Missing built portal; run pnpm build first'); }
  }
  return { mode, filename, env: { ...settings,
    PORT: String(Number(port)), DOCS_BIND: bind, DOCS_PUBLIC_ORIGIN: origin } };
}

export async function start(options = {}, run = () => import('../server/index.mjs')) {
  const config = await loadStartConfig(options);
  // No build, migration, database creation, child process, or Docker side effects.
  Object.assign(process.env, config.env);
  await run();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await start({ args: process.argv.slice(2) }); }
  catch {
    // Even unexpected dependency errors may contain a connection string. Keep the
    // CLI diagnostic static; validation details are available to unit tests.
    console.error('Startup failed. Check the selected .env.development.local or .env.production.local, DATABASE_URL database name, PORT, DOCS_PUBLIC_ORIGIN, and pnpm build output. Production requires pnpm start:prod.');
    process.exitCode = 1;
  }
}
