// Standalone: all browser responses come from dist or this in-memory fixture.
// No HTTP listener, backend imports, real sessions, or network pass-through.
import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:18765', dist = new URL('../dist/', import.meta.url);
const docPath = '/admin?doc=note';
const workspace = () => ({revision: 7, published: null, nodes: [
  {id: 'root', parentId: null, sort: 0, title: '测试栏目', type: 'group', body: '', draftVersion: 1, publishedVersion: null},
  {id: 'note', parentId: 'root', sort: 0, title: '初始文档', type: 'markdown', body: '初始正文', draftVersion: 2, publishedVersion: null},
]});
const mime = {'.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.woff2':'font/woff2'};
const button = (scope, name) => scope.getByRole('button', {name, exact: true});

async function fixture(browser, t, signedIn = true) {
  const context = await browser.newContext({serviceWorkers: 'block', viewport: {width: 1400, height: 1000}});
  const f = {signedIn, state: workspace(), attempts: [], reads: 0, loginCount: 0, logoutCount: 0, unexpected: [], errors: []};
  let plan;
  // An intentionally delayed response makes repeated saves during an in-flight write observable.
  f.arm = outcome => {
    assert.ok(!plan);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    plan = {outcome, gate};
    return release;
  };
  await context.routeWebSocket('**/*', ws => { f.unexpected.push('WebSocket'); return ws.close(); });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), key = `${req.method()} ${url.pathname}`;
    const deny = () => { f.unexpected.push(key); return route.abort(); };
    if (url.origin !== origin) {
      if (['document','xhr','fetch'].includes(req.resourceType())) return deny();
      return route.abort(); // The built page may include a CDN favicon. Never fetch it.
    }
    const json = (status, data) => route.fulfill({status, json: data, headers: {'Cache-Control':'no-store'}});
    if (key === 'GET /content/site-name.json') return json(200, {name:'测试文档站'});
    if (key === 'GET /content/dev/current/tree.json') return json(404, {});
    if (key === 'GET /manage/session') return json(f.signedIn ? 200 : 401, {admin:f.signedIn});
    if (key === 'POST /manage/login') {
      f.loginCount++;
      const {username, password} = req.postDataJSON();
      f.signedIn = username === 'fixture' && password === 'fixture-only';
      return json(f.signedIn ? 200 : 401, {admin:f.signedIn});
    }
    if (key === 'POST /manage/logout') { f.logoutCount++; f.signedIn = false; return json(200, {}); }
    if (key === 'GET /manage/workspace') { f.reads++; return json(f.signedIn ? 200 : 401, f.signedIn ? f.state : {}); }
    if (key === 'PUT /manage/node') {
      const input = req.postDataJSON(); f.attempts.push(input);
      const next = plan; plan = undefined;
      if (!next) return deny(); // Even a valid write route requires a single-use expectation.
      await next.gate;
      if (next.outcome === 'offline') return route.abort('connectionreset');
      if (next.outcome === 401) f.signedIn = false;
      if (next.outcome !== 200) return json(next.outcome, {error:`fixture-${next.outcome}`});
      const previous = f.state.nodes.find(n => n.id === input.node.id);
      if (!previous || input.revision !== f.state.revision) return deny();
      f.state = {...f.state, revision:f.state.revision + 1, nodes:f.state.nodes.map(n => n === previous
        ? {...input.node, draftVersion:n.draftVersion + 1} : n)};
      return json(200, f.state);
    }
    if (req.method() !== 'GET') return deny();
    const path = url.pathname;
    const file = ['/login','/admin'].includes(path) ? `${path.slice(1)}.html`
      : /^\/assets\/[\w.-]+\.(?:js|css|woff2)$/.test(path) || /^\/logo-(?:light|dark)\.svg$/.test(path) ? path.slice(1) : null;
    if (!file) return deny();
    try { return await route.fulfill({contentType:mime[extname(file)], body:await readFile(new URL(file, dist))}); }
    catch (error) { if (!context.pages().length) return; throw error; }
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', e => f.errors.push(e.message));
  t.after(async () => { await context.close(); assert.deepEqual(f.unexpected, [], 'Unexpected requests were blocked'); assert.deepEqual(f.errors, []); });
  const editor = page.getByRole('region', {name:'节点编辑器'}), status = editor.getByRole('status');
  const title = editor.getByLabel('名称', {exact:true}), body = editor.getByRole('textbox', {name:'Markdown 可视化正文'});
  return Object.assign(f, {page, editor, status, title, body, save:button(editor,'保存草稿'),
    async open() { await page.goto(origin + docPath); await status.filter({hasText:'已读取工作区'}).waitFor(); },
    async edit() { await button(editor,'编辑').click(); await body.waitFor(); },
    async login(password) {
      // The pre-rendered form is visible before React attaches its submit handler.
      await page.getByRole('navigation',{name:'文档栏目'}).waitFor();
      await page.getByLabel('账号',{exact:true}).fill('fixture'); await page.getByLabel('密码',{exact:true}).fill(password); await button(page,'登录').click(); },
    async submit(outcome, repeat = false) {
      const count = f.attempts.length, release = f.arm(outcome);
      try {
        await Promise.all([page.waitForRequest(r => r.url() === origin+'/manage/node' && r.method() === 'PUT'), f.save.click()]);
        await status.filter({hasText:'正在保存'}).waitFor();
        assert.ok(await f.save.isDisabled());
        if (repeat) { await title.focus(); await page.keyboard.press('ControlOrMeta+s'); }
      } finally { release(); }
      const expected = {200:'草稿已保存', 400:'fixture-400', 422:'fixture-422', 409:'服务器版本已改变', offline:'无法确认服务器状态'};
      if (outcome !== 401) await status.filter({hasText:expected[outcome]}).waitFor();
      else await page.getByLabel('密码',{exact:true}).waitFor();
      assert.equal(f.attempts.length, count + 1);
      return f.attempts[count];
    },
  });
}

