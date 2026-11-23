import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpHandler} from '../server/mcp.mjs';
import {createPublicMcpServer} from '../server/mcp-public.mjs';
import {createMcpEndpoint} from '../server/mcp-http.mjs';
import {withPortal} from '../server/portal.mjs';

test('public and administrator MCP endpoints have isolated capabilities and credentials',async t=>{
 const token='isolated-test-administrator-token-123456789';let adminReads=0,writes=0;
 const store={read:async()=>{adminReads++;return {revision:7,published:null,nodes:[{id:'private-draft',type:'markdown',body:'UNPUBLISHED_PRIVATE_TEXT'}]};},
 current:async()=>null,siteName:async()=>({name:'Public site'}),saveNode:async()=>{writes++;throw Error('Unexpected write');}};
 let admin,reader;
 const server=createServer(withPortal((req,res)=>{
   if(req.url==='/mcp/admin')return admin(req,res);
   if(req.url==='/mcp/docs')return reader(req,res);
   res.writeHead(404).end();
 },'/nonexistent-test-dist'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 admin=createMcpHandler({origin,token,store,content:{}});
 reader=createMcpEndpoint({origin,path:'/mcp/docs',createServer:()=>createPublicMcpServer({store,content:{read:()=>assert.fail('No publication should be read')}})});
 const clients=[];t.after(async()=>{for(const c of clients)await c.close();});
 async function connect(path,key){const c=new Client({name:'isolation-test',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(origin+path),{requestInit:key?{headers:{Authorization:`Bearer ${key}`}}:{}}));return c;}
 const publicClient=await connect('/mcp/docs');
 const tools=(await publicClient.listTools()).tools;
 assert.equal(tools.length,5);assert.ok(tools.every(t=>t.name.startsWith('docs_public_')&&t.annotations.readOnlyHint&&t.annotations.destructiveHint===false));
 assert.doesNotMatch(JSON.stringify(tools),/UNPUBLISHED_PRIVATE_TEXT/);
 const listed=await publicClient.callTool({name:'docs_public_list',arguments:{}});
 assert.doesNotMatch(JSON.stringify(listed),/UNPUBLISHED_PRIVATE_TEXT|private-draft/);assert.equal(adminReads,0);
 const denied=await publicClient.callTool({name:'docs_node_create',arguments:{revision:7,parentId:'root',title:'injected',type:'markdown',sort:0,body:'no'}}).catch(()=>({isError:true}));
 assert.equal(denied.isError,true);assert.equal(writes,0);
 const credentialedReader=await connect('/mcp/docs',token);
 assert.deepEqual((await credentialedReader.listTools()).tools.map(t=>t.name),tools.map(t=>t.name),'admin credential cannot elevate public endpoint');
 const administrator=await connect('/mcp/admin',token);assert.equal((await administrator.listTools()).tools.length,14);
 await administrator.callTool({name:'docs_workspace_get',arguments:{}});assert.equal(adminReads,1);
 for(const path of ['/mcp','/mcp/other'])assert.equal((await fetch(origin+path)).status,404);
 const post={method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})};
 assert.equal((await fetch(origin+'/mcp/admin',post)).status,401);
 assert.equal((await fetch(origin+'/mcp/admin',{...post,headers:{...post.headers,cookie:'docs_session=browser-cookie'}})).status,401);
 assert.equal((await fetch(origin+'/mcp/docs',{...post,headers:{...post.headers,Origin:'https://hostile.example'}})).status,403);
 const hostileStatus=await new Promise((resolve,reject)=>{const r=request(origin+'/mcp/docs',{method:'POST',headers:{...post.headers,Host:'hostile.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);r.end(post.body);});
 assert.equal(hostileStatus,403);
 assert.equal((await fetch(origin+'/mcp/docs')).status,405);
 assert.equal(adminReads,1);assert.equal(writes,0);
});
