import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvironment } from './start.mjs';
import { migrate, migrationSettings } from '../migrations/migrate.mjs';

export async function runMigration(options = {}, execute = async (config, settings) => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: config.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try { await migrate(pool, settings.expected, { seed: settings.seed, production: config.mode === 'production' }); }
  finally { await pool.end(); }
}) {
  const config = await loadEnvironment(options);
  const settings = migrationSettings(config.env, { production: config.mode === 'production' });
  await execute(config, settings);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await runMigration({ args: process.argv.slice(2) });
    console.log('Database migration complete.');
  } catch {
    console.error('Database migration failed. Check the selected private environment file, DATABASE_URL, DOCS_DATABASE and initialization mode.');
    process.exitCode = 1;
  }
}
