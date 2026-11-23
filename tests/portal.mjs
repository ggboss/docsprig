import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { legacyDetailTarget, portalRedirect } from '../src/portal-routes.mjs';
import viteConfig from '../vite.config.mjs';
import { withPortal } from '../server/portal.mjs';

async function fixture(t, backend = () => assert.fail('unexpected backend call')) {
  const root = await mkdtemp(join(tmpdir(), 'portal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  const server = createServer(withPortal(backend, dist));
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  // Raw request targets: do not let a client URL parser normalize traversal test cases.
  const send = (path, method = 'GET', body) => new Promise((ok, fail) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method }, async res => {
      try {
        let body = ''; res.setEncoding('utf8'); for await (const chunk of res) body += chunk;
        ok({ status: res.statusCode, headers: res.headers, body });
      } catch (err) { fail(err); }
    });
    req.on('error', fail).end(body);
  });
  return { dist, root, send };
}

test('explicit page routing and asset caching', async t => {
  const { dist, send } = await fixture(t);
  for (const name of ['index', 'api', 'doc', 'admin', 'login']) await writeFile(join(dist, name + '.html'), name);
  for (const [path, name] of [['/doc?doc=a', 'doc'], ['/doc/', 'doc'], ['/api/reference/tag', 'api'], ['/login', 'login'],
    ['/api-reference', 'index'], ['/api-reference/tag', 'index'],
    ['/api-preview?doc=draft', 'index'], ['/api-preview/tag/operation?doc=draft', 'index'],
    ['/admin/', 'admin']]) {
    const r = await send(path);
    assert.equal(r.status, 200); assert.equal(r.body, name); assert.match(r.headers['content-type'], /^text\/html/);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  for (const [path, immutable] of [['assets/entry.client-Xy8_H3-f.js', true], ['assets/styles.css', false], ['logo-light.svg', false]]) {
    await writeFile(join(dist, path), 'asset');
    const r = await send('/' + path);
    assert.equal(r.status, 200); assert.equal(r.body, 'asset'); assert.equal(r.headers['cache-control'].includes('immutable'), immutable);
    const head = await send('/' + path, 'HEAD');
    assert.equal(head.body, ''); assert.equal(head.headers['content-length'], '5');
  }
  const post = await send('/api', 'POST'); assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
  for (const path of ['/api-preview-other', '/apiary', '/docs', '/doc-other', '/admin/nested', '/assets/missing.js']) assert.equal((await send(path)).status, 404);
});

test('public aliases redirect without needing a built page', async t => {
  const { send } = await fixture(t);
  for (const [from, to] of [['/', '/doc'], ['/api', '/doc'], ['/api/?tab=a&doc=x%2Fy&x=1&x=2', '/doc?tab=a&doc=x%2Fy&x=1&x=2'],
    ['/guides/?doc=a&lang=zh', '/doc?doc=a&lang=zh'], ['/changelog?tab=old&doc=a&x=1', '/doc?tab=changelog&doc=a&x=1']]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await send(from, method);
      assert.equal(res.status, 308); assert.equal(res.headers.location, to); assert.equal(res.body, '');
    }
  }
});

test('client redirects retain fragments and historical operation lookups', () => {
  for (const path of ['/', '/api', '/guides/']) assert.equal(portalRedirect(path, '?x=1', '#intro'), '/doc?x=1#intro');
  assert.equal(portalRedirect('/changelog', '?doc=d', '#intro'), '/doc?doc=d&tab=changelog#intro');
  for (const path of ['/doc', '/api-reference', '/api-preview/tag', '/api/tag']) assert.equal(portalRedirect(path), undefined);
  const items = [{id:'a&b', detailRoutes:['/api/示例#操作']}];
  const location = {pathname:encodeURI('/api/示例'), hash:encodeURI('#操作'), search:'?lang=zh'};
  assert.equal(legacyDetailTarget(location, items), `/doc?lang=zh&doc=a%26b${location.hash}`);
  assert.equal(legacyDetailTarget(location, []), `/doc?lang=zh${location.hash}`);
  assert.equal(legacyDetailTarget({...location, search:'?doc=explicit'}, items), `/doc?doc=explicit${location.hash}`);
});

