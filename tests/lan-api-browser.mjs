import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {withPortal} from '../server/portal.mjs';

test('API renders on plain HTTP LAN-style origin without native randomUUID', {timeout:60000}, async t => {
  const spec = {openapi:'3.1.0',info:{title:'LAN regression',version:'1'},paths:{'/lan-regression':{get:{summary:'LAN endpoint',responses:{200:{description:'OK'}}}}}};
  const server = createServer(withPortal((req,res) => {
    if (req.url === '/content/dev/lan.json') { res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(spec)); }
    else {res.writeHead(404);res.end();}
  },fileURLToPath(new URL('../dist/',import.meta.url))));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const browser = await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page = await browser.newPage(); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  // Keep a genuinely insecure browser origin without DNS/VPN/proxy dependencies.
  // Only transport is mapped to the disposable local fixture.
  await page.route('http://docs.example.test/**',async route=>{
    const url=new URL(route.request().url());
    const response=await route.fetch({url:`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`});
    await route.fulfill({response});
  });
  await page.addInitScript(()=>{window.nativeUUIDAvailable=typeof crypto.randomUUID === 'function';});
  await page.goto(`http://docs.example.test/api-reference?spec=%2Fcontent%2Fdev%2Flan.json`);
  try { await page.getByText('/lan-regression',{exact:true}).first().waitFor({timeout:10000}); }
  catch(error){t.diagnostic(JSON.stringify({url:page.url(),body:await page.locator('body').innerText(),errors,html:(await page.content()).slice(0,1000)}));throw error;}
  assert.equal(await page.evaluate(()=>isSecureContext),false);
  assert.equal(await page.evaluate(()=>window.nativeUUIDAvailable),false);
  assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'function');
  assert.equal(await page.getByText('未找到可显示的接口分组，请检查接口定义。',{exact:true}).count(),0);
  assert.deepEqual(errors,[]);
});