async function attemptDisabledSave(f, input) {
  assert.ok(await f.save.isDisabled());
  // locator.click would wait for enablement. Use a real pointer on the disabled button instead.
  await f.save.scrollIntoViewIfNeeded();
  const box = await f.save.boundingBox();
  assert.ok(box);
  await f.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await input.press('ControlOrMeta+s');
}

async function chooseDialog(page, accept, action) {
  const seen = page.waitForEvent('dialog').then(async dialog => {
    assert.equal(dialog.type(), 'confirm'); assert.match(dialog.message(), /未保存/);
    await (accept ? dialog.accept() : dialog.dismiss());
  });
  await Promise.all([seen, action()]);
}

test('isolated built admin UI: auth, unsaved edits and failure recovery', {timeout: 120_000}, async t => {
  await access(new URL('admin.html', dist));
  const browser = await chromium.launch({channel:process.env.SMOKE_BROWSER_CHANNEL || undefined});
  t.after(() => browser.close());

  await t.test('login error, safe return path, logout and unsafe next fallback', async t => {
    const f = await fixture(browser,t,false), {page} = f;
    const destination = docPath + '#details';
    await page.goto(origin + destination);
    await page.getByLabel('密码',{exact:true}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('next'), destination);
    await f.login('incorrect'); await page.getByRole('alert').filter({hasText:'账号或密码错误'}).waitFor();
    assert.equal(new URL(page.url()).pathname, '/login'); assert.equal(f.reads,0);
    await f.login('fixture-only'); await f.editor.getByRole('heading',{name:'初始文档'}).waitFor();
    assert.equal(page.url(), origin + destination);
    await button(page,'退出登录').click(); await page.getByLabel('密码',{exact:true}).waitFor();
    assert.equal(page.url(), origin+'/login'); assert.equal(f.logoutCount,1);
    await page.goto(origin + docPath); await page.getByLabel('密码',{exact:true}).waitFor();
    await page.goto(origin + '/login?next=' + encodeURIComponent('//outside.invalid/admin?doc=note'));
    await f.login('fixture-only'); await f.editor.getByRole('heading',{name:'测试栏目'}).waitFor();
    assert.equal(page.url(), origin+'/admin?doc=root'); assert.equal(f.loginCount,3);
  });

  await t.test('400/422 retain editable draft; 409 locks it until confirmed refresh and merge', async t => {
    const f = await fixture(browser,t); await f.open(); await f.edit();
    await f.title.fill('本地草稿'); await f.body.fill('本地未保存正文');
    const baseline = structuredClone(f.state);
    for (const code of [400,422,409]) {
      const input = await f.submit(code,true);
      assert.equal(input.node.body,'本地未保存正文'); assert.equal(input.node.title,'本地草稿'); assert.equal(input.revision,7);
      assert.equal(await f.title.inputValue(),'本地草稿'); assert.equal(await f.body.innerText(),'本地未保存正文');
      assert.deepEqual(f.state,baseline); assert.equal(await f.save.isDisabled(),code === 409);
    }
    const reads = f.reads;
    const refresh = () => button(f.editor,'刷新').click();
    await chooseDialog(f.page,false,refresh); assert.equal(f.reads,reads);
    assert.equal(await f.body.innerText(),'本地未保存正文');
    f.state.revision++; Object.assign(f.state.nodes[1],{title:'他人保存的标题',body:'服务器新正文',draftVersion:3});
    await chooseDialog(f.page,true,refresh); await f.status.filter({hasText:'已读取工作区'}).waitFor();
    assert.equal(f.reads,reads+1); assert.equal(await f.title.inputValue(),'他人保存的标题');
    assert.equal(await f.body.innerText(),'服务器新正文'); assert.ok(await f.save.isDisabled());
    await f.body.fill('合并后的正文'); const merged = await f.submit(200,true);
    assert.equal(merged.revision,8); assert.equal(merged.node.body,'合并后的正文'); assert.equal(merged.node.title,'他人保存的标题');
    assert.equal(f.attempts.length,4); assert.ok(await f.save.isDisabled());
  });

  await t.test('aborted save retains draft without retry; 401 on explicit save redirects to login', async t => {
    const f = await fixture(browser,t); await f.open(); await f.edit();
    await f.body.fill('网络故障时仍可复制'); await f.submit('offline',true);
    assert.equal(await f.body.innerText(),'网络故障时仍可复制'); assert.ok(await f.save.isDisabled());
    await chooseDialog(f.page,true,() => button(f.editor,'刷新').click()); await f.status.filter({hasText:'已读取工作区'}).waitFor();
    await f.title.fill('会话已过期');
    // A real dirty document can trigger the browser's native beforeunload on 401 navigation.
    f.page.on('dialog', d => d.type() === 'beforeunload' ? d.accept() : d.dismiss());
    await f.submit(401); const url = new URL(f.page.url());
    assert.equal(url.pathname,'/login'); assert.equal(url.searchParams.get('next'),docPath);
    assert.equal(f.attempts.length,2); assert.deepEqual(f.state,workspace());
  });

  await t.test('invalid title/API block click and shortcut; cancel or confirm leaving unsaved edits', async t => {
    const f = await fixture(browser,t); await f.open(); await f.edit();
    await f.title.fill('   '); await attemptDisabledSave(f,f.title);
    await f.title.fill('不应保存'); const leave = () => button(f.editor,'返回阅读').click();
    await chooseDialog(f.page,false,leave); assert.equal(await f.title.inputValue(),'不应保存');
    await chooseDialog(f.page,true,leave); await f.editor.getByRole('heading',{name:'初始文档'}).waitFor();
    const nav = f.page.getByRole('navigation',{name:'工作区目录'});
    await button(nav,'在「测试栏目」中新增').click(); await button(nav,'新增接口').click();
    await button(f.editor,'源码').click(); const yaml = f.editor.getByLabel('YAML 正文');
    await yaml.fill('paths: ['); await f.editor.getByText(/YAML 解析失败/).waitFor();
    assert.equal(await yaml.getAttribute('aria-invalid'),'true'); await attemptDisabledSave(f,yaml);
    await chooseDialog(f.page,true,leave);
    assert.equal(f.attempts.length,0); assert.deepEqual(f.state,workspace());
  });
});