test('Vite dev and preview agree on aliases and leave native routes independent', () => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const stack = [];
    viteConfig.plugins[0][hook]({ middlewares: { use: fn => stack.push(fn) } });
    for (const [url, redirect, previewFile] of [
      ['/api?doc=a', '/doc?doc=a'], ['/guides?x=1', '/doc?x=1'], ['/changelog', '/doc?tab=changelog'],
      ['/doc/?doc=a', undefined, '/doc.html'], ['/api/old-tag', undefined, '/api.html'],
      ['/api-reference/tag?spec=a', undefined, '/index.html'], ['/api-preview/tag?v=1', undefined, '/index.html'],
    ]) {
      const req = { method: 'GET', url }; let location;
      const res = { writeHead(status, headers) { assert.equal(status, 308); location = headers.Location; }, end() {} };
      let i = 0; const next = () => stack[i++]?.(req, res, next); next();
      assert.equal(location, redirect);
      assert.equal(req.url, hook === 'configurePreviewServer' && previewFile ? previewFile : url);
    }
  }
});

test('reserved namespaces exclusively belong to backend, including failures', async t => {
  const seen = [];
  const { dist, send } = await fixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push([req.url, req.method, body]);
    if (req.url === '/content/throws') throw new Error('private message');
    res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"backend"}');
  });
  await mkdir(join(dist, 'content/dev/current'), { recursive: true });
  await writeFile(join(dist, 'content/dev/current/tree.json'), 'bundled');
  await writeFile(join(dist, 'index.html'), 'shell');
  for (const [path, method, body] of [['/content', 'GET', ''], ['/content/site-name.json', 'GET', ''], ['/manage/site-name', 'PUT', 'payload'], ['/content/dev/current/tree.json', 'GET', ''],
    ['/manage?x=1', 'GET', ''], ['/manage/preview?doc=draft', 'GET', ''], ['/manage/workspace?x=1', 'PUT', 'payload'], ['/content/%zz', 'GET', '']]) {
    const r = await send(path, method, body); assert.deepEqual(seen.at(-1), [path, method, body]);
    assert.equal(r.status, 403); assert.equal(r.body, '{"error":"backend"}');
  }
  const r = await send('/content/throws'); assert.equal(r.status, 500); assert.equal(r.headers['content-type'].includes('html'), false);
  assert.doesNotMatch(r.body, /private|bundled|shell/);
});

test('rejects traversal, symlinks and non-public build files', async t => {
  const { dist, root, send } = await fixture(t);
  await writeFile(join(dist, 'index.html'), 'shell');
  await writeFile(join(root, 'private.js'), 'private');
  for (const name of ['package.json', 'zudoku.config.tsx', 'assets/client.js.map', 'assets/temp.html']) await writeFile(join(dist, name), 'private');
  await symlink(join(root, 'private.js'), join(dist, 'assets/link.js'));
  await symlink(join(dist, 'index.html'), join(dist, 'admin.html'));
  for (const path of ['/api/../index.html', '/api/%2e%2E/index.html', '/api/%252e%252e/private.js', '/api/a%5cb',
    '/api/%00', '/api/%zz', '//api', '/assets/link.js', '/admin', '/package.json', '/zudoku.config.tsx', '/assets/client.js.map', '/assets/temp.html']) {
    assert.equal((await send(path)).status, 404, path);
  }
  await rm(join(dist, 'assets'), { recursive: true });
  await symlink(root, join(dist, 'assets'));
  assert.equal((await send('/assets/private.js')).status, 404);
});


test('development gateway proxies the exact public site-name route', async () => {
  const target = 'http://127.0.0.1:4191';
  const previous = process.env.OPEN_DOCS_BACKEND;
  process.env.OPEN_DOCS_BACKEND = target;
  try {
    const {default:config} = await import('../vite.config.mjs?site-name-proxy');
    for (const {proxy} of [config.server,config.preview]) {
      const forwards = url => Object.entries(proxy).some(([key,rule]) => rule.target === target &&
        (key.startsWith('^') ? new RegExp(key).test(url) : url.startsWith(key)));
      assert.ok(forwards('/content/site-name.json')); assert.ok(forwards('/content/site-name.json?v=1'));
      assert.ok(forwards('/manage/site-name')); assert.ok(!forwards('/content/site-name.json.bak'));
    }
  } finally {
    if (previous === undefined) delete process.env.OPEN_DOCS_BACKEND; else process.env.OPEN_DOCS_BACKEND = previous;
  }
});


test('MCP namespace forwards protocol requests without static fallback', async t => {
  let seen;
  const {send}=await fixture(t,async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    seen={url:req.url,method:req.method,body};res.writeHead(401,{'Content-Type':'application/json'}).end('{"error":"unauthorized"}');
  });
  const response=await send('/mcp/admin','POST','{"jsonrpc":"2.0","method":"tools/list","id":1}');
  assert.equal(response.status,401);assert.equal(seen.url,'/mcp/admin');assert.equal(seen.method,'POST');
  assert.match(seen.body,/tools\/list/);assert.equal(response.body,'{"error":"unauthorized"}');
  assert.equal((await send('/mcp-other')).status,404);
});
