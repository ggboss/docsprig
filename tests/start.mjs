import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadStartConfig, selectEnvironment, validateDatabaseUrl } from '../scripts/start.mjs';
import { runMigration } from '../scripts/migrate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dev = 'postgresql://test:secret@localhost:5432/docs_dev';
const prod = dev.replace('docs_dev', 'docs_prod');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  for (const name of ['doc', 'admin']) await writeFile(join(directory, 'dist', `${name}.html`), name);
  await writeFile(join(directory, '.env.development.local'), `DATABASE_URL="${dev}"\n`);
  await writeFile(join(directory, '.env.production.local'), `DATABASE_URL='${prod}'\n`);
  return directory;
}

test('development is the default even with production shell variables; private file wins', async t => {
  const directory = await fixture(t);
  const env = { NODE_ENV: 'production', DATABASE_URL: prod };
  const config = await loadStartConfig({ directory, env });
  assert.equal(config.mode, 'development');
  assert.equal(config.filename, '.env.development.local');
  assert.equal(config.env.DATABASE_URL, dev);
  assert.equal(config.env.NODE_ENV, 'development');
  assert.equal(config.env.PORT, '4391');
  assert.equal(config.env.DOCS_PUBLIC_ORIGIN, 'http://127.0.0.1:4391');
  assert.deepEqual(env, { NODE_ENV: 'production', DATABASE_URL: prod });
});

test('production requires the exact explicit argument and production private file', async t => {
  const directory = await fixture(t);
  const config = await loadStartConfig({ directory, env: { NODE_ENV: 'development' }, args: ['--production'] });
  assert.equal(config.mode, 'production');
  assert.equal(config.env.NODE_ENV, 'production');
  assert.equal(config.env.DATABASE_URL, prod);
  assert.equal(config.filename, '.env.production.local');
  for (const args of [['production'], ['--env=production'], ['--production', '--production'], ['--development']]) {
    assert.throws(() => selectEnvironment(args), /Usage/);
  }
});

test('missing private files or DATABASE_URL never fall back to shell or shared env files', async t => {
  const directory = await fixture(t);
  await rm(join(directory, '.env.development.local'));
  for (const name of ['.env', '.env.local']) await writeFile(join(directory, name), `DATABASE_URL=${dev}`);
  await assert.rejects(loadStartConfig({ directory, env: { DATABASE_URL: dev } }), /Cannot read .env.development.local/);
  await writeFile(join(directory, '.env.development.local'), 'NODE_ENV=production\n');
  await assert.rejects(loadStartConfig({ directory, env: { DATABASE_URL: dev } }), /PostgreSQL URL/);
  await rm(join(directory, '.env.production.local'));
  await assert.rejects(loadStartConfig({ directory, env: {}, args: ['--production'] }), /Cannot read .env.production.local/);
});

test('migration and startup use the same selected private-file connection, never shell overrides', async t => {
  const directory = await fixture(t);
  for (const [args, expected] of [[[], dev], [['--production'], prod]]) {
    const options = { directory, args, env: { DATABASE_URL: 'postgresql://ignored@localhost/other' } };
    const start = await loadStartConfig(options);
    let called = false;
    await runMigration(options, async (config, settings) => {
      called = true;
      assert.equal(config.env.DATABASE_URL, expected);
      assert.equal(config.env.DATABASE_URL, start.env.DATABASE_URL);
      assert.equal(settings.expected, args.length ? 'docs_prod' : 'docs_dev');
      assert.equal(settings.seed, 'empty');
    });
    assert.ok(called);
  }
  await writeFile(join(directory, '.env.production.local'), `DATABASE_URL=${prod}\nDOCS_SEED=demo\n`);
  await assert.rejects(runMigration({ directory, args: ['--production'], env: {} }, () => assert.fail('Must not connect')), /must be empty/);
  await rm(join(directory, '.env.development.local'));
  await assert.rejects(runMigration({ directory, env: { DATABASE_URL: dev } }, () => assert.fail('Must not connect')), /Cannot read/);
});

test('database URLs are PostgreSQL URLs and routing query overrides cannot bypass validation', () => {
  assert.equal(validateDatabaseUrl(dev, 'development'), dev);
  assert.equal(validateDatabaseUrl(prod, 'production'), prod);
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'db.example.test']) {
    const custom = `postgresql://test:secret@${host}:5432/custom_docs`;
    assert.equal(validateDatabaseUrl(custom, 'development'), custom);
    assert.equal(validateDatabaseUrl(custom, 'production'), custom);
  }
  assert.equal(validateDatabaseUrl(`${dev}?sslmode=require&application_name=docs`, 'development'), `${dev}?sslmode=require&application_name=docs`);
  for (const [value, mode] of [
    [dev + '/other', 'development'], [dev + '%2Fother', 'development'],
    [dev + '?database=docs_prod', 'development'], [dev + '?dbname=docs_prod', 'development'],
    [dev + '?host=localhost', 'development'], [dev + '?%64atabase=docs_prod', 'development'],
    [dev + '?options=-csearch_path=other', 'development'], [dev + '#secret', 'development'],
    [dev.replace('postgresql:', 'https:'), 'development'],
    ['postgresql://secret@localhost/', 'development'], ['postgresql://secret@localhost/%XX', 'development'],
    ['secret-not-a-url', 'development'], [undefined, 'development'],
  ]) {
    assert.throws(() => validateDatabaseUrl(value, mode), error => {
      assert.equal(error.message, 'DATABASE_URL must be a PostgreSQL URL with a database name');
      assert.ok(!error.stack.includes('secret'));
      return true;
    });
  }
});

