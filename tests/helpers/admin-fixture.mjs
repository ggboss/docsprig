// Browser UI contract fixture. No store, credentials, environment file, or backend URL.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {testBrowser} from './test-browser.mjs';
import {createContent, operationDocument} from '../../server/content.mjs';
import {withPortal} from '../../server/portal.mjs';

export async function startAdminFixture() {
  const dist=fileURLToPath(new URL('../../dist/',import.meta.url));
  await access(`${dist}admin.html`);
  const problems=[], writes=[], files=new Map();
  const state={revision:0,published:null,nodes:[]};
  let expected, browser, site='文档平台', live=[];
  const contexts=[];
  const server=createServer(withPortal((req,res)=>{
    problems.push(`API bypass: ${req.method} ${req.url}`);res.writeHead(501).end();
  },dist));
  async function close() {
    try {await Promise.all(contexts.map(ctx=>ctx.close()));} finally {
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    }
  }
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function context(admin) {
    const ctx=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
    contexts.push(ctx);
    await ctx.routeWebSocket('**/*',socket=>{problems.push('Unexpected WebSocket');return socket.close();});
    await ctx.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),p=url.pathname,m=req.method();
      if(url.origin!==origin) return route.abort(); // Includes external favicons; no outbound access.
      const json=(status,value)=>route.fulfill({status,json:value,headers:{'Cache-Control':'no-store'}});
      try {
        if(admin && m==='GET' && p==='/manage/session') return json(200,{admin:true});
        if(admin && m==='GET' && p==='/manage/workspace') return json(200,state);
        if(admin && m==='GET' && p==='/manage/preview') {
          const node=state.nodes.find(n=>n.id===url.searchParams.get('doc'));
          assert.equal(node?.type,'api');return json(200,operationDocument(node.body));
        }
        if(m==='GET' && p==='/content/site-name.json') return json(200,{name:site});
        if(m==='GET' && files.has(p)) return route.fulfill(files.get(p));
        if(m==='GET' && p==='/content/dev/current/tree.json') return json(404,{error:'Not published'});
        if(admin && expected && m===expected.method && p===expected.path) {
          const accept=expected.accept;expected=null;
          const input=req.postDataJSON();writes.push({m,p,input});
          if(p==='/manage/site-name') {await accept(input);site=input.name;return json(200,{name:site});}
          assert.equal(input.revision,state.revision,'UI sent a stale revision');
          const {revision,...payload}=input;await accept(payload);state.revision++;
          return json(200,state);
        }
        if(/^\/(manage|content)(\/|$)/.test(p)||!['GET','HEAD'].includes(m)) throw Error(`Unexpected ${m} ${p}`);
        return route.continue();
      } catch(error) {problems.push(String(error));return json(501,{error:String(error)});}
    });
    ctx.on('page',p=>p.on('pageerror',e=>problems.push(e.message)));
    return ctx;
  }
  try {
    browser=await testBrowser();
    const page=await (await context(true)).newPage(), reader=await (await context(false)).newPage();
    page.setDefaultTimeout(8000);reader.setDefaultTimeout(8000);
    return {origin,page,reader,state,writes,close,check:()=>assert.deepEqual(problems,[]),
      // One expected write per UI action; duplicate, cancelled or unsolicited writes are failures.
      async change(method,path,action,accept) {
        assert.equal(expected,undefined);expected={method,path,accept};
        try {
          const [res]=await Promise.all([page.waitForResponse(r=>r.url()===origin+path && r.request().method()===method),action()]);
          assert.equal(res.status(),200,await res.text());assert.equal(expected,null);
          if(path!=='/manage/site-name') assert.deepEqual(await res.json(),state);
        } finally {expected=undefined;}
      },
      // Real content renderer on *only* the explicitly released nodes; keep old URLs immutable.
      async release(nodes,removeId) {
        const next=new Map(live.map(n=>[n.id,n]));if(removeId)next.delete(removeId);
        for(const n of nodes) {n.publishedVersion=n.draftVersion;next.set(n.id,structuredClone(n));}
        live=[...next.values()];const snapshot={revision:state.revision,nodes:live};
        const content=createContent({loadRelease:id=>id===release.id?snapshot:null});
        const release=await content.stage(snapshot);state.published=release;
        const tree=await content.read(`releases/${release.id}/tree.json`);
        files.set('/content/dev/current/tree.json',tree);
        for(const {url} of JSON.parse(tree.body).nodes) if(url) files.set(url,await content.read(url.slice('/content/dev/'.length)));
      },
    };
  } catch(error) {await close();throw error;}
}
