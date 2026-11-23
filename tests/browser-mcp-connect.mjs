// Run against a completed local dist: node --test tests/browser-mcp-connect.mjs.
// Only the shared in-memory fixture serves content; MCP configuration is intercepted.
// No backend, environment credentials, database, publication, or real MCP requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import {expect} from 'playwright/test';
import {startAdminFixture} from './helpers/admin-fixture.mjs';

const token = 'test-secret';
const copyButton = scope => scope.getByRole('button', {name:/^复制(?:管理员)? MCP$/, exact:true});
const clipboard = page => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (page, value) => page.evaluate(value => navigator.clipboard.writeText(value), value);

async function noCredentialUI(page) {
  for (const frame of page.frames()) {
    // Inspect the DOM, including attributes/hidden elements, rather than just visible text.
    const html = await frame.locator('html').innerHTML();
    assert.ok(!html.includes(token), 'Synthetic admin token leaked into DOM');
    assert.ok(!html.includes('Bearer '), 'Admin authorization leaked into DOM');
  }
}

async function fitsViewport(button) {
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  const dimensions = await button.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {left:rect.left, right:rect.right, width:innerWidth,
      scroll:document.documentElement.scrollWidth, client:document.documentElement.clientWidth};
  });
  assert.ok(dimensions.left >= -1 && dimensions.right <= dimensions.width + 1,
    `Page action must fit inside its viewport: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.scroll <= dimensions.client + 1, 'Page must not overflow horizontally');
}

async function denyNextCopy(scope) {
  // Inject a single clipboard failure, then restore the native API for a real retry.
  await scope.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {configurable:true, value:async () => {
      delete navigator.clipboard.writeText;
      throw new DOMException('Synthetic clipboard denial', 'NotAllowedError');
    }});
  });
}

test('page action dropdown and deferred admin MCP copy use isolated configurations', {timeout:120_000}, async t => {
  const f = await startAdminFixture();
  t.after(async () => { try { f.check(); assert.deepEqual(f.writes, []); } finally { await f.close(); } });
  const {origin, page, reader, state} = f;
  const publicConfig = {mcpServers:{'docsprig-public':{url:origin+'/mcp/docs'}}};
  const adminConfig = {mcpServers:{'docsprig-admin':{
    url:origin+'/mcp/admin', headers:{Authorization:`Bearer ${token}`},
  }}};
  state.nodes = [
    {id:'root', parentId:null, sort:0, title:'MCP fixtures', type:'group', body:'', draftVersion:1, publishedVersion:null},
    {id:'guide', parentId:'root', sort:0, title:'MCP guide', type:'markdown', body:'Public fixture documentation.', draftVersion:1, publishedVersion:null},
    {id:'endpoint', parentId:'root', sort:1, title:'MCP endpoint', type:'api', draftVersion:1, publishedVersion:null,
      body:JSON.stringify({openapi:'3.1.0', 'x-open-docs-document-kind':'operation', info:{title:'MCP endpoint', version:'1'},
        paths:{'/fixture':{get:{summary:'MCP fixture operation', responses:{200:{description:'OK'}}}}}})},
  ];
  await f.release(state.nodes);
  const baseline = structuredClone(state);
  for (const p of [page, reader]) await p.context().grantPermissions(['clipboard-read','clipboard-write'], {origin});

  const requests = [], unexpected = [], browserDialogs = [];
  let nextResponse;
  // The newest context route overrides the fixture only for this synthetic endpoint.
  await page.context().route(origin+'/manage/mcp-config', async route => {
    const req = route.request();
    requests.push({method:req.method(), body:req.postData(), headers:req.headers()});
    const plan = nextResponse; nextResponse = undefined;
    if (!plan) { unexpected.push('Unsolicited admin configuration request'); return route.fulfill({status:500,json:{error:'Unexpected request'}}); }
    await plan.gate;
    return route.fulfill({status:plan.status, headers:{'Cache-Control':'no-store'}, json:plan.status === 200
      ? {name:'docsprig-admin', url:origin+'/mcp/admin', config:adminConfig}
      : {error:`fixture-${plan.status}`}});
  });
  // Public readers must never request admin configuration or contact an MCP server.
  for (const p of [page, reader]) {
    p.context().on('request', req => {
      const url = new URL(req.url());
      if (/^\/mcp(?:\/|$)/.test(url.pathname) || (p === reader && url.pathname.startsWith('/manage/')))
        unexpected.push(`${req.method()} ${url.pathname}`);
    });
    p.on('dialog', async dialog => { browserDialogs.push(dialog.type()); await dialog.dismiss(); });
    await p.context().route(/\/mcp(?:\/|$)/, route => route.abort());
  }
  function arm(status, delayed = false) {
    assert.equal(nextResponse, undefined);
    let release;
    const gate = delayed ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
    nextResponse = {status, gate};
    return release;
  }
  async function adminClick(status, delayed = false) {
    const count = requests.length, release = arm(status, delayed);
    await Promise.all([
      page.waitForRequest(req => req.url() === origin+'/manage/mcp-config'),
      copyButton(page).click(),
    ]);
    assert.equal(requests.length, count+1);
    assert.equal(requests.at(-1).method, 'POST');
    assert.deepEqual(JSON.parse(requests.at(-1).body), {});
    assert.match(requests.at(-1).headers['content-type'], /application\/json/);
    assert.equal(requests.at(-1).headers.authorization, undefined);
    return release;
  }

  await t.test('public split dropdown copies page, raw MCP URL and JSON on desktop/mobile', async () => {
    for (const width of [1440, 375]) {
      await reader.setViewportSize({width, height:900});
      for (const doc of ['guide','endpoint']) {
        await reader.goto(`${origin}/doc?tab=root&doc=${doc}`);
        const scope = doc === 'guide' ? reader : reader.frameLocator('iframe');
        const toggle = scope.getByRole('button',{name:'更多页面操作',exact:true});
        const main = scope.getByRole('button',{name:'复制页面',exact:true});
        const menu = scope.getByRole('menu');
        const item = name => menu.getByRole('menuitem',{name,exact:true});
        await expect(toggle).toBeVisible();
        await expect(main).toBeVisible();
        assert.equal(await toggle.count(),1);
        assert.equal(await copyButton(scope).count(),0,'No standalone public MCP button');
        assert.equal(await reader.getByRole('navigation',{name:'文档栏目',exact:true})
          .getByRole('button',{name:/MCP|更多页面操作/}).count(),0);
        const heading = toggle.locator('xpath=ancestor::*[.//h1 or .//h2][1]');
        await expect(heading.getByRole('button',{name:'复制页面',exact:true})).toBeVisible();
        assert.ok(await heading.getByRole('heading').count() > 0);
        await fitsViewport(toggle);
        await fitsViewport(main);
        await expect(menu).toBeHidden();
        await setClipboard(reader,'page-copy-sentinel');
        await main.click();
        await expect.poll(() => clipboard(reader)).toContain(doc === 'guide' ? state.nodes[1].body : 'MCP fixture operation');
        if (doc === 'guide') assert.equal(await clipboard(reader),state.nodes[1].body);

        await toggle.click();
        await expect(menu).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded','true');
        try { await fitsViewport(menu); } catch (error) { error.message = `${doc} at ${width}px: ${error.message}`; throw error; }
        for (const name of ['复制页面','以 Markdown 格式查看','复制 MCP Server','复制 MCP 配置','连接到 Cursor','连接到 VS Code'])
          await expect(item(name)).toBeVisible();
        const markdownView = item('以 Markdown 格式查看');
        await expect(markdownView).toHaveAttribute('href',/^blob:/);
        await expect(markdownView).toHaveAttribute('target','_blank');
        await expect(markdownView).toHaveAttribute('rel',/\bnoreferrer\b/);
        if (doc === 'guide' && width === 1440) {
          const markdownURL = await markdownView.getAttribute('href');
          const [popup] = await Promise.all([reader.waitForEvent('popup'),markdownView.click()]);
          try {
            await expect(popup).toHaveURL(markdownURL);
            await popup.waitForLoadState('domcontentloaded');
            assert.equal(await popup.evaluate(() => document.contentType),'text/plain');
            await expect(popup.locator('body')).toHaveText(state.nodes[1].body);
            assert.equal(await popup.locator('body').innerText(),state.nodes[1].body);
          } finally { await popup.close(); }
          await reader.bringToFront();
          if (!await menu.isVisible()) await toggle.click();
        }
        await setClipboard(reader,'menu-page-sentinel');
        await item('复制页面').click();
        await expect.poll(() => clipboard(reader)).not.toBe('menu-page-sentinel');
        const copiedPage = await clipboard(reader);
        assert.ok(copiedPage.includes(doc === 'guide' ? state.nodes[1].body : 'MCP fixture operation'));
        assert.ok(!copiedPage.includes('复制 MCP Server'),'Menu labels must not contaminate copied page');
        await expect(menu).toBeHidden();

        await toggle.click();
        await item('复制 MCP Server').click();
        await expect.poll(() => clipboard(reader)).toBe(origin+'/mcp/docs');
        await expect(menu).toBeHidden();
        await toggle.click();
        await item('复制 MCP 配置').click();
        await expect.poll(() => clipboard(reader)).toBe(JSON.stringify(publicConfig,null,2));
        assert.deepEqual(JSON.parse(await clipboard(reader)),publicConfig);
        await expect(menu).toBeHidden();

        await toggle.click();
        // Decode hrefs only. Never click external protocol links or launch local clients.
        const cursor = new URL(await item('连接到 Cursor').getAttribute('href'));
        assert.equal(cursor.protocol,'cursor:');
        assert.equal(cursor.searchParams.get('name'),'docsprig-public');
        assert.deepEqual(JSON.parse(Buffer.from(cursor.searchParams.get('config'),'base64').toString('utf8')),
          publicConfig.mcpServers['docsprig-public']);
        const vscode = new URL(await item('连接到 VS Code').getAttribute('href'));
        assert.equal(vscode.protocol,'vscode:');
        assert.deepEqual(JSON.parse(decodeURIComponent(vscode.search.slice(1))),
          {name:'docsprig-public',type:'http',...publicConfig.mcpServers['docsprig-public']});
        await item('复制 MCP Server').focus();
        await reader.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(toggle).toHaveAttribute('aria-expanded','false');
        await expect(toggle).toBeFocused();
        await toggle.click();
        // A real pointer outside the split control dismisses its menu in each document/frame.
        await heading.getByRole('heading').first().click();
        await expect(menu).toBeHidden();
        await expect(toggle).toHaveAttribute('aria-expanded','false');
        await toggle.click();
        const outsideLink = scope.getByRole('link').first();
        await outsideLink.focus();
        await expect(menu).toBeHidden();
        await expect(outsideLink).toBeFocused();
        await fitsViewport(toggle);
        await noCredentialUI(reader);
        assert.equal(requests.length,0);
      }
    }
  });

  await t.test('admin header defers POST until click, copies full token without DOM exposure', async () => {
    await page.goto(origin+'/admin?doc=guide');
    await page.getByRole('status').filter({hasText:'已读取工作区'}).waitFor();
    const button = copyButton(page);
    await expect(button).toBeVisible();
    assert.equal(requests.length,0);
    assert.equal(await page.locator('.wb-tabs-bar').getByRole('button',{name:/^复制(?:管理员)? MCP$/}).count(),0);
    const header = button.locator('xpath=ancestor::*[.//button[@aria-label="退出登录"]][1]');
    await expect(header.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
    await setClipboard(page,'admin-deferred-sentinel');
    const release = await adminClick(200,true);
    try {
      await expect(button).toBeDisabled();
      assert.equal(await clipboard(page),'admin-deferred-sentinel');
      await noCredentialUI(page);
    } finally { release(); }
    await expect.poll(() => clipboard(page)).toBe(JSON.stringify(adminConfig,null,2));
    assert.deepEqual(JSON.parse(await clipboard(page)),adminConfig);
    await expect(button).toBeEnabled();
    await noCredentialUI(page);
  });

  await t.test('401 and 503 preserve clipboard and allow explicit retry', async () => {
    for (const [status,message] of [[401,/登录.*失效/],[503,/尚未启用|暂时不可用/]]) {
      await setClipboard(page,`failure-sentinel-${status}`);
      const before = requests.length;
      await adminClick(status);
      await expect(page.getByRole('alert')).toContainText(message);
      await expect(copyButton(page)).toBeEnabled();
      assert.equal(await clipboard(page),`failure-sentinel-${status}`);
      assert.equal(requests.length,before+1,'No automatic configuration retry');
      assert.equal(new URL(page.url()).pathname,'/admin');
      await noCredentialUI(page);
      await adminClick(200);
      await expect.poll(() => clipboard(page)).toBe(JSON.stringify(adminConfig,null,2));
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
  });

  await t.test('clipboard denial reports failure and next click succeeds', async () => {
    // Public copy now goes through the dropdown; admin keeps the direct header action.
    await reader.goto(origin+'/doc?tab=root&doc=guide');
    const toggle = reader.getByRole('button',{name:'更多页面操作',exact:true});
    const menu = reader.getByRole('menu');
    const copyConfig = async () => {
      if (!await menu.isVisible()) await toggle.click();
      await menu.getByRole('menuitem',{name:'复制 MCP 配置',exact:true}).click();
    };
    await expect(toggle).toBeVisible();
    await setClipboard(reader,'clipboard-denial-sentinel');
    await denyNextCopy(reader);
    await copyConfig();
    // Public CopyPage announces outcomes in its live button text; admin uses role=alert.
    const publicStatus = reader.getByRole('button',{name:'复制页面',exact:true}).locator('[aria-live="polite"]');
    await expect(publicStatus).toHaveText('复制失败');
    assert.equal(await clipboard(reader),'clipboard-denial-sentinel');
    await noCredentialUI(reader);
    await copyConfig();
    await expect.poll(() => clipboard(reader)).toBe(JSON.stringify(publicConfig,null,2));
    await expect(publicStatus).toHaveText('已复制');

    await expect(copyButton(page)).toBeVisible();
    await setClipboard(page,'clipboard-denial-sentinel');
    await denyNextCopy(page);
    await adminClick(200);
    await expect(page.getByRole('alert')).toContainText(/复制失败/);
    assert.equal(await clipboard(page),'clipboard-denial-sentinel');
    await noCredentialUI(page);
    await adminClick(200);
    await expect.poll(() => clipboard(page)).toBe(JSON.stringify(adminConfig,null,2));
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  await t.test('mobile admin header remains usable without fetching on resize', async () => {
    const before = requests.length;
    await page.setViewportSize({width:375,height:812});
    await fitsViewport(copyButton(page));
    assert.equal(requests.length,before);
    await adminClick(200);
    await expect.poll(() => clipboard(page)).toBe(JSON.stringify(adminConfig,null,2));
    await noCredentialUI(page);
  });
  assert.deepEqual(state,baseline,'MCP copy must not change the workspace or publication');
  assert.deepEqual(unexpected,[]);
  assert.deepEqual(browserDialogs,[]);
  assert.equal(nextResponse,undefined);
});
