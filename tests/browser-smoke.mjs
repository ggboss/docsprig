// Writes are permitted only in the disposable demo started by scripts/test-demo.mjs.
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { assertNoMarkdownModes, markdownInput, runVisualEditorRegression } from './browser-editors.mjs';
import { runOrganizationRegression } from './browser-organization.mjs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SMOKE_PLAYWRIGHT || 'playwright');
const port = process.env.SMOKE_PORT;
assert.equal(process.env.SMOKE_DISPOSABLE, 'yes', 'Run node scripts/test-demo.mjs --built; never target a persistent database');
assert.match(port ?? '', /^\d{1,5}$/);
assert.ok(+port > 0 && +port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const nonce = Date.now().toString(36);
const names = { initial:`Smoke tab ${nonce}`, tab:`Published tab ${nonce}`, group:`Nested ${nonce}`,
  md:`Markdown ${nonce}`, api:`API ${nonce}`, private:`Private draft ${nonce}` };
const operationPath = `/smoke/${nonce}`;
const summary = `Lookup ${nonce}`, description = `Published operation ${nonce}`;
const markdownTitle = '社区声音档案采集手册';
const markdownEnd = '北廊晨间录音已交接。';
const fixture = await readFile(new URL('./fixtures/long-markdown.zh-CN.md',import.meta.url),'utf8');
const markdown = fixture + '\n<script>window.smokeInjected = true</script>\n';
const badgeSource = await readFile(new URL('../public/content/dev/releases/demo-001/badge.svg',import.meta.url),'utf8');
const externalImageURL = 'https://markdown-image.invalid/should-not-load.svg';
const externalImageAttempts = [];
const yaml = stringify({
  openapi: '3.1.0', 'x-open-docs-document-kind': 'operation',
  info: { title: `Smoke API ${nonce}`, version: '1.0.0' },
  paths: { [operationPath]: { get: {
    operationId: `smoke${nonce}`, summary, description, tags: ['Smoke'],
    parameters: Array.from({ length: 8 }, (_, i) => ({ name: `query${i}`, in: 'query',
      description: `Smoke query field ${i}`, schema: { type: 'string' } })),
    responses: { '200': { description: `Smoke response ${nonce}`, content: {
      'application/json': { schema: { type: 'object', properties: { result: { type: 'string' } } } },
    } } },
  } } },
});
const editedYaml = yaml.replace(summary, `${summary} edited`);
const roots = workspace => workspace.nodes.filter(n => n.parentId === null).sort((a,b) => a.sort-b.sort);
let browser, step = 'launch isolated browser';
const errors = [], failures = [], diagnosticPages = [];
try {
  browser = await chromium.launch({ channel:process.env.SMOKE_BROWSER_CHANNEL || undefined });
  async function context() {
    const c = await browser.newContext({ serviceWorkers:'block', viewport:{width:1440,height:1000} });
    await c.route('**/*', route => {
      if (route.request().url()===externalImageURL) externalImageAttempts.push(route.request().url());
      return new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
    });
    await c.routeWebSocket('**/*', ws => ws.close());
    return c;
  }
  async function newPage(c) {
    const p = await c.newPage(); p.setDefaultTimeout(15000);
    diagnosticPages.push(p);
    p.on('pageerror', e => errors.push(`${new URL(p.url()).pathname}: ${e.message.split('\n')[0]}`));
    return p;
  }
  const admin = await context(), anonymous = await context();
  const page = await newPage(admin), reader = await newPage(anonymous);
  const wb = page.getByRole('region', {name:'文档管理工作区'});
  const editor = wb.getByRole('region', {name:'节点编辑器'});
  const nav = wb.getByRole('navigation', {name:'工作区目录'});
  const tabs = page.getByRole('tablist', {name:'管理栏目'});
  const publicTabs = reader.getByRole('navigation', {name:'文档栏目'});
  const publicTree = reader.getByRole('navigation', {name:'当前栏目文档目录'});
  const publicContent = reader.getByRole('region', {name:'已发布文档'});
  const button = (scope,name) => scope.getByRole('button', {name,exact:true});
  const ready = () => wb.getByRole('status').filter({hasText:'已读取工作区'}).waitFor();
  async function workspace() {
    const response = await admin.request.get(origin+'/manage/workspace');
    assert.equal(response.status(),200); return response.json();
  }
  async function liveTree() {
    const response = await anonymous.request.get(origin+'/content/dev/current/tree.json');
    assert.equal(response.status(),200); return response.json();
  }
  async function siteName() {
    const response = await anonymous.request.get(origin+'/content/site-name.json');
    assert.equal(response.status(),200);
    assert.equal(response.headers()['cache-control'],'no-store');
    return response.json();
  }
  async function checkBrand(owner,name,canEdit) {
    const brand = owner.getByRole('link',{name,exact:true});
    await brand.waitFor();
    assert.equal(await brand.count(),1,'One runtime site name is shown');
    assert.equal(await brand.getAttribute('title'),name);
    assert.equal(new URL(await brand.getAttribute('href'),origin).pathname,'/doc');
    await owner.waitForFunction(name=>document.title===name || document.title.endsWith(` | ${name}`),name);
    const edit = button(owner,'编辑站点名称');
    if (canEdit) await edit.waitFor();
    else {
      assert.equal(await edit.count(),0,'Anonymous visitors cannot edit the site name');
      assert.equal(await owner.getByRole('textbox',{name:'站点名称',exact:true}).count(),0);
    }
  }
  async function checkLoginNavigation() {
    const manifest = await liveTree();
    const expected = roots(manifest);
    assert.ok(expected.length>0,'Navigation parity needs published roots');
    const doc = await newPage(anonymous), login = await newPage(anonymous);
    try {
      const links = async owner => {
        const navigation = owner.getByRole('navigation',{name:'文档栏目',exact:true});
        await navigation.waitFor();
        assert.equal(await navigation.count(),1,'Only one published-tab navigation is rendered');
        for (const root of expected) await navigation.getByRole('link',{name:root.title,exact:true}).waitFor();
        const actual = await navigation.getByRole('link').evaluateAll(items=>items.map(item=>({
          title:item.textContent.trim(),href:item.getAttribute('href'),
        })));
        assert.deepEqual(actual.map(item=>item.title),expected.map(root=>root.title),'Only published roots appear in published order');
        for (const [index,item] of actual.entries()) {
          const url = new URL(item.href,origin);
          assert.equal(url.origin,origin);
          assert.equal(url.pathname,'/doc');
          assert.equal(url.searchParams.get('tab'),expected[index].id);
          const docId = url.searchParams.get('doc');
          if (docId) assert.ok(manifest.nodes.some(node=>node.id===docId && node.type!=='group'),'Tab links cannot target an unpublished document');
        }
        for (const name of new Set(expected.map(root=>root.title))) {
          assert.equal(await owner.getByRole('link',{name,exact:true}).count(),
            expected.filter(root=>root.title===name).length,'No duplicate static menu links outside published navigation');
        }
        return actual;
      };
      await doc.goto(origin+'/doc');
      const docLinks = await links(doc);
      await login.goto(origin+'/login');
      await login.getByRole('heading',{name:'登录文档管理',exact:true}).waitFor();
      assert.deepEqual(await links(login),docLinks,'Login and doc use identical current published tab links and ordering');
      assert.equal(await login.getByRole('navigation',{name:'文档栏目'}).locator('[aria-current="page"]').count(),0,
        'Login does not select a documentation tab');
      const name = (await siteName()).name;
      await checkBrand(doc,name,false); await checkBrand(login,name,false);
    } finally { await doc.close(); await login.close(); }
  }
  async function editSiteName() {
    await checkBrand(page,'文档平台',true);
    const before = await workspace();
    await button(page,'编辑站点名称').click();
    const input = page.getByRole('textbox',{name:'站点名称',exact:true});
    assert.equal(await input.inputValue(),'文档平台');
    await input.fill(`Cancelled name ${nonce}`);
    await button(page,'取消').click();
    await input.waitFor({state:'detached'});
    assert.deepEqual(await siteName(),{name:'文档平台'},'Cancel must not persist a name change');
    await button(page,'编辑站点名称').click();
    const name = `Smoke 文档 ${nonce}`;
    await input.fill(name);
    const [response] = await Promise.all([
      page.waitForResponse(r=>r.url()===origin+'/manage/site-name' && r.request().method()==='PUT'),
      button(page,'保存站点名称').click(),
    ]);
    assert.equal(response.status(),200);
    assert.deepEqual(response.request().postDataJSON(),{name});
    assert.deepEqual(await response.json(),{name});
    await input.waitFor({state:'detached'});
    await checkBrand(page,name,true);
    await page.reload(); await ready();
    await checkBrand(page,name,true);
    assert.deepEqual(await siteName(),{name},'Saved name persists independently of the loaded page');
    assert.deepEqual(await workspace(),before,'Renaming the site must not change drafts, tabs, revisions or the published release');
    await reader.reload(); await checkBrand(reader,name,false);
    const login = await newPage(anonymous), signedInLogin = await newPage(admin);
    const loginManagement = [];
    signedInLogin.on('request',request=>{
      if (new URL(request.url()).pathname.startsWith('/manage/')) loginManagement.push(request.url());
    });
    try {
      await login.goto(origin+'/login'); await checkBrand(login,name,false);
      await signedInLogin.goto(origin+'/login'); await checkBrand(signedInLogin,name,false);
      assert.deepEqual(loginManagement,[],'Login branding is read-only even with an existing admin cookie');
    } finally { await login.close(); await signedInLogin.close(); }
    return name;
  }
  async function mutate(action,method,endpoint) {
    const [response] = await Promise.all([page.waitForResponse(r => r.request().method()===method && r.url()===origin+endpoint),action()]);
    assert.equal(response.status(),200,`${method} ${endpoint}: ${response.status()}`);
    // Login replaces the entire document immediately; CDP may evict its body.
    if (endpoint === '/manage/login') return;
    const data = await response.json();
    await wb.getByRole('status').filter({hasText:method==='PUT'?'草稿已保存':'发布成功'}).waitFor();
    return data;
  }
  async function confirmAction(action,expected,accept=true) {
    const dialogPromise = page.waitForEvent('dialog');
    const clickPromise = action();
    const dialog = await dialogPromise;
    const valid = dialog.type()==='confirm' && dialog.message().includes(expected);
    await (valid && accept ? dialog.accept() : dialog.dismiss());
    await clickPromise; assert.ok(valid,`Expected confirmation: ${expected}`);
  }
  async function selectTab(name) {
    await tabs.getByRole('tab',{name,exact:true}).click();
    await tabs.getByRole('tab',{name,exact:true,selected:true}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/admin');
    await button(nav,`在「${name}」中新增`).waitFor();
  }
  async function apiSourceMode() {
    await button(editor,'源码').click();
    await wb.getByLabel('YAML 正文').waitFor();
  }
  async function beginNode(tab,parent,type,name) {
    await selectTab(tab);
    await button(nav,`在「${parent}」中新增`).click();
    await button(nav,`新增${{group:'子目录',markdown:'文档',api:'接口'}[type]}`).click();
    await page.waitForFunction(() => document.activeElement?.id==='wb-title');
    await wb.getByLabel('名称',{exact:true}).fill(name);
    if (type==='api') {
      assert.equal(await button(editor,'表单编辑').getAttribute('aria-pressed'),'true');
      assert.equal(await wb.getByLabel('YAML 正文').count(),0,'API source textarea is opt-in');
    }
  }
  async function createNode(tab,parent,type,name,body='') {
    await beginNode(tab,parent,type,name);
    if (type==='api') {
      await apiSourceMode();
      await wb.getByLabel('YAML 正文').fill(body);
    } else if (type==='markdown') {
      await markdownInput(editor).fill(body);
      await assertNoMarkdownModes(editor);
    }
    const saved = await mutate(()=>button(wb,'保存草稿').click(),'PUT','/manage/node');
    const node = saved.nodes.find(n => n.title===name && n.type===type);
    assert.ok(node,`Missing saved ${type} ${name}`); assert.equal(node.body,body); assert.equal(node.publishedVersion,null);
    return node;
  }
  async function publishNode(name) {
    return mutate(()=>confirmAction(()=>button(wb,'发布此节点').click(),`「${name}」`),'POST','/manage/publish');
  }
  async function publishTabs() {
    return mutate(()=>confirmAction(()=>button(page,'发布栏目').click(),'发布所有栏目'),'POST','/manage/tabs/publish');
  }
  async function renameTab(from,to) {
    await button(page,`编辑栏目「${from}」`).click();
    const dialog = page.getByRole('form',{name:'编辑栏目'});
    await dialog.getByLabel('栏目名称').fill(to);
    const saved = await mutate(()=>button(dialog,'保存栏目').click(),'PUT','/manage/tabs');
    await dialog.waitFor({state:'hidden'}); return saved;
  }
  async function readAdmin(name) {
    await button(nav,name).click();
    await editor.getByRole('heading',{name,exact:true}).waitFor();
    assert.equal(await wb.getByLabel('YAML 正文').count(),0);
    assert.equal(await wb.getByLabel('Markdown 正文').count(),0);
  }
  async function nativeFrame(owner,selector) {
    const frame = owner.frameLocator(selector);
    await frame.getByText(operationPath,{exact:true}).first().waitFor();
    await frame.getByText('GET',{exact:true}).first().waitFor();
    await frame.getByText('query0',{exact:true}).first().waitFor();
    await frame.getByText(description,{exact:true}).first().waitFor();
    await frame.getByText('200',{exact:true}).first().waitFor();
    // Verify real child content fits the measured frame, not just a hardcoded CSS height.
    await owner.waitForFunction(selector => {
      const iframe = document.querySelector(selector), doc = iframe?.contentDocument;
      const main = doc?.querySelector('main');
      if (!main || !iframe.contentWindow) return false;
      const bottom = main.getBoundingClientRect().bottom + iframe.contentWindow.scrollY;
      return bottom>360 && iframe.clientHeight>=bottom-2 && iframe.clientHeight<bottom+80 &&
        doc.documentElement.scrollHeight<=iframe.contentWindow.innerHeight+2;
    },selector);
  }
  async function adminWidths(mode) {
    for (const width of [390,1024]) {
      await page.setViewportSize({width,height:900});
      if (mode==='reading') await nativeFrame(page,'iframe[title="接口文档预览"]');
      // Wait for the viewport-driven React/layout effects, not a CUA override.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const dimensions = await page.evaluate(() => ({
        viewport:window.innerWidth,
        document:document.documentElement.scrollWidth,
        body:document.body.scrollWidth,
      }));
      assert.equal(dimensions.viewport,width,`Admin ${mode}: actual viewport must be ${width}px`);
      assert.ok(dimensions.document<=width+1 && dimensions.body<=width+1,
        `Admin ${mode} overflows at ${width}px: ${JSON.stringify(dimensions)}`);
    }
    await page.setViewportSize({width:1440,height:1000});
  }
  async function checkLongRead(owner,content,directory,label) {
    const article = content.getByRole('article');
    const heading = article.getByRole('heading',{name:markdownTitle,exact:true});
    const end = article.getByText(markdownEnd,{exact:true});
    await heading.scrollIntoViewIfNeeded();
    const before = await directory.boundingBox(), start = await heading.boundingBox();
    const tail = await end.boundingBox(), {height} = owner.viewportSize();
    assert.ok(before && before.y>=0 && before.y<height && start && tail?.y>height,`${label}: expected visible directory and off-screen ending`);
    await owner.mouse.move(start.x+start.width/2,start.y+start.height/2);
    await owner.mouse.wheel(0,560);
    const tailElement = await end.elementHandle();
    await owner.waitForFunction(({el,y}) => el.getBoundingClientRect().top<y-300,{el:tailElement,y:tail.y});
    const after = await directory.boundingBox();
    assert.ok(after && Math.abs(after.y-before.y)<=2,`${label}: directory moved from ${before.y} to ${after?.y}`);
    const remaining = await end.boundingBox();
    await owner.mouse.wheel(0,Math.max(0,Math.ceil(remaining.y-height/2)));
    await owner.waitForFunction(el => {
      const box = el.getBoundingClientRect();
      return box.top>=0 && box.bottom<=window.innerHeight+1;
    },tailElement);
    await tailElement.dispose();
    await owner.setViewportSize({width:390,height:844});
    const widths = await owner.evaluate(()=>[document.documentElement.scrollWidth,document.body.scrollWidth]);
    assert.ok(widths.every(w=>w<=391),`${label}: page overflows 390px viewport: ${widths}`);
    await owner.setViewportSize({width:1440,height:1000});
  }
  async function markdownCheck(label,check) {
    try { await check(); }
    catch (error) {
      const detail = `${label}: ${error.message}`;
      failures.push(detail); console.error('PRODUCT FAILURE: '+detail);
    }
  }
  async function checkMarkdownFeatures(owner,article,label,publicImage=false) {
    await article.getByRole('heading',{name:markdownTitle,exact:true}).waitFor();
    await markdownCheck(`${label} GFM table`,async()=>{
      const table = article.getByRole('table');
      assert.equal(await table.count(),1,'Markdown pipe table must render as an HTML table');
      assert.deepEqual(await table.getByRole('columnheader').allTextContents(),['采集点','存储卡编号','访问范围']);
      assert.equal(await table.getByRole('row').count(),3,'Table must contain its header and both data rows');
      assert.equal(await table.getByRole('cell',{name:'鱼行北廊',exact:true}).count(),1);
      assert.equal(await table.getByRole('cell',{name:'CARD-018',exact:true}).locator('code').count(),1);
      const original = owner.viewportSize();
      try {
        for (const width of [390,1024]) {
          await owner.setViewportSize({width,height:900});
          await table.scrollIntoViewIfNeeded();
          const dimensions = await owner.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
          assert.equal(dimensions.viewport,width);
          assert.ok(dimensions.document<=width+1 && dimensions.body<=width+1,`Table causes horizontal page overflow at ${width}px: ${JSON.stringify(dimensions)}`);
        }
      } finally { await owner.setViewportSize(original); }
    });
    await markdownCheck(`${label} allowed local image`,async()=>{
      const image = article.getByRole('img',{name:'资料室本地标识',exact:true});
      assert.equal(await image.count(),1,'Allowed ./badge.svg must render as an image');
      await image.scrollIntoViewIfNeeded();
      const handle = await image.elementHandle();
      try { await owner.waitForFunction(img=>img.complete && img.naturalWidth>0 && img.naturalHeight>0,handle,{timeout:5000}); }
      finally { await handle?.dispose(); }
      const src = await image.getAttribute('src');
      assert.ok(src);
      if (publicImage) {
        const url = new URL(src,owner.url());
        assert.equal(url.origin,origin,'Published image must stay same-origin');
        assert.match(url.pathname,/^\/content\/dev\/releases\/[^/]+\/md\/badge\.svg$/);
        const response = await anonymous.request.get(url.href);
        assert.equal(response.status(),200); assert.match(response.headers()['content-type'],/image\/svg\+xml/);
        assert.equal((await response.text()).trim(),badgeSource.trim(),'Published image must use the existing bundled SVG');
      } else {
        assert.match(src,/^data:image\/svg\+xml(?:;[^,]*)?,/,'Admin must use the bundled SVG data URL');
        const comma = src.indexOf(',');
        const svg = src.slice(0,comma).includes(';base64') ? Buffer.from(src.slice(comma+1),'base64').toString('utf8') : decodeURIComponent(src.slice(comma+1));
        assert.equal(svg.trim(),badgeSource.trim(),'Admin image must use the same bundled SVG source');
      }
    });
    await markdownCheck(`${label} rejected external image`,async()=>{
      assert.equal(await article.getByRole('img',{name:'外部图片应被拒绝',exact:true}).count(),0);
      assert.equal(await article.locator('img').count(),1,'Only the allowed local image may be emitted');
      assert.equal(await article.locator('img[src^="https://markdown-image.invalid"]').count(),0);
      assert.deepEqual(externalImageAttempts,[],'External image must be rejected before any network request, not merely blocked by the test firewall');
      assert.equal(await article.locator('script').count(),0);
      assert.equal(await owner.evaluate(()=>window.smokeInjected),undefined);
    });
  }
  async function checkAdminFilter() {
    const search = nav.getByRole('searchbox');
    const doc = button(nav,names.md);
    await button(nav,`折叠「${names.group}」`).click();
    assert.equal(await doc.isVisible(),false);
    await search.fill(names.md);
    await doc.waitFor();
    assert.equal(await button(nav,`折叠「${names.group}」`).getAttribute('aria-expanded'),'true','Search temporarily reveals the collapsed ancestor');
    await button(nav,`折叠「${names.group}」`).click();
    assert.equal(await doc.isVisible(),false,'Admin search allows immediate manual collapse');
    await button(nav,`展开「${names.group}」`).click(); await doc.waitFor();
    await search.fill('');
    await button(nav,`展开「${names.group}」`).waitFor();
    assert.equal(await doc.isVisible(),false,'Clearing admin search restores the collapsed branch');
    await search.fill(`no-match-${nonce}`);
    await nav.getByRole('status').filter({hasText:'没有匹配的目录或文档'}).waitFor();
    await search.fill('');
    await button(nav,`展开「${names.group}」`).click(); await doc.waitFor();
    await search.fill(names.md); await doc.waitFor();
    await button(nav,`折叠「${names.group}」`).click();
    assert.equal(await doc.isVisible(),false);
    await search.fill(''); await doc.waitFor();
    assert.equal(await button(nav,`折叠「${names.group}」`).getAttribute('aria-expanded'),'true','Clearing search also restores a previously expanded admin branch');
  }
  async function checkPublicFilter() {
    const search = reader.getByRole('searchbox');
    const group = publicTree.getByRole('button',{name:names.group,exact:true});
    const doc = publicTree.getByRole('link',{name:names.md,exact:true});
    await group.click(); assert.equal(await group.getAttribute('aria-expanded'),'false');
    assert.equal(await doc.isVisible(),false);
    await search.fill(names.md); await doc.waitFor();
    assert.equal(await group.getAttribute('aria-expanded'),'true');
    await group.click();
    assert.equal(await group.getAttribute('aria-expanded'),'false','Reader search allows immediate manual collapse');
    assert.equal(await doc.isVisible(),false);
    await group.click(); await doc.waitFor();
    await search.fill('');
    assert.equal(await group.getAttribute('aria-expanded'),'false','Clearing reader search restores the collapsed branch');
    assert.equal(await doc.isVisible(),false);
    await search.fill(`no-match-${nonce}`);
    await reader.getByText('没有匹配的目录或文档。',{exact:true}).waitFor();
    await search.fill(''); await group.click(); await doc.waitFor();
    await search.fill(names.md); await doc.waitFor();
    await group.click(); assert.equal(await doc.isVisible(),false);
    await search.fill(''); await doc.waitFor();
    assert.equal(await group.getAttribute('aria-expanded'),'true','Clearing search also restores a previously expanded reader branch');
  }
  async function showMarkdown(tabId,mdId) {
    await reader.goto(`${origin}/doc?${new URLSearchParams({tab:tabId,doc:mdId})}`);
    await publicContent.getByRole('heading',{name:markdownTitle,exact:true}).waitFor();
    await publicTree.getByRole('link',{name:names.md,exact:true}).waitFor();
    assert.equal(await reader.locator('.portal-markdown script').count(),0);
    assert.equal(await reader.evaluate(()=>window.smokeInjected),undefined);
  }

  step = 'anonymous protected GET and write routes';
  for (const [method,path] of [
    ['GET','/manage/session'],['GET','/manage/workspace'],['GET','/manage/preview?doc=api'],
    ['GET','/manage/node'],['GET','/manage/publish'],['GET','/manage/tabs'],['GET','/manage/tabs/publish'],
    ['PUT','/manage/node'],['POST','/manage/publish'],['PUT','/manage/tabs'],['POST','/manage/tabs/publish'],['POST','/manage/logout'],
  ]) {
    const response = await anonymous.request.fetch(origin+path,{method,maxRedirects:0,headers:{Origin:origin},
      ...(method==='GET'?{}:{data:{revision:0}})});
    assert.equal(response.status(),401,`Anonymous ${method} ${path} must require a cookie`);
    assert.match(response.headers()['content-type'],/application\/json/);
  }
  assert.equal((await anonymous.cookies()).length,0);
  step = 'default site name and anonymous name mutation rejected';
  assert.deepEqual(await siteName(),{name:'文档平台'},'Fresh disposable database uses the default site name');
  const deniedNameChange = await anonymous.request.put(origin+'/manage/site-name', {
    headers:{Origin:origin}, data:{name:`Unauthorized ${nonce}`},
  });
  assert.equal(deniedNameChange.status(),401);
  assert.deepEqual(await siteName(),{name:'文档平台'});
  step = 'unpublished portal empty state';
  assert.equal((await anonymous.request.get(origin+'/content/dev/current/tree.json')).status(),404,'Disposable database must start unpublished');
  await reader.goto(origin+'/api'); await reader.getByRole('heading',{name:'暂无已发布内容',exact:true}).waitFor();
  await checkBrand(reader,'文档平台',false);

  step = 'anonymous admin redirect and admin/admin login';
  await page.goto(origin+'/admin'); await page.waitForURL(url=>url.pathname==='/login');
  assert.equal(new URL(page.url()).searchParams.get('next'),'/admin');
  assert.equal(await wb.count(),0);
  await checkBrand(page,'文档平台',false);
  for (const name of ['服务端 API','更新日志']) assert.equal(await page.getByRole('link',{name,exact:true}).count(),0,'Unpublished login has no static tab menu');
  await page.getByLabel('账号',{exact:true}).fill('admin');
  await page.getByLabel('密码',{exact:true}).fill('admin');
  await mutate(()=>button(page,'登录').click(),'POST','/manage/login');
  await page.waitForURL(url=>url.pathname==='/admin'); await ready();
  assert.equal((await admin.request.get(origin+'/manage/session')).status(),200);
  step = 'admin-only site name cancel/save and cross-page refresh persistence';
  const editedSiteName = await editSiteName();
  let saved = await workspace(); const originalRoots = roots(saved);
  assert.ok(originalRoots.length>=1,'Workspace needs a root for cross-tab checks');
  assert.ok(saved.nodes.every(n=>n.publishedVersion===null),'Fresh isolated workspace contains only drafts');
  const other = originalRoots[0];

  step = 'add, rename and drag-order dynamic tabs';
  await button(page,'新增栏目').click();
  const addDialog = page.getByRole('form',{name:'新增栏目'});
  await addDialog.getByLabel('栏目名称').fill(names.initial);
  saved = await mutate(()=>button(addDialog,'保存栏目').click(),'PUT','/manage/tabs');
  await addDialog.waitFor({state:'hidden'});
  const added = saved.nodes.find(n=>n.parentId===null && n.title===names.initial); assert.ok(added);
  saved = await renameTab(names.initial,names.tab);
  assert.equal(saved.nodes.find(n=>n.id===added.id).title,names.tab);
  const source = page.locator('.wb-tab-item').filter({has:page.getByRole('tab',{name:names.tab,exact:true})});
  const target = page.locator('.wb-tab-item').filter({has:page.getByRole('tab',{name:other.title,exact:true})});
  saved = await mutate(()=>source.dragTo(target),'PUT','/manage/tabs');
  assert.equal(roots(saved)[0].id,added.id,'Drag persists the new first root');
  assert.deepEqual(await tabs.getByRole('tab').allTextContents(),roots(saved).map(n=>n.title));
  assert.equal((await anonymous.request.get(origin+'/content/dev/current/tree.json')).status(),404,'Saving tabs must not publish');
  await page.reload(); await ready();
  assert.deepEqual(await tabs.getByRole('tab').allTextContents(),roots(saved).map(n=>n.title),'Tab metadata survives reload');

  step = 'keyboard draft save and inferred Path, Query, JSON body, 200/400 responses survive one save/reload';
  await runVisualEditorRegression({ page, wb, editor, workspace, beginNode, apiSourceMode, button, mutate, ready, nonce, tab:other.title,
    publicTreeStatus:async()=> (await anonymous.request.get(origin+'/content/dev/current/tree.json')).status() });

  step = 'save nested Markdown/API and unrelated private draft';
  const privateDoc = await createNode(other.title,other.title,'markdown',names.private,`Never publish ${nonce}`);
  const group = await createNode(names.tab,names.tab,'group',names.group);
  // Raw HTML intentionally exercises compatibility editing. Seed the exact bytes
  // rather than typing Markdown syntax into the rich-text editor.
  const beforeSeed = await workspace();
  const id = `smoke-md-${nonce}`;
  const seeded = await admin.request.put(origin+'/manage/node',{headers:{Origin:origin},data:{
    revision:beforeSeed.revision,node:{id,parentId:group.id,sort:0,type:'markdown',title:names.md,body:markdown}
  }});
  assert.equal(seeded.status(),200);
  const md = (await seeded.json()).nodes.find(n=>n.id===id);
  assert.equal(md.body,markdown); assert.equal(md.publishedVersion,null);
  step = 'load saved long Markdown draft and read to its ending in admin';
  await page.goto(`${origin}/admin?doc=${id}`); await ready();
  assert.equal(new URL(page.url()).searchParams.get('doc'),md.id);
  await checkLongRead(page,editor,nav,'Admin Markdown');
  step = 'admin Markdown tables, bundled local image, rejected external image and search restoration';
  await checkMarkdownFeatures(page,editor.getByRole('article'),'Admin reading');
  await checkAdminFilter();
  assert.equal(new URL(page.url()).searchParams.get('doc'),md.id,'Search does not change the selected document');
  await button(editor,'编辑').click();
  const fallback = editor.getByRole('textbox',{name:'Markdown 源码（兼容模式）',exact:true});
  assert.equal(await fallback.inputValue(),markdown,'Unsupported Markdown opens intact in compatibility editing');
  await assertNoMarkdownModes(editor);
  assert.equal(await button(wb,'保存草稿').isEnabled(),false,'Opening the fallback does not dirty the draft');
  await button(wb,'返回阅读').click();
  step = 'save nested API';
  let api = await createNode(names.tab,names.group,'api',names.api,yaml);
  assert.equal(await button(wb,'发布此节点').isEnabled(),false,'Unpublished parent prevents child publication');
  assert.equal(await button(nav,`编辑「${names.private}」`).count(),0,'Other tab draft is absent');

  step = 'native draft iframe, YAML editing and restored selection';
  await button(wb,'返回阅读').click();
  await nativeFrame(page,'iframe[title="接口文档预览"]');
  await button(wb,'编辑').click();
  await apiSourceMode();
  assert.equal(await wb.getByLabel('YAML 正文').inputValue(),yaml);
  assert.equal(await page.locator('iframe[title="接口文档预览"]').count(),0);
  await wb.getByLabel('YAML 正文').fill(editedYaml);
  saved = await mutate(()=>button(wb,'保存草稿').click(),'PUT','/manage/node');
  api = saved.nodes.find(n=>n.id===api.id); assert.equal(api.body,editedYaml);
  await page.reload(); await ready();
  assert.equal(new URL(page.url()).searchParams.get('doc'),api.id);
  await tabs.getByRole('tab',{name:names.tab,selected:true,exact:true}).waitFor();
  await nativeFrame(page,'iframe[title="接口文档预览"]');
  await page.frameLocator('iframe[title="接口文档预览"]').getByText(`${summary} edited`,{exact:true}).first().waitFor();
  step = 'admin reading and editing have no horizontal overflow at 390/1024px';
  await adminWidths('reading');
  await button(wb,'编辑').click(); await apiSourceMode();
  assert.equal(await wb.getByLabel('YAML 正文').inputValue(),editedYaml);
  await adminWidths('editing');
  await button(wb,'返回阅读').click();

  step = 'unsaved tab switch dismiss and accept';
  await readAdmin(names.md);
  await button(editor,'编辑').click();
  assert.equal(await fallback.inputValue(),markdown,'Top Edit button opens Markdown editor');
  await adminWidths('Markdown editing');
  const unsaved = markdown+`\nUnsaved ${nonce}`;
  await fallback.fill(unsaved);
  await confirmAction(()=>tabs.getByRole('tab',{name:other.title,exact:true}).click(),'尚有未保存的修改',false);
  await tabs.getByRole('tab',{name:names.tab,selected:true,exact:true}).waitFor();
  assert.equal(await fallback.inputValue(),unsaved);
  assert.equal(new URL(page.url()).searchParams.get('doc'),md.id);
  await confirmAction(()=>tabs.getByRole('tab',{name:other.title,exact:true}).click(),'尚有未保存的修改');
  await tabs.getByRole('tab',{name:other.title,selected:true,exact:true}).waitFor();
  assert.equal((await workspace()).nodes.find(n=>n.id===md.id).body,markdown,'Discard does not save');

  step = 'publish only root metadata and keep every child draft private';
  saved = await publishTabs();
  let live = await liveTree();
  assert.deepEqual(roots(live).map(({id,title,sort})=>({id,title,sort})),roots(saved).map(({id,title,sort})=>({id,title,sort})));
  assert.ok(live.nodes.every(n=>n.parentId===null),'Publishing tabs leaked child drafts');
  assert.ok(saved.nodes.filter(n=>n.parentId!==null).every(n=>n.publishedVersion===null));
  await reader.goto(origin+'/api');
  await publicTabs.getByRole('link',{name:names.tab,exact:true}).waitFor();
  const signedInReader = await newPage(admin);
  const managementRequests = [];
  signedInReader.on('request', req => { if (new URL(req.url()).pathname.startsWith('/manage/')) managementRequests.push({method:req.method(),path:new URL(req.url()).pathname}); });
  await signedInReader.goto(reader.url());
  await signedInReader.getByRole('navigation',{name:'文档栏目'}).getByRole('link',{name:names.tab,exact:true}).waitFor();
  for (const viewer of [reader,signedInReader]) {
    assert.equal(await viewer.getByRole('link',{name:'编辑此页',exact:true}).count(),0);
    assert.equal(await viewer.locator('a[href^="/admin"]').count(),0);
  }
  assert.deepEqual(managementRequests,[],'Public branding must not query management or session data');
  await checkBrand(signedInReader,editedSiteName,false);
  await signedInReader.close();
  assert.deepEqual(await publicTabs.getByRole('link').allTextContents(),roots(saved).map(n=>n.title));
  assert.equal(new URL(reader.url()).searchParams.get('tab'),added.id,'First published root is default');
  assert.equal(await publicTree.getByRole('link').count(),0);

  step = 'login navigation matches published doc tabs without static duplicates';
  await checkLoginNavigation();

  step = 'publish parent and Markdown independently';
  await selectTab(names.tab); await readAdmin(names.group); await publishNode(names.group);
  live = await liveTree(); assert.ok(live.nodes.some(n=>n.id===group.id));
  assert.ok(!live.nodes.some(n=>[md.id,api.id,privateDoc.id].includes(n.id)));
  await readAdmin(names.md); saved = await publishNode(names.md);
  assert.equal(saved.nodes.find(n=>n.id===md.id).publishedVersion,md.draftVersion);
  assert.equal(saved.nodes.find(n=>n.id===api.id).publishedVersion,null);
  await showMarkdown(added.id,md.id);
  step = 'reload published long Markdown and read to its ending anonymously';
  await reader.reload();
  await checkLongRead(reader,publicContent,publicTree,'Reader Markdown');
  step = 'published Markdown tables, release image, rejected external image and search restoration';
  await checkMarkdownFeatures(reader,publicContent.getByRole('article'),'Public reading',true);
  await checkPublicFilter();
  assert.equal(new URL(reader.url()).searchParams.get('doc'),md.id,'Reader search preserves the selected document');
  assert.equal(await publicTree.getByRole('link',{name:names.api,exact:true}).count(),0);
  assert.equal(await publicContent.getByText(names.private,{exact:true}).count(),0);

  step = 'publish single API and inspect independent release JSON';
  await readAdmin(names.api); saved = await publishNode(names.api);
  assert.equal(saved.nodes.find(n=>n.id===api.id).publishedVersion,api.draftVersion);
  assert.equal(saved.nodes.find(n=>n.id===privateDoc.id).publishedVersion,null);
  live = await liveTree(); const publicApi = live.nodes.find(n=>n.id===api.id); assert.ok(publicApi?.url);
  const specURL = new URL(publicApi.url,origin+'/content/dev/current/tree.json');
  assert.equal(specURL.origin,origin); assert.match(specURL.pathname,/^\/content\/dev\/releases\/[^/]+\/.+\.json$/);
  const specResponse = await anonymous.request.get(specURL.href); assert.equal(specResponse.status(),200);
  const spec = await specResponse.json(); assert.deepEqual(Object.keys(spec.paths),[operationPath]);
  assert.equal(spec.paths[operationPath].get.summary,`${summary} edited`);

  step = 'public native API iframe, refresh and mobile autoheight';
  await showMarkdown(added.id,md.id);
  await publicTree.getByRole('link',{name:names.api,exact:true}).click();
  const publicFrame = `iframe[title="${names.api}"]`;
  await nativeFrame(reader,publicFrame);
  assert.equal(await reader.getByRole('navigation',{name:'本页目录'}).count(),0);
  await reader.getByRole('button',{name:'收起目录'}).click();
  assert.equal(await publicTree.isVisible(),false);
  await reader.getByRole('button',{name:'展开目录'}).click();
  await reader.evaluate(()=>window.scrollTo(0,0));
  const frameBox = await reader.locator(publicFrame).boundingBox();
  await reader.mouse.move(frameBox.x+30,Math.min(900,frameBox.y+160));
  const filterBox = await reader.getByRole('searchbox').boundingBox();
  await reader.mouse.wheel(0,360); await reader.waitForFunction(()=>window.scrollY>40);
  const afterScroll = await reader.getByRole('searchbox').boundingBox();
  assert.ok(Math.abs(afterScroll.y-filterBox.y)<=2,`Directory moved during scroll: ${filterBox.y} -> ${afterScroll.y}`);
  await reader.mouse.wheel(0,-640); await reader.waitForFunction(()=>window.scrollY<10);
  assert.match(await reader.locator(publicFrame).getAttribute('src'),/^\/api-reference\?spec=/);
  assert.equal(new URL(reader.url()).pathname,'/doc'); assert.equal(new URL(reader.url()).searchParams.get('doc'),api.id);
  await reader.reload(); await nativeFrame(reader,publicFrame);
  assert.equal(new URL(reader.url()).searchParams.get('tab'),added.id); assert.equal(new URL(reader.url()).searchParams.get('doc'),api.id);
  await reader.setViewportSize({width:390,height:844}); await nativeFrame(reader,publicFrame);
  assert.ok(await reader.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Mobile portal overflows horizontally');
  await reader.setViewportSize({width:1440,height:1000}); await nativeFrame(reader,publicFrame);

  step = 'browser history and current-tab directory isolation';
  await publicTree.getByRole('link',{name:names.md,exact:true}).click(); await publicContent.getByRole('heading',{name:markdownTitle,exact:true}).waitFor();
  await reader.goBack(); await nativeFrame(reader,publicFrame);
  await reader.goForward();
  try {
    await reader.waitForURL(url=>url.searchParams.get('doc')===md.id,{timeout:3000});
    await publicContent.getByRole('heading',{name:markdownTitle,exact:true}).waitFor();
  } catch {
    const detail = `Forward history did not restore Markdown ${md.id}; current=${reader.url()}; frames=${reader.frames().map(f=>f.url()).join(', ')}`;
    failures.push(detail); console.error('PRODUCT FAILURE: '+detail);
    // Continue independent assertions; the accumulated failure still fails this run.
    await showMarkdown(added.id,md.id);
  }
  await publicTabs.getByRole('link',{name:other.title,exact:true}).click();
  await reader.waitForURL(url=>url.searchParams.get('tab')===other.id);
  await reader.getByRole('complementary',{name:`${other.title}目录`,exact:true}).waitFor();
  assert.equal(await publicTree.getByRole('link',{name:names.md,exact:true}).count(),0);
  assert.equal(await publicTree.getByRole('link',{name:names.private,exact:true}).count(),0);
  await reader.goto(origin+'/changelog'); await reader.waitForURL(url=>url.pathname==='/doc');
  await publicTabs.waitFor();
  assert.equal(new URL(reader.url()).searchParams.get('tab'),'changelog','Legacy changelog opens the unified portal');

  step = 'republishing renamed root keeps published child content, not its newer draft';
  await selectTab(names.tab); await button(nav,`编辑「${names.md}」`).click();
  const privateRevision = `Unpublished replacement ${nonce}`;
  await fallback.fill(privateRevision);
  saved = await mutate(()=>button(wb,'保存草稿').click(),'PUT','/manage/node');
  const pendingMD = saved.nodes.find(n=>n.id===md.id); assert.ok(pendingMD.draftVersion>pendingMD.publishedVersion);
  assert.equal(pendingMD.body,privateRevision,'Compatibility editor saves the exact replacement draft');
  const renamed = `${names.tab} revised`;
  const openReader = await newPage(admin);
  await openReader.goto(origin+'/doc');
  const openTabs = openReader.getByRole('navigation',{name:'文档栏目'});
  await openTabs.getByRole('link',{name:names.tab,exact:true}).waitFor();
  await renameTab(names.tab,renamed);
  assert.equal(await openTabs.getByRole('link',{name:renamed,exact:true}).count(),0);
  saved = await publishTabs();
  await openTabs.getByRole('link',{name:renamed,exact:true}).waitFor(); // already-open page, no reload
  await openReader.close();
  const afterMD = saved.nodes.find(n=>n.id===md.id);
  assert.equal(afterMD.publishedVersion,pendingMD.publishedVersion); assert.equal(afterMD.body,privateRevision);
  live = await liveTree(); assert.equal(live.nodes.find(n=>n.id===added.id).title,renamed);
  assert.ok(!live.nodes.some(n=>n.id===privateDoc.id));
  const liveMD = live.nodes.find(n=>n.id===md.id);
  const mdResponse = await anonymous.request.get(new URL(liveMD.url,origin+'/content/dev/current/tree.json').href);
  assert.equal(mdResponse.status(),200); assert.equal(await mdResponse.text(),markdown);
  await showMarkdown(added.id,md.id); await publicTabs.getByRole('link',{name:renamed,exact:true}).waitFor();
  assert.equal(await publicContent.getByText(privateRevision,{exact:true}).count(),0);
  assert.equal((await anonymous.request.get(origin+'/manage/workspace')).status(),401,'Reader remains anonymous');

  async function checkToggle(name) {
    const toggle=page.getByRole('button',{name,exact:true});
    const box=await toggle.boundingBox(), icon=await toggle.locator('svg').boundingBox();
    assert.ok(box && icon && Math.abs(box.x+box.width/2-icon.x-icon.width/2)<1 && Math.abs(box.y+box.height/2-icon.y-icon.height/2)<1,'Sidebar toggle icon must stay centered');
    return toggle;
  }
  await (await checkToggle('收起目录')).click();
  assert.equal(await nav.isVisible(),false);
  await (await checkToggle('展开目录')).click();
  await nav.waitFor();
  await selectTab(other.title);
  await confirmAction(()=>button(nav,`删除「${names.private}」`).click(),names.private);
  await wb.getByText('节点已删除。',{exact:true}).waitFor();
  assert.ok(!(await workspace()).nodes.some(n=>n.id===privateDoc.id));
  await reader.goto(`${origin}/api?tab=${added.id}&doc=${md.id}#example`);
  await reader.waitForURL(u=>u.pathname==='/doc' && u.searchParams.get('doc')===md.id && u.hash==='#example');
  step = 'login/doc navigation follows latest published rename and order';
  await checkLoginNavigation();
  step = 'tree drag and tab deletion UI regression';
  await runOrganizationRegression({ page, origin, nonce, tab: other, workspace, createNode, selectTab, ready });

  step = 'logout revokes management access';
  const [logout] = await Promise.all([page.waitForResponse(r=>r.url()===origin+'/manage/logout' && r.request().method()==='POST'),button(page,'退出登录').click()]);
  assert.equal(logout.status(),200); await page.waitForURL(url=>url.pathname==='/login');
  assert.equal((await admin.request.get(origin+'/manage/workspace')).status(),401);
  await checkBrand(page,editedSiteName,false);
  assert.equal((await admin.request.put(origin+'/manage/site-name',{headers:{Origin:origin},data:{name:'Logged-out change'}})).status(),401);
  assert.deepEqual(await siteName(),{name:editedSiteName});
  step = 'final browser and product regression checks';
  console.log('Completed default visual/form editors, full OpenAPI 3.1 templates, required Path inference, independent Query/JSON body/200+400 responses, keyboard save and draft reload, login/auth, top Edit buttons (API and Markdown), dynamic tabs, selective publication, real iframe autoheight, refresh/mobile/legacy redirect and logout checks.');
  assert.deepEqual(externalImageAttempts,[],'External Markdown images must never be requested');
  assert.deepEqual(errors,[],'Uncaught browser errors');
  assert.deepEqual(failures,[],'Product regressions');
  console.log('PASS default visual Markdown/form API saves and reload, full 3.1 template, required Path inference, independent Query/JSON body/200+400 responses, keyboard save and source roundtrip, isolated login/auth, default/editable site name and persistence, login/doc published navigation parity without static duplicates, dynamic tab add/rename/drag/publish, root-only publication and draft privacy, nested Markdown/API save/publish, native draft/public iframe autoheight, YAML edit, unsaved guard, refresh/history, admin 390/1024px and mobile portal layout, Markdown tables/local/external images in reading and preview, search/collapse restoration, legacy redirect and logout');
} catch (error) {
  for (const p of diagnosticPages.filter(p=>!p.isClosed())) {
    console.error('PAGE STATE',p.url(),await p.locator('body').innerText({timeout:1500}).then(text=>text.slice(0,1600)).catch(()=>'(unavailable)'));
  }
  throw Error(`${step}: ${error.message}${errors.length ? '\nBrowser errors: '+errors.join('\n') : ''}`,{cause:error});
} finally { await browser?.close(); }
