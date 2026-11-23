import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {configuredOrigins, routeOrigins} from '../server/origins.mjs';
import {handler} from '../server/http.mjs';
import {adminActor} from '../server/auth.mjs';
import {createMcpEndpoint} from '../server/mcp-http.mjs';
import {createPublicMcpServer} from '../server/mcp-public.mjs';
import {createMcpHandler} from '../server/mcp.mjs';

test('origin configuration is explicit and rejects ambiguous or malformed aliases', () => {
  assert.deepEqual(configuredOrigins('http://localhost:4391',' http://127.0.0.1:4391,http://localhost:4391 '),['http://localhost:4391','http://127.0.0.1:4391']);
  for (const alias of ['*','null','https://user:password@example.com','http://example.com/path','http://example.com/','https://localhost:4391'])
    assert.throws(()=>configuredOrigins('http://localhost:4391',alias));
});

test('LAN and loopback aliases support login, CRUD, publication, MCP and logout with isolated origins', async t => {
  const origins = configuredOrigins('http://192.0.2.10:4391','http://127.0.0.1:4391,http://localhost:4391');
  const token = 'test-only-mcp-token-'.repeat(3);
  let writes=0;
  const write=async()=>({revision:++writes,nodes:[]});
  const store={read:async()=>({revision:writes,nodes:[]}),saveNode:write,moveNode:write,deleteNode:write,publishNode:write,
    saveTabs:write,deleteTab:write,publishTabs:write,setSiteName:write,siteName:async()=>({name:'Test'})};
  const content={stage:async()=>({id:'test'})};
  const server=createServer(routeOrigins(origins,origin=>{
    const manage=handler({store,content,authenticate:adminActor,origin,mcpToken:token});
    const pub=createMcpEndpoint({origin,path:'/mcp/docs',createServer:()=>createPublicMcpServer({store,content})});
    const admin=createMcpHandler({store,content,origin,token});
    return (req,res)=>req.url==='/mcp/docs'?pub(req,res):req.url==='/mcp/admin'?admin(req,res):manage(req,res);
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const request=(origin,path,{method='POST',cookie,body={},headers={}}={})=>new Promise((resolve,reject)=>{
    const payload=method==='GET'?undefined:JSON.stringify(body);
    const req=httpRequest({hostname:'127.0.0.1',port:server.address().port,path,method,
      headers:{host:new URL(origin).host,origin,'content-type':'application/json',...(payload?{'content-length':Buffer.byteLength(payload)}:{}),...(cookie?{cookie}:{}),...headers}},res=>{
      let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:text?JSON.parse(text):null}));
    });req.on('error',reject);req.end(payload);
  });
  const mutations=[
    ['/manage/node','PUT',{revision:0,node:{id:'doc',parentId:'root',sort:0,title:'Doc',type:'markdown',body:'text'}}],
    ['/manage/node/move','POST',{revision:0,id:'doc',parentId:'root',beforeId:null}],
    ['/manage/publish','POST',{revision:0,id:'doc',draftVersion:1}],
    ['/manage/node','DELETE',{revision:0,id:'doc'}],
    ['/manage/tabs','PUT',{revision:0,tabs:[{id:'root',title:'API',sort:0}]}],
    ['/manage/tabs/publish','POST',{revision:0}],
    ['/manage/tabs','DELETE',{revision:0,id:'empty'}],
    ['/manage/site-name','PUT',{name:'Test'}],
  ];
  for (const origin of origins) {
    const login=await request(origin,'/manage/login',{body:{username:process.env.DOCS_ADMIN_USERNAME??'admin',password:process.env.DOCS_ADMIN_PASSWORD??'admin'}});
    assert.equal(login.status,200,origin);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(origin,'/manage/session',{method:'GET',cookie})).status,200);
    for (const [path,method,body] of mutations) assert.equal((await request(origin,path,{method,body,cookie})).status,200,`${origin} ${path}`);
    const config=await request(origin,'/manage/mcp-config',{cookie});
    assert.equal(config.status,200);assert.equal(config.data.url,origin+'/mcp/admin');
    const rpc={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}};
    for (const path of ['/mcp/docs','/mcp/admin']) {
      const headers={accept:'application/json, text/event-stream',...(path==='/mcp/admin'?{authorization:`Bearer ${token}`}:{})};
      assert.equal((await request(origin,path,{body:rpc,headers})).status,200);
      assert.equal((await request(origin,path,{body:rpc,headers:{...headers,origin:'https://attacker.invalid'}})).status,403);
    }
    const before=writes;
    for (const headers of [{origin:'null'},{origin:'https://attacker.invalid'},{origin:origins.find(other=>other!==origin)},{'sec-fetch-site':'cross-site'},{host:'attacker.invalid','x-forwarded-host':new URL(origin).host}]) {
      assert.equal((await request(origin,'/manage/login',{headers,body:{username:'admin',password:'admin'}})).status,403);
      for (const [path,method,body] of mutations) assert.equal((await request(origin,path,{method,body,cookie,headers})).status,403);
    }
    assert.equal(writes,before);
    assert.equal((await request(origin,'/manage/logout',{cookie})).status,200);
    assert.equal((await request(origin,'/manage/session',{method:'GET',cookie})).status,401);
  }
  assert.equal(writes,origins.length*mutations.length);
});