test('origin follows the configured port and bind; malformed values fail safely', async t => {
  const directory = await fixture(t);
  const config = await loadStartConfig({ directory, env: { PORT: '4500', DOCS_BIND: '::1' } });
  assert.equal(config.env.DOCS_PUBLIC_ORIGIN, 'http://[::1]:4500');
  await writeFile(join(directory, '.env.development.local'), `DATABASE_URL=${dev}\nPORT=4600\nNODE_ENV=production\n`);
  assert.equal((await loadStartConfig({ directory, env: { PORT: '4500' } })).env.PORT, '4600');
  assert.equal((await loadStartConfig({ directory, env: {} })).env.NODE_ENV, 'development');
  await writeFile(join(directory, '.env.development.local'), `DATABASE_URL=${dev}\n`);
  for (const PORT of ['0', '-1', '65536', '1.5', '', 'secret']) {
    await assert.rejects(loadStartConfig({ directory, env: { PORT } }), /PORT must/);
  }
  await assert.rejects(loadStartConfig({ directory, env: { DOCS_BIND: '0.0.0.0' } }), /DOCS_PUBLIC_ORIGIN required/);
  for (const DOCS_PUBLIC_ORIGIN of ['http://user:secret@example.com', 'https://example.com/admin', 'secret']) {
    await assert.rejects(loadStartConfig({ directory, env: { DOCS_PUBLIC_ORIGIN } }), /origin without credentials/);
  }
});

test('both built portal pages must exist before starting any service', async t => {
  const directory = await fixture(t);
  for (const page of ['doc', 'admin']) {
    await rm(join(directory, 'dist', `${page}.html`));
    await assert.rejects(loadStartConfig({ directory, env: {} }), /run pnpm build first/);
    await writeFile(join(directory, 'dist', `${page}.html`), page);
  }
});

test('CLI fails closed without printing credentials or executing the server', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'server'));
  await writeFile(join(directory, 'server/origins.mjs'), await readFile(join(root, 'server/origins.mjs')));
  await writeFile(join(directory, 'scripts/start.mjs'), await readFile(join(root, 'scripts/start.mjs')));
  await writeFile(join(directory, 'server/index.mjs'), 'throw Error("server-must-not-run");');
  await writeFile(join(directory, '.env.development.local'), 'DATABASE_URL=invalid-connection\n');
  const result = spawnSync(process.execPath, ['scripts/start.mjs'], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: prod } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Startup failed/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret|db.example.test|postgresql:|server-must-not-run/);
});

test('CLI runs exactly the built Node entry with selected settings and sanitizes dependency errors', async t => {
  const directory = await fixture(t);
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'server'));
  await writeFile(join(directory, 'server/origins.mjs'), await readFile(join(root, 'server/origins.mjs')));
  await writeFile(join(directory, 'scripts/start.mjs'), await readFile(join(root, 'scripts/start.mjs')));
  await writeFile(join(directory, 'server/index.mjs'), `console.log(JSON.stringify({mode:process.env.NODE_ENV,port:process.env.PORT,origin:process.env.DOCS_PUBLIC_ORIGIN,db:new URL(process.env.DATABASE_URL).pathname}));`);
  for (const args of [[], ['--production']]) {
    const result = spawnSync(process.execPath, ['scripts/start.mjs', ...args], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { mode: args.length ? 'production' : 'development', port: '4391', origin: 'http://127.0.0.1:4391', db: args.length ? '/docs_prod' : '/docs_dev' });
  }
  await writeFile(join(directory, 'server/index.mjs'), 'throw Error(process.env.DATABASE_URL);');
  const failed = spawnSync(process.execPath, ['scripts/start.mjs'], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stdout + failed.stderr, /secret|db.example.test|postgresql:/);
});

test('package defaults do not invoke Docker and private env files stay ignored', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node scripts/start.mjs');
  assert.equal(pkg.scripts['start:prod'], 'node scripts/start.mjs --production');
  assert.match(pkg.scripts.test, /tests\/start.mjs/);
  for (const name of ['start', 'start:prod', 'test', 'build', 'dev']) assert.doesNotMatch(pkg.scripts[name], /scripts\/demo|\bdocker\b|migrations\/migrate/);
  assert.equal(pkg.scripts['demo:docker'], 'node scripts/demo.mjs');
  assert.equal(pkg.scripts['test:demo:docker'], 'node scripts/test-demo.mjs');
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '.env.development.local', '.env.production.local', '.env.example'], { cwd: root, encoding: 'utf8' });
  assert.equal(ignored.status, 0);
  assert.deepEqual(ignored.stdout.trim().split('\n'), ['.env.development.local', '.env.production.local']);
});
