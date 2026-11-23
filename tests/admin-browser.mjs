// Run against local dist: node tests/admin-browser.mjs.
// UI requests and responses only. This test never starts the app backend or opens a database.
import assert from 'node:assert/strict';
import test from 'node:test';
import {parse} from 'yaml';
import {validateApiDraft} from '../server/content.mjs';
import {markdownInput} from './browser-editors.mjs';
import {startAdminFixture} from './helpers/admin-fixture.mjs';

test('built admin UI against an isolated in-memory request contract',{timeout:90_000},async t=>{
const f=await startAdminFixture();
t.after(f.close);
const {origin,page,reader,state,change}=f;
const wb=page.getByRole('region',{name:'文档管理工作区'}), editor=wb.getByRole('region',{name:'节点编辑器'});
const tabs=page.getByRole('tablist',{name:'管理栏目'}), nav=wb.getByRole('navigation',{name:'工作区目录'});
const btn=(owner,name)=>owner.getByRole('button',{name,exact:true});
const tab=name=>tabs.getByRole('tab',{name,exact:true});
const row=n=>nav.locator(`[data-node-id="${n.id}"]`);
const kids=parent=>state.nodes.filter(n=>n.parentId===parent).sort((a,b)=>a.sort-b.sort);
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const ready=()=>wb.getByRole('status').filter({hasText:'已读取工作区'}).waitFor();
const publicTree=()=>reader.evaluate(async()=>{const r=await fetch('/content/dev/current/tree.json');return {status:r.status,data:await r.json()};});
let step='empty workspace';
async function confirm(action,text,accept=true) {
  const handled=page.waitForEvent('dialog').then(async d=>{
    const ok=d.type()==='confirm' && d.message().includes(text);
    await (ok&&accept?d.accept():d.dismiss());assert.ok(ok,`Unexpected confirmation: ${d.message()}`);
  });await Promise.all([handled,action()]);
}
async function selectTab(name) {
  await tab(name).click();await tabs.getByRole('tab',{name,exact:true,selected:true}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/admin');
}
async function saveTabs(action,titles) {
  const old=kids(null);await change('PUT','/manage/tabs',action,({tabs:sent,...extra})=>{
    assert.deepEqual(extra,{});assert.deepEqual(sent.map(t=>t.title),titles);
    sent.forEach((t,sort)=>{
      const n=old.find(n=>n.id===t.id);assert.match(t.id,uuid);assert.deepEqual(t,{id:t.id,title:titles[sort],sort});
      if(n) {if(n.title!==t.title||n.sort!==sort)n.draftVersion++;Object.assign(n,t);}
      else {assert.ok(!state.nodes.some(n=>n.id===t.id));state.nodes.push({...t,type:'group',body:'',parentId:null,draftVersion:1,publishedVersion:null});}
    });assert.equal(kids(null).length,titles.length);
  });await tab(titles[0]).waitFor();assert.deepEqual(await tabs.getByRole('tab').allTextContents(),titles);
}
async function editTab(old,title,titles) {
  await btn(page,old?`编辑栏目「${old}」`:'新增栏目').click();const form=page.getByRole('form',{name:old?'编辑栏目':'新增栏目'});
  await form.getByLabel('栏目名称').fill(title);await saveTabs(()=>btn(form,'保存栏目').click(),titles);await form.waitFor({state:'hidden'});
  return kids(null).find(n=>n.title===title);
}
async function create(parent,type,title,body='') {
  await btn(nav,`在「${parent.title}」中新增`).click();await btn(nav,`新增${{group:'子目录',markdown:'文档',api:'接口'}[type]}`).click();
  await editor.getByLabel('名称',{exact:true}).fill(title);
  if(type==='markdown') await markdownInput(editor).fill(body);
  let created;
  await change('PUT','/manage/node',()=>btn(wb,'保存草稿').click(),({node,...extra})=>{
    assert.deepEqual(extra,{});assert.match(node.id,uuid);assert.ok(!state.nodes.some(n=>n.id===node.id));
    if(type==='api') {validateApiDraft(node.body,state.nodes);assert.ok(parse(node.body).paths['/example'].get);body=node.body;}
    assert.deepEqual(node,{id:node.id,parentId:parent.id,sort:Math.max(-1,...kids(parent.id).map(n=>n.sort))+1,type,title,body,draftVersion:0,publishedVersion:null});
    created={...node,draftVersion:1};state.nodes.push(created);
  });await row(created).waitFor();return created;
}
async function updateDoc(n,title,body) {
  await btn(nav,`编辑「${n.title}」`).click();await editor.getByLabel('名称',{exact:true}).fill(title);await markdownInput(editor).fill(body);
  await change('PUT','/manage/node',()=>btn(wb,'保存草稿').click(),input=>{
    assert.deepEqual(input,{node:{...n,title,body}});Object.assign(n,{title,body,draftVersion:n.draftVersion+1});
  });
}
async function move(n,target,before) {
  const parent=before?target.parentId:target.id;
  await row(target).scrollIntoViewIfNeeded();const box=await row(target).boundingBox();
  await change('POST','/manage/node/move',()=>row(n).dragTo(row(target),{sourcePosition:{x:8,y:12},targetPosition:{x:box.width/2,y:before?2:box.height/2}}),input=>{
    assert.deepEqual(input,{id:n.id,parentId:parent,beforeId:before?target.id:null});
    const to=kids(parent).filter(c=>c!==n);to.splice(before?to.indexOf(target):to.length,0,n);
    to.forEach((c,sort)=>{if(c.sort!==sort||c===n)c.draftVersion++;c.sort=sort;});n.parentId=parent;
  });await wb.getByRole('status').filter({hasText:'目录位置已保存为草稿'}).waitFor();
}
async function publish(n) {
  await btn(nav,n.title).click();await change('POST','/manage/publish',()=>confirm(()=>btn(wb,'发布此节点').click(),`「${n.title}」`),async input=>{
    assert.deepEqual(input,{id:n.id,draftVersion:n.draftVersion});await f.release([n]);
  });await wb.getByRole('status').filter({hasText:'发布成功'}).waitFor();
}
async function deleteItem(n,isTab) {
  const name=isTab?`删除栏目「${n.title}」`:`删除「${n.title}」`, action=()=>btn(isTab?page:nav,name).click();
  const before=structuredClone(state),count=f.writes.length;
  await confirm(action,name,false);assert.deepEqual(state,before);assert.equal(f.writes.length,count);
  await change('DELETE',isTab?'/manage/tabs':'/manage/node',()=>confirm(action,name),async input=>{
    assert.deepEqual(input,{id:n.id});assert.equal(kids(n.id).length,0);state.nodes.splice(state.nodes.indexOf(n),1);
    if(n.publishedVersion!==null)await f.release([],n.id);
  });await (isTab?tab(n.title):row(n)).waitFor({state:'detached'});
}
try {
  await page.goto(origin+'/admin');await reader.goto(origin+'/doc');
  assert.equal((await publicTree()).status,404);assert.equal(await tabs.getByRole('tab').count(),0);
  step='site name validation/cancel/save';
  const site=page.getByLabel('站点名称',{exact:true});await btn(page,'编辑站点名称').click();
  await site.fill('   ');assert.ok(await btn(page,'保存站点名称').isDisabled());await site.fill('Cancelled');await btn(page,'取消').click();
  await page.getByRole('link',{name:'文档平台',exact:true}).waitFor();assert.equal(f.writes.length,0);
  await btn(page,'编辑站点名称').click();await site.fill('Admin fixture');
  await change('PUT','/manage/site-name',()=>btn(page,'保存站点名称').click(),input=>assert.deepEqual(input,{name:'Admin fixture'}));
  await reader.reload();await reader.getByRole('link',{name:'Admin fixture',exact:true}).waitFor();assert.equal(state.revision,0);
  step='first tab, rename, sort and navigation';
  const writesBeforeCancel=f.writes.length;
  await btn(page,'新增栏目').click();const cancelledTab=page.getByRole('form',{name:'新增栏目'});
  await cancelledTab.getByLabel('栏目名称').fill('   ');assert.ok(await btn(cancelledTab,'保存栏目').isDisabled());
  await cancelledTab.getByLabel('栏目名称').fill('Cancelled tab');await cancelledTab.getByLabel('栏目名称').press('Escape');
  await cancelledTab.waitFor({state:'hidden'});assert.equal(f.writes.length,writesBeforeCancel);assert.equal(kids(null).length,0);
  const root=await editTab(null,'Start',['Start']);assert.ok(await btn(page,'删除栏目「Start」').isDisabled());
  await editTab('Start','Guides',['Guides']);const spare=await editTab(null,'Empty',['Guides','Empty']);
  await saveTabs(()=>tab('Empty').dragTo(tab('Guides'),{sourcePosition:{x:5,y:8},targetPosition:{x:5,y:8}}),['Empty','Guides']);
  await page.reload();await ready();assert.deepEqual(await tabs.getByRole('tab').allTextContents(),['Empty','Guides']);
  await selectTab('Empty');await selectTab('Guides');assert.equal(new URL(page.url()).searchParams.get('doc'),root.id);
  step='create groups, Markdown and API; delete empty tab';
  const library=await create(root,'group','Library');assert.ok(await btn(page,'删除栏目「Guides」').isDisabled());
  await deleteItem(spare,true);assert.ok(await btn(page,'删除栏目「Guides」').isDisabled());
  const scratch=await create(root,'group','Temporary directory');await deleteItem(scratch,false);
  const inbox=await create(root,'group','Inbox'),md=await create(library,'markdown','Manual','Original draft');
  const api=await create(library,'api','Partner endpoint');
  step='collapse/search and restore';
  assert.equal(await btn(nav,'删除「Library」').count(),0,'Nonempty directories cannot be deleted');
  const beforeFold=f.writes.length;
  await btn(wb,'收起目录').click();await nav.waitFor({state:'hidden'});
  await btn(wb,'展开目录').click();await nav.waitFor();assert.equal(f.writes.length,beforeFold);
  await btn(nav,'折叠「Library」').click();await row(md).waitFor({state:'hidden'});
  const search=nav.getByRole('searchbox');await search.fill('Manual');await row(md).waitFor();assert.equal(await row(api).isVisible(),false);
  await btn(nav,'折叠「Library」').click();await row(md).waitFor({state:'hidden'});
  await btn(nav,'展开「Library」').click();await row(md).waitFor();
  await search.fill('');await btn(nav,'展开「Library」').waitFor();assert.equal(await row(md).isVisible(),false);
  await btn(nav,'展开「Library」').click();await row(md).waitFor();
  step='rename, refresh and reopen saved Markdown';
  await updateDoc(md,'Renamed manual','Public edition');assert.equal(md.draftVersion,2);assert.equal(md.publishedVersion,null);
  await btn(wb,'刷新').click();await ready();await page.reload();await ready();assert.equal(new URL(page.url()).searchParams.get('doc'),md.id);
  await editor.getByRole('article').getByText('Public edition',{exact:true}).waitFor();
  step='reorder and reparent a directory with descendants';
  await move(inbox,library,true);await page.reload();await ready();
  const directoryOrder=()=>nav.locator('.wb-row').evaluateAll(rows=>rows.map(r=>r.dataset.nodeId));
  const order=await directoryOrder();assert.ok(order.includes(inbox.id)&&order.indexOf(inbox.id)<order.indexOf(library.id));
  await move(library,inbox,false);await page.reload();await ready();
  assert.deepEqual(kids(inbox.id).map(n=>n.id),[library.id]);await btn(nav,'折叠「Inbox」').click();await row(md).waitFor({state:'hidden'});
  await btn(nav,'展开「Inbox」').click();await row(md).waitFor();await row(api).waitFor();
  step='explicit tab and node publication; reader isolation';
  assert.equal((await publicTree()).status,404);await btn(nav,md.title).click();assert.ok(await btn(wb,'发布此节点').isDisabled());
  await change('POST','/manage/tabs/publish',()=>confirm(()=>btn(page,'发布栏目').click(),'发布所有栏目'),async input=>{assert.deepEqual(input,{});await f.release(kids(null));});
  assert.deepEqual((await publicTree()).data.nodes.map(n=>n.id),[root.id]);
  for(const n of [inbox,library,md])await publish(n);
  const first=(await publicTree()).data.nodes;assert.equal(first.some(n=>n.id===api.id),false);
  const firstURL=first.find(n=>n.id===md.id).url;assert.equal(md.publishedVersion,2);
  await updateDoc(md,'Private revision','Never publish this paragraph');assert.equal(md.draftVersion,3);assert.equal(md.publishedVersion,2);
  await publish(api);const live=(await publicTree()).data.nodes;const liveMD=live.find(n=>n.id===md.id);
  assert.equal(liveMD.title,'Renamed manual');assert.ok(live.some(n=>n.id===api.id));
  for(const path of [firstURL,liveMD.url])assert.equal(await reader.evaluate(async path=>(await fetch(path)).text(),path),'Public edition');
  await reader.goto(`${origin}/doc?tab=${root.id}&doc=${md.id}`);await reader.getByRole('article').getByText('Public edition',{exact:true}).waitFor();
  assert.doesNotMatch(await reader.locator('body').innerText(),/Private revision|Never publish this paragraph/);
  step='cancel/confirm deletion of a published node';
  await deleteItem(api,false);const last=(await publicTree()).data.nodes;assert.ok(!last.some(n=>n.id===api.id));
  assert.equal(last.find(n=>n.id===md.id).title,'Renamed manual');await page.reload();await ready();assert.equal(await row(api).count(),0);
  f.check();console.log(`PASS isolated admin UI: empty workspace, site name, tabs, directory, drafts, explicit release and public reader (${f.writes.length} checked writes; no database or external service).`);
} catch(e) {console.error(`Admin fixture failed at: ${step}`,await page.locator('body').innerText({timeout:1000}).catch(()=>''));f.check();throw e;}
});
