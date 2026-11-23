// Explicit opt-in: node scripts/test-demo.mjs (never part of the default test run).
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const host = '127.0.0.1';
async function reservePorts() {
  const sockets = [], ports = [];
  try {
    while (ports.length < 2) {
      const s = createServer(); sockets.push(s);
      s.listen(0, host); await once(s, 'listening');
      const { port } = s.address();
      if (port !== 4180 && port !== 4191) ports.push(port);
    }
    return ports;
  } finally { await Promise.all(sockets.filter(s => s.listening).map(s => new Promise(ok => s.close(ok)))); }
}
async function main() {
  const [frontend, api] = await reservePorts();
  const built = process.argv.includes('--built');
  const web = built ? api : frontend;
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  const demo = fork('scripts/demo.mjs', [built ? '--smoke-built' : '--smoke'], { cwd, execArgv: [], env: { ...env, DEMO_WEB_PORT: String(web), DEMO_API_PORT: String(api) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const closed = once(demo, 'exit');
  let browser, browserClosed, abort;
  const interrupted = new Promise((_, reject) => { abort = () => reject(Error('Smoke interrupted')); });
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const timer = setTimeout(abort, 180_000);
  const stopped = closed.then(([code, signal]) => { throw Error(`Demo stopped before smoke finished (${code ?? signal})`); });
  try {
    const [msg] = await Promise.race([once(demo, 'message'), stopped, interrupted]);
    assert.equal(msg.type, 'demo-ready');
    assert.equal(msg.origin, `http://${host}:${web}`);
    assert.equal(msg.authMode, 'standalone', 'Demo must use standalone login');
    console.log(`Disposable ${built ? 'built' : 'dev'} demo ready: web ${web}, API ${api}`);
    browser = spawn(process.execPath, ['tests/browser-smoke.mjs'], { cwd, stdio: 'inherit', env: { ...env,
      ...(process.env.SMOKE_PLAYWRIGHT && { SMOKE_PLAYWRIGHT: process.env.SMOKE_PLAYWRIGHT }),
      SMOKE_BROWSER_CHANNEL: process.env.SMOKE_BROWSER_CHANNEL || '', SMOKE_PORT: String(web), SMOKE_DISPOSABLE: 'yes' } });
    browserClosed = once(browser, 'close');
    const [code, signal] = await Promise.race([browserClosed, stopped, interrupted]);
    assert.equal(code, 0, `Browser smoke failed (${code ?? signal})`);
  } finally {
    clearTimeout(timer);
    if (browser && browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
    if (demo.connected) demo.disconnect(); // demo handles disconnect and removes its own container/volume/tempdir
    try {
      const [[code, signal]] = await Promise.all([closed, browserClosed]);
      assert.equal(code, 0, `Demo failed during startup or cleanup (${code ?? signal})`);
    } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
  }
}
await main().catch(err => { console.error(err.message); process.exitCode = 1; });
