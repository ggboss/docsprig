import test from 'node:test';
import assert from 'node:assert/strict';
import {startAdminFixture} from './helpers/admin-fixture.mjs';

test('API preview has no parent preflight and switches drafts without stale content', {timeout:60000},async t=>{
 const f=await startAdminFixture();t.after(f.close);
 const contract=name=>JSON.stringify({openapi:'3.1.0','x-open-docs-document-kind':'operation',info:{title:name,version:'1'},paths:{['/'+name]:{get:{summary:name,responses:{200:{description:'OK'}}}}}});
 f.state.nodes=[{id:'root',parentId:null,sort:0,title:'API',type:'group',body:'',publishedVersion:null,draftVersion:1},...['first','second'].map((id,sort)=>({id,parentId:'root',sort,title:id,type:'api',body:contract(id),publishedVersion:null,draftVersion:1}))];
 const parents=[];f.page.on('request',r=>{if(new URL(r.url()).pathname==='/manage/preview' && r.frame()===f.page.mainFrame())parents.push(r.url());});
 await f.page.goto(f.origin+'/admin?doc=first');
 const frame=()=>f.page.frameLocator('iframe[title="接口文档预览"]');
 await frame().getByText('/first',{exact:true}).first().waitFor();
 await f.page.getByRole('navigation',{name:'工作区目录'}).locator('[data-node-id="second"]').getByRole('button',{name:'second',exact:true}).click();
 await frame().getByText('/second',{exact:true}).first().waitFor();
 assert.deepEqual(parents,[]);assert.equal(f.writes.length,0);f.check();
});

test('connection edits save and render in admin and public without duplicate admin heading', {timeout:60000},async t=>{
 const f=await startAdminFixture();t.after(f.close);
 const contract={openapi:'3.1.0','x-open-docs-document-kind':'operation',info:{title:'Partner API',version:'1'},
   servers:[{url:'https://old.example'}],components:{securitySchemes:{Authorization:{type:'apiKey',in:'header',name:'Authorization'}}},
   paths:{'/partner':{get:{summary:'Partner API',security:[{Authorization:[]}],responses:{200:{description:'OK'}}}}}};
 const root={id:'root',parentId:null,sort:0,title:'API',type:'group',body:'',publishedVersion:null,draftVersion:1};
 const node={id:'partner',parentId:'root',sort:0,title:'Partner API',type:'api',body:JSON.stringify(contract),publishedVersion:null,draftVersion:1};
 f.state.nodes=[root,node];
 await f.page.goto(f.origin+'/admin?doc=partner');
 const preview=f.page.frameLocator('iframe[title="接口文档预览"]');
 await preview.getByText('/partner',{exact:true}).first().waitFor();
 assert.equal(await f.page.getByRole('heading',{name:'Partner API',exact:true}).count(),0);
 assert.equal(await preview.locator('h2').filter({hasText:'Partner API'}).count(),1);
 await f.page.getByRole('button',{name:'编辑',exact:true}).click();
 await f.page.getByRole('tab',{name:'服务与鉴权',exact:true}).click();
 await f.page.getByLabel('服务地址 1',{exact:true}).fill('https://new.example/v2');
 await f.page.getByLabel('服务地址 1',{exact:true}).press('Tab');
 await f.page.getByLabel('鉴权参数名',{exact:true}).fill('X-Partner-Key');
 await f.page.getByLabel('鉴权参数名',{exact:true}).press('Tab');
 await f.page.getByLabel('鉴权参数位置',{exact:true}).selectOption('query');
 await f.change('PUT','/manage/node',()=>f.page.getByRole('button',{name:'保存草稿',exact:true}).click(),input=>{
   Object.assign(node,input.node,{draftVersion:2});
 });
 await f.page.getByRole('button',{name:'返回阅读',exact:true}).click();
 await preview.getByText('/partner',{exact:true}).first().waitFor();
 assert.match(await preview.locator('body').innerText(),/https:\/\/new\.example/);
 assert.match(await preview.locator('body').innerText(),/X-Partner-Key/);
 await f.release([root,node]);
 await f.reader.goto(f.origin+'/doc?tab=root&doc=partner');
 const published=f.reader.frameLocator('iframe');
 await published.getByText('/partner',{exact:true}).first().waitFor();
 assert.match(await published.locator('body').innerText(),/https:\/\/new\.example/);
 assert.match(await published.locator('body').innerText(),/X-Partner-Key/);
 f.check();
});

test('server hierarchy, stale selection and variable overrides agree with request snippets', {timeout:60000},async t=>{
 const f=await startAdminFixture();t.after(f.close);
 const global=[{url:'https://global.example'}], path=[{url:'https://path.example'}];
 const operation=[{url:'https://{stage}.example/v2',variables:{stage:{default:'test'}}},{url:'https://secondary.example'}];
 const cases=[
  {id:'global',expected:'https://global.example'},
  {id:'path',path,expected:'https://path.example'},
  {id:'operation',path,operation,expected:'https://test.example/v2'},
  {id:'stale',path,operation,selected:'https://global.example',expected:'https://test.example/v2'},
  {id:'selected',path,operation,selected:'https://secondary.example',expected:'https://secondary.example'},
  {id:'variable',path,operation,variables:{'https://{stage}.example/v2':{stage:'prod'}},expected:'https://prod.example/v2'},
 ];
 f.state.nodes=[{id:'root',parentId:null,sort:0,title:'API',type:'group',body:'',publishedVersion:null,draftVersion:1},...cases.map((c,sort)=>({
   id:c.id,parentId:'root',sort,title:c.id,type:'api',publishedVersion:null,draftVersion:1,
   body:JSON.stringify({openapi:'3.1.0','x-open-docs-document-kind':'operation',info:{title:c.id,version:'1'},servers:global,
     paths:{['/'+c.id]:{...(c.path?{servers:c.path}:{}),get:{summary:c.id,...(c.operation?{servers:c.operation}:{}),responses:{200:{description:'OK'}}}}}}),
 }))];
 // Install each case's persisted selection before the renderer initializes.
 await f.page.addInitScript(cases=>{
   const c=cases.find(c=>c.id===new URL(location.href).searchParams.get('doc'));
   if(c)localStorage.setItem('zudoku-selected-server',JSON.stringify({state:{selectedServer:c.selected,serverVariables:c.variables??{}},version:0}));
 },cases);
 for(const c of cases){
   await f.page.goto(f.origin+'/admin?doc='+c.id);
   const frame=f.page.frameLocator('iframe[title="接口文档预览"]');
   await frame.getByText('/'+c.id,{exact:true}).first().waitFor();
   try { await frame.locator('body').filter({hasText:'curl '+c.expected+'/'+c.id}).first().waitFor(); }
   catch(error){t.diagnostic(await frame.locator('body').innerText());throw error;}
   assert.match(await frame.locator('body').innerText(),new RegExp(c.expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 }
 assert.equal(f.writes.length,0);f.check();
});
