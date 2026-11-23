// Shared editor UI regression. Standalone mode serves dist and intercepts all API calls in memory.
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { fileURLToPath } from 'node:url';
import { createContent, validateApiDraft } from '../server/content.mjs';

export function markdownInput(editor) {
  return editor.getByRole('textbox',{name:'Markdown 可视化正文',exact:true});
}

export async function assertNoMarkdownModes(editor) {
  assert.equal(await editor.getByRole('group',{name:'编辑方式',exact:true}).count(),0);
  assert.equal(await editor.getByRole('button',{name:/^(可视化编辑|源码|预览)$/}).count(),0);
  assert.equal(await editor.getByRole('group',{name:'编辑辅助',exact:true}).count(),0);
  assert.equal(await editor.getByRole('button',{name:/^(插入内容|打开格式面板|撤销|重做)$/}).count(),0);
  assert.equal(await editor.getByLabel('Markdown 正文',{exact:true}).count(),0);
}

// Use an actual pointer event, not locator.click()'s retries or selectOption()'s
// DOM selection. A blur-induced remount or swallowed first click must be observable.
async function clickCenter(page,control) {
  await control.scrollIntoViewIfNeeded();
  const point = await control.evaluate(el=>{
    const r=el.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    const hit=document.elementFromPoint(x,y);
    return {x,y,hit:el.contains(hit),label:el.getAttribute('aria-label')||el.textContent,cover:hit?.tagName};
  });
  assert.ok(point.hit,`Center of ${point.label} is covered by ${point.cover} or outside the viewport`);
  await page.mouse.click(point.x,point.y);
}

export async function runVisualEditorRegression({ page, wb, editor, workspace, beginNode, apiSourceMode,
  button, mutate, ready, publicTreeStatus, nonce, tab }) {
    const before = await workspace();
    const mdTitle = `Visual Markdown ${nonce}`, mdText = `Visual draft ${nonce}`;
    await beginNode(tab,tab,'markdown',mdTitle);
    const rich = markdownInput(editor);
    await rich.waitFor();
    await assertNoMarkdownModes(editor);
    await rich.fill(mdText);
    await rich.press('ControlOrMeta+a');
    await rich.press('ControlOrMeta+b');
    await rich.locator('strong').filter({hasText:mdText}).waitFor();
    const body = `**${mdText}**`;
    await rich.focus();
    let saved = await mutate(()=>rich.press('ControlOrMeta+s'),'PUT','/manage/node');
    const md = saved.nodes.find(n=>n.title===mdTitle);
    assert.ok(md); assert.equal(md.body,body); assert.equal(md.publishedVersion,null);
    assert.equal(md.draftVersion,1);
    assert.equal(saved.revision,before.revision+1,'Keyboard shortcut performs exactly one draft save');
    assert.deepEqual(saved.published,before.published,'Ctrl/Cmd+S must never publish');
    await page.reload(); await ready();
    assert.equal(new URL(page.url()).searchParams.get('doc'),md.id);
    await editor.getByRole('article').getByText(mdText,{exact:true}).waitFor();
    await button(editor,'编辑').click();
    await rich.locator('strong').filter({hasText:mdText}).waitFor();
    await assertNoMarkdownModes(editor);
    assert.equal(await button(wb,'保存草稿').isEnabled(),false,'Reloading a visual draft does not dirty it');
    assert.equal((await workspace()).nodes.find(n=>n.id===md.id).body,body);

    const beforeAPI = await workspace();
    const apiTitle = `Form API ${nonce}`, path = '/partners/{userId}', formSummary = `Form summary ${nonce}`;
    await beginNode(tab,tab,'api',apiTitle);
    const form = editor.getByRole('region',{name:'接口结构化编辑器'});
    await form.getByLabel('接口名称（summary）',{exact:true}).waitFor();
    await apiSourceMode();
    const template = parse(await wb.getByLabel('YAML 正文').inputValue());
    assert.equal(template.openapi,'3.1.0','New API template is a complete OpenAPI 3.1 document');
    assert.equal(template['x-open-docs-document-kind'],'operation');
    assert.ok(template.info.title && template.info.version);
    assert.deepEqual(Object.keys(template.paths),['/example']);
    assert.ok(template.paths['/example'].get.operationId);
    assert.ok(template.paths['/example'].get.responses['200']);
    await button(editor,'表单编辑').click();
    const locations = form.getByRole('tablist',{name:'参数位置',exact:true});
    const selectLocation = name => locations.getByRole('tab',{name,exact:true}).click();
    await selectLocation('Query');
    const method = form.getByRole('combobox',{name:/^HTTP 方法/});
    await method.selectOption('post');
    await method.press('Tab');
    const route = form.getByLabel('请求路径',{exact:true});
    await route.fill(path);
    await route.press('Tab');
    assert.equal(await button(form,'应用方法和路径').count(),0);
    await locations.getByRole('tab',{name:'Path',exact:true,selected:true}).waitFor();
    await form.getByLabel('接口名称（summary）',{exact:true}).fill(formSummary);
    await form.getByLabel('操作 ID（operationId）',{exact:true}).fill(`visual${nonce}`);
    await form.getByRole('textbox',{name:/^接口说明/}).fill(`Form description ${nonce}`);
    const selectSection = name => form.getByRole('tablist',{name:'接口内容',exact:true})
      .getByRole('tab',{name,exact:true}).click();
    const selectStatus = name => form.getByRole('tablist',{name:'响应状态码',exact:true})
      .getByRole('tab',{name,exact:true}).click();
    const pathPanel = form.getByRole('tabpanel',{name:'Path',exact:true});
    const queryPanel = form.getByRole('tabpanel',{name:'Query',exact:true});
    const headerPanel = form.getByRole('tabpanel',{name:'Header',exact:true});
    const idsType = headerPanel.getByRole('combobox',{name:'字段类型：ids',exact:true});
    const idsRequired = headerPanel.getByRole('checkbox',{name:'必填：ids',exact:true});
    const idsDescription = headerPanel.getByLabel('字段说明：ids',{exact:true});
    const itemDescription = headerPanel.getByLabel('数组元素说明',{exact:true});
    const idsText = '需要筛选的合作方 ID 列表';
    const itemText = '单个合作方的整数 ID';
    const itemType = headerPanel.getByRole('combobox',{name:'数组元素类型',exact:true});
    const requestBody = form.getByRole('group',{name:'请求体',exact:true});
    const response200 = form.getByRole('group',{name:'响应 200',exact:true});
    const response400 = form.getByRole('group',{name:'响应 400',exact:true});
    async function checkMediaFields(scope,types) {
      const media = scope.getByRole('group',{name:'application/json',exact:true});
      assert.equal(await media.getByLabel('结构类型',{exact:true}).inputValue(),'object');
      assert.equal(await media.getByText('高级 schema · application/json',{exact:true}).count(),0);
      assert.equal(await media.getByLabel('application/json schema',{exact:true}).count(),0);
      assert.equal(await media.getByText('示例与导入',{exact:true}).count(),0);
      assert.equal(await media.getByLabel(/^application\/json (?:命名)?示例$/).count(),0);
      assert.equal(await media.getByText('从示例补全结构',{exact:true}).count(),0);
      for (const [name,type] of Object.entries(types)) {
        assert.equal(await media.getByLabel(`字段类型：${name}`,{exact:true}).inputValue(),type);
      }
    }
    async function addField(parent,name,type) {
      await button(parent,'添加字段').click();
      const draft = parent.getByLabel('字段名称：field',{exact:true});
      await draft.fill(name); await draft.press('Enter');
      await parent.getByLabel(`字段类型：${name}`,{exact:true}).selectOption(type);
      return parent.getByLabel(`字段名称：${name}`,{exact:true}).locator('xpath=ancestor::li[1]');
    }
    assert.equal(await pathPanel.getByLabel('参数名称',{exact:true}).inputValue(),'userId',
      'Blurring /partners/{userId} infers the Path parameter without manually adding it');
    assert.equal(await pathPanel.getByRole('checkbox',{name:'必填',exact:true}).isChecked(),true);
    assert.equal(await pathPanel.getByRole('checkbox',{name:'必填',exact:true}).isDisabled(),true);
    await pathPanel.getByLabel('参数类型',{exact:true}).selectOption('integer');
    await pathPanel.getByLabel('参数说明',{exact:true}).fill('Partner user ID');

    await selectLocation('Query');
    await button(queryPanel,'添加参数').click();
    await queryPanel.getByLabel('参数名称',{exact:true}).fill('limit');
    await queryPanel.getByLabel('参数类型',{exact:true}).selectOption('integer');
    await queryPanel.getByLabel('参数说明',{exact:true}).fill('Independent query limit');
    assert.equal(await queryPanel.getByRole('checkbox',{name:'必填',exact:true}).isChecked(),false);
    assert.equal(await queryPanel.locator('summary').filter({hasText:/参数示例|高级参数 schema/}).count(),0);

    await button(queryPanel,'添加参数').click();
    const secondName = queryPanel.getByLabel('参数名称',{exact:true}).nth(1);
    for (const invalid of ['', 'limit']) {
      await secondName.fill(invalid);
      assert.equal(await secondName.getAttribute('aria-invalid'),'true');
      assert.ok(await button(wb,'保存草稿').isDisabled());
      await selectLocation('Header');
      assert.ok(await button(wb,'保存草稿').isDisabled(),'Hidden invalid Query still blocks save');
      await selectLocation('Query');
      assert.equal(await secondName.inputValue(),invalid);
      await secondName.fill('offset');
      assert.ok(await button(wb,'保存草稿').isEnabled(),'Repairing the invalid name unblocks save');
    }
    await button(queryPanel,'删除参数 offset').click();

    await selectLocation('Header');
    await button(headerPanel,'添加参数').click();
    await headerPanel.getByLabel('参数名称',{exact:true}).fill('X-Partner-Filter');
    await headerPanel.getByLabel('参数类型',{exact:true}).selectOption('object');
    await button(headerPanel,'添加字段').click();
    const newField = headerPanel.getByRole('textbox',{name:'字段名称：field',exact:true});
    await newField.fill('ids');
    await newField.press('Enter');
    await idsType.selectOption('array');
    await idsRequired.check();
    await itemType.selectOption('integer');
    await idsDescription.fill(idsText);
    await itemDescription.fill(itemText);

    await selectSection('请求体');
    await button(requestBody,'添加请求体').click();
    await selectSection('响应');
    await selectStatus('200');
    await button(response200,'添加 JSON 内容').click();
    await form.getByLabel('新增响应',{exact:true}).click();
    await form.getByLabel('新增响应状态码',{exact:true}).fill('400');
    await button(form,'添加响应').click();
    await button(response400,'添加 JSON 内容').click();

    // Seed only existing example data. All three schemas still have no fields;
    // all properties, types, descriptions and required flags below come from the tree.
    const requestExample = {partnerName:'Acme',active:true};
    const successExample = {data:{items:[{deviceId:'d-42'}]}};
    const errorExamples = {invalid:{summary:'Invalid partner',value:{code:'INVALID_PARTNER',message:'Invalid request'}}};
    await apiSourceMode();
    const source = wb.getByLabel('YAML 正文');
    const fixture = parse(await source.inputValue());
    const op = fixture.paths[path].post;
    op.requestBody.content['application/json'].example=requestExample;
    op.responses['200'].content['application/json'].example=successExample;
    op.responses['400'].content['application/json'].examples=errorExamples;
    await source.fill(stringify(fixture));
    await button(editor,'表单编辑').click();

    await selectSection('请求体');
    await requestBody.getByLabel('请求体说明',{exact:true}).fill('Independent JSON body');
    await requestBody.getByRole('checkbox',{name:'请求体必填',exact:true}).check();
    const requestSchema = {type:'object',properties:{partnerName:{type:'string'},active:{type:'boolean'},
      devices:{type:'array',items:{type:'object',properties:{serial:{type:'integer'}}}}}};
    await addField(requestBody,'partnerName','string');
    await addField(requestBody,'active','boolean');
    await button(requestBody,'添加字段').click();
    await requestBody.getByLabel('字段名称：field',{exact:true}).fill('devices');
    // The mousedown blurs and commits the name. The same click must still reach
    // the native select. Headless Chrome does not expose the OS popup to Playwright.
    const pendingType=requestBody.getByLabel('字段类型：field',{exact:true});
    await pendingType.evaluate(el=>el.addEventListener('click',event=>{if(event.isTrusted)el.dataset.pointerHit='yes';},{once:true}));
    await clickCenter(page,pendingType);
    const devicesType=requestBody.getByLabel('字段类型：devices',{exact:true});
    assert.ok(await devicesType.evaluate(el=>el===document.activeElement),'First click after rename focuses the type selector');
    assert.equal(await devicesType.getAttribute('data-pointer-hit'),'yes','First trusted click reaches the renamed row’s dropdown');
    await page.keyboard.press('Escape'); await devicesType.selectOption('array');
    assert.equal(await devicesType.inputValue(),'array');
    await requestBody.getByLabel('数组元素类型',{exact:true}).selectOption('object');
    const devicesRow=devicesType.locator('xpath=ancestor::li[1]');
    await addField(devicesRow,'serial','integer');


    await selectSection('响应');
    await selectStatus('200');
    await response200.getByLabel('响应说明',{exact:true}).fill(`Form success ${nonce}`);
    // Construct data.items[].deviceId only through the response schema tree.
    const deviceText = 'Unique device identifier';
    const successSchema = {type:'object',properties:{data:{type:'object',properties:{items:{type:'array',
      items:{type:'object',properties:{deviceId:{type:'string',description:deviceText}},required:['deviceId']}}}}}};
    const field = label => response200.getByLabel(label,{exact:true});
    await field('结构类型').selectOption('object');
    const dataRow = await addField(response200,'data','object');
    const itemsRow = await addField(dataRow,'items','array');
    await field('数组元素类型').selectOption('object');
    const originalViewport=page.viewportSize();
    await page.setViewportSize({width:390,height:844});
    await button(itemsRow,'添加字段').click();
    await field('字段名称：field').fill('deviceId');
    await clickCenter(page,field('必填：field'));
    assert.ok(await field('必填：deviceId').isChecked(),'Rename blur must not swallow the adjacent checkbox click');
    await field('字段说明：deviceId').fill(deviceText);
    // Exercise the native page scroll with the pointer over the tree.
    const treeY=await page.evaluate(()=>window.scrollY);
    assert.ok(treeY>0,'Nested control is reached by scrolling the page at 390px');
    await page.mouse.wheel(0,-240);
    await page.waitForFunction(y=>window.scrollY<y,treeY);
    const mobileOverflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
      elements:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,class:el.className,right:el.getBoundingClientRect().right})).slice(-20)}));
    if(mobileOverflow.scroll>mobileOverflow.width){console.error('MOBILE OVERFLOW',JSON.stringify(mobileOverflow));await page.screenshot({path:'/tmp/open-editor-overflow.png',fullPage:true});}
    assert.ok(mobileOverflow.scroll<=mobileOverflow.width,'No mobile horizontal overflow');
    await selectStatus('400');
    await response400.getByLabel('响应说明',{exact:true}).fill(`Form error ${nonce}`);
    const errorSchema = {type:'object',properties:{code:{type:'string'},message:{type:'string'}}};
    await addField(response400,'code','string');
    await addField(response400,'message','string');
    const statuses=form.getByRole('tablist',{name:'响应状态码',exact:true});
    for(const code of ['201','503']) {
      await clickCenter(page,form.getByLabel('新增响应',{exact:true}));
      await form.getByLabel('新增响应状态码',{exact:true}).fill(code);
      await clickCenter(page,button(form,'添加响应'));
      await statuses.getByRole('tab',{name:code,exact:true,selected:true}).waitFor();
    }
    await selectStatus('400');
    await clickCenter(page,button(statuses,'删除响应 503'));
    assert.equal(await statuses.getByRole('tab',{name:'400',selected:true}).count(),1,'Deleting an inactive response keeps the current response');
    await selectStatus('201');
    await clickCenter(page,button(statuses,'删除响应 201'));
    await statuses.getByRole('tab',{selected:true,name:/^(200|400)$/}).waitFor();
    assert.equal(await statuses.getByRole('tab').count(),2);
    await page.setViewportSize(originalViewport);


    // All tabs belong to one local edit. Switching sections must neither save nor lose input.
    async function checkReopenedValues() {
      assert.equal(await form.getByLabel('接口名称（summary）',{exact:true}).inputValue(),formSummary);
      assert.equal(await form.getByLabel('操作 ID（operationId）',{exact:true}).inputValue(),`visual${nonce}`);
      assert.equal(await form.getByRole('textbox',{name:/^接口说明/}).inputValue(),`Form description ${nonce}`);
      assert.equal(await form.getByRole('combobox',{name:/^HTTP 方法/}).inputValue(),'post');
      assert.equal(await form.getByLabel('请求路径',{exact:true}).inputValue(),path);
      await selectSection('参数');
      await selectLocation('Path');
      assert.equal(await pathPanel.getByLabel('参数名称',{exact:true}).inputValue(),'userId');
      assert.equal(await pathPanel.getByLabel('参数类型',{exact:true}).inputValue(),'integer');
      assert.equal(await pathPanel.getByLabel('参数说明',{exact:true}).inputValue(),'Partner user ID');
      assert.equal(await pathPanel.getByRole('checkbox',{name:'必填',exact:true}).isChecked(),true);
      assert.equal(await pathPanel.getByRole('checkbox',{name:'必填',exact:true}).isDisabled(),true);
      await selectLocation('Query');
      assert.equal(await queryPanel.getByLabel('参数名称',{exact:true}).inputValue(),'limit');
      assert.equal(await queryPanel.getByLabel('参数类型',{exact:true}).inputValue(),'integer');
      assert.equal(await queryPanel.getByLabel('参数说明',{exact:true}).inputValue(),'Independent query limit');
      assert.equal(await queryPanel.getByRole('checkbox',{name:'必填',exact:true}).isChecked(),false);
      await selectLocation('Header');
      assert.equal(await headerPanel.getByLabel('参数名称',{exact:true}).inputValue(),'X-Partner-Filter');
      assert.equal(await headerPanel.getByLabel('参数类型',{exact:true}).inputValue(),'object');
      const expand = button(headerPanel,'展开参数结构');
      if (await expand.isVisible()) await expand.click();
      assert.equal(await idsType.inputValue(),'array');
      assert.equal(await idsRequired.isChecked(),true);
      assert.equal(await itemType.inputValue(),'integer');
      assert.equal(await idsDescription.inputValue(),idsText);
      assert.equal(await itemDescription.inputValue(),itemText);
      await selectSection('请求体');
      assert.equal(await requestBody.getByLabel('请求体说明',{exact:true}).inputValue(),'Independent JSON body');
      assert.equal(await requestBody.getByRole('checkbox',{name:'请求体必填',exact:true}).isChecked(),true);
      await checkMediaFields(requestBody,{partnerName:'string',active:'boolean',devices:'array',serial:'integer'});
      assert.equal(await requestBody.getByLabel('数组元素类型',{exact:true}).inputValue(),'object');
      await selectSection('响应');
      assert.equal(await form.getByRole('tablist',{name:'响应状态码'}).getByRole('tab').count(),2);
      for (const [status,scope,description] of [
        ['200',response200,`Form success ${nonce}`],
        ['400',response400,`Form error ${nonce}`],
      ]) {
        await selectStatus(status);
        if (status==='200') {
          assert.equal(await field('结构类型').inputValue(),'object');
          assert.equal(await field('字段类型：data').inputValue(),'object');
          assert.equal(await field('字段类型：items').inputValue(),'array');
          assert.equal(await field('数组元素类型').inputValue(),'object');
          assert.equal(await field('字段名称：deviceId').inputValue(),'deviceId');
          assert.equal(await field('字段说明：deviceId').inputValue(),deviceText);
          assert.ok(await field('必填：deviceId').isChecked());
        }
        assert.equal(await scope.getByLabel('响应说明',{exact:true}).inputValue(),description);
        await checkMediaFields(scope,status==='200'?{data:'object'}:{code:'string',message:'string'});
      }
    }
    await checkReopenedValues();
    assert.deepEqual(await workspace(),beforeAPI,'Parameter, Body and response edits stay local until one explicit save');
    saved = await mutate(()=>button(wb,'保存草稿').click(),'PUT','/manage/node');
    assert.equal(saved.revision,beforeAPI.revision+1,'The entire API edit is saved once');
    assert.deepEqual(saved.published,beforeAPI.published);
    const api = saved.nodes.find(n=>n.title===apiTitle);
    assert.ok(api); assert.equal(api.draftVersion,1); assert.equal(api.publishedVersion,null);
    assert.doesNotThrow(() => validateApiDraft(api.body,
      beforeAPI.nodes.filter(node=>node.id!==api.id), beforeAPI.nodes.find(node=>node.id===api.id)?.body),
    'The real server contract validator must accept the complete API source generated by the form');
    const document = parse(api.body), operation = document.paths[path].post;
    assert.equal(document.openapi,'3.1.0');
    assert.equal(document['x-open-docs-document-kind'],'operation');
    assert.deepEqual(document.info,template.info);
    assert.deepEqual(Object.keys(document.paths),[path]);
    assert.deepEqual(Object.keys(document.paths[path]),['post']);
    assert.equal(operation.summary,formSummary); assert.equal(operation.operationId,`visual${nonce}`);
    assert.equal(operation.description,`Form description ${nonce}`);
    assert.equal(operation.parameters.length,3,'Path, Query and Header are separate parameters');
    assert.deepEqual(operation.parameters.find(p=>p.in==='path'),{
      name:'userId',in:'path',required:true,schema:{type:'integer'},description:'Partner user ID',
    });
    assert.deepEqual(operation.parameters.find(p=>p.in==='query'),{
      name:'limit',in:'query',required:false,schema:{type:'integer'},description:'Independent query limit',
    });
    assert.deepEqual(operation.parameters.find(p=>p.in==='header'),{
      name:'X-Partner-Filter',in:'header',required:false,
      schema:{type:'object',required:['ids'],properties:{
        ids:{type:'array',description:idsText,items:{type:'integer',description:itemText}},
      }},
    });
    assert.deepEqual(operation.requestBody,{description:'Independent JSON body',required:true,
      content:{'application/json':{schema:requestSchema,example:requestExample}}});
    assert.deepEqual(operation.responses,{
      '200':{description:`Form success ${nonce}`,content:{'application/json':{schema:successSchema,example:successExample}}},
      '400':{description:`Form error ${nonce}`,content:{'application/json':{schema:errorSchema,examples:errorExamples}}},
    });
    await page.reload(); await ready();
    assert.equal(new URL(page.url()).searchParams.get('doc'),api.id);
    await button(editor,'编辑').click();
    assert.equal(await button(editor,'表单编辑').getAttribute('aria-pressed'),'true');
    await form.getByLabel('接口名称（summary）',{exact:true}).waitFor();
    await checkReopenedValues();
    await apiSourceMode();
    assert.equal(await wb.getByLabel('YAML 正文').inputValue(),api.body,'Persisted API source survives form reload exactly');
    await button(editor,'表单编辑').click();
    assert.equal(await button(wb,'保存草稿').isEnabled(),false,'Form/source switching must not dirty an unchanged draft');
    const after = await workspace();
    assert.equal(after.nodes.find(n=>n.id===api.id).body,api.body);
    assert.deepEqual(after.published,before.published,'Visual/form draft saves must not publish');
    assert.equal(await publicTreeStatus(),404);
  }

// Run after pnpm build: node tests/browser-editors.mjs
// Optional installed browser: SMOKE_BROWSER_CHANNEL=chrome node tests/browser-editors.mjs
// No PostgreSQL, environment file, real backend, or fixed development port is used.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createRequire } = await import('node:module');
  const { access } = await import('node:fs/promises');
  const { withPortal } = await import('../server/portal.mjs');
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.SMOKE_PLAYWRIGHT || 'playwright');
  const dist = fileURLToPath(new URL('../dist/',import.meta.url));
  await access(new URL('../dist/admin.html',import.meta.url)).catch(() => {
    throw new Error('Missing dist/admin.html. Run pnpm build before pnpm test:editors:browser.');
  });
  const bypasses = [], unexpected = [], blockedExternal = [], errors = [], writes = [];
  // A missed interception fails closed; this server has no data-access capability.
  const server = createServer(withPortal((req,res)=>{
    bypasses.push(`${req.method} ${req.url}`);
    res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Unmocked API request'}));
  },dist));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const nonce = Date.now().toString(36), tab = 'Editor fixture';
  let state = { revision:0, published:null, nodes:[{id:'editor-fixture-root',parentId:null,sort:0,
    title:tab,type:'group',body:'',draftVersion:1,publishedVersion:null}] };
  const publicFiles = new Map();
  let browser, page;
  try {
    browser = await chromium.launch({channel:process.env.SMOKE_BROWSER_CHANNEL || undefined});
    const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
    await context.routeWebSocket('**/*',socket=>socket.close());
    await context.route('**/*',async route=>{
      const request = route.request(), url = new URL(request.url()), method = request.method();
      // Built Zudoku pages may request their CDN favicon. No external request is sent.
      if (url.origin!==origin) { blockedExternal.push(`${method} ${url.origin}${url.pathname}`); return route.abort(); }
      const json = (status,value) => route.fulfill({status,contentType:'application/json',
        headers:{'Cache-Control':'no-store'},body:JSON.stringify(value)});
      if (method==='GET' && url.pathname==='/manage/session') return json(200,{admin:true});
      if (method==='GET' && url.pathname==='/content/site-name.json') return json(200,{name:'Editor fixture'});
      if (method==='GET' && publicFiles.has(url.pathname)) return route.fulfill(publicFiles.get(url.pathname));
      if (method==='GET' && url.pathname==='/content/dev/current/tree.json') return json(404,{error:'Unpublished fixture'});
      if (method==='GET' && url.pathname==='/manage/workspace') return json(200,state);
      if (method==='GET' && url.pathname==='/manage/preview') {
        const selected = state.nodes.find(n=>n.id===url.searchParams.get('doc'));
        return selected ? json(200,parse(selected.body)) : json(404,{error:'Missing fixture node'});
      }
      if (method==='PUT' && url.pathname==='/manage/node') {
        const input = request.postDataJSON();
        assert.equal(input.revision,state.revision,'UI must submit the last loaded revision');
        const old = state.nodes.find(n=>n.id===input.node.id);
        const next = {...input.node,draftVersion:(old?.draftVersion??0)+1,publishedVersion:null};
        writes.push(structuredClone(input));
        state = {...state,revision:state.revision+1,nodes:old
          ? state.nodes.map(n=>n.id===next.id?next:n) : [...state.nodes,next]};
        return json(200,state);
      }
      if (/^\/(?:manage|content)(?:\/|$)/.test(url.pathname)) {
        unexpected.push(`${method} ${url.pathname}`);
        return json(501,{error:'Unexpected fixture request'});
      }
      if (method!=='GET' && method!=='HEAD') { unexpected.push(`${method} ${url.pathname}`); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror',error=>errors.push(error.message));
    const wb = page.getByRole('region',{name:'文档管理工作区'});
    const editor = wb.getByRole('region',{name:'节点编辑器'});
    const nav = wb.getByRole('navigation',{name:'工作区目录'});
    const tabs = page.getByRole('tablist',{name:'管理栏目'});
    const button = (scope,name) => scope.getByRole('button',{name,exact:true});
    const ready = () => wb.getByRole('status').filter({hasText:'已读取工作区'}).waitFor();
    // Browser fetches pass through the same route fixture as the application.
    const workspace = () => page.evaluate(async()=> (await fetch('/manage/workspace')).json());
    const publicTreeStatus = () => page.evaluate(async()=> (await fetch('/content/dev/current/tree.json')).status);
    async function apiSourceMode() {
      await button(editor,'源码').click();
      await wb.getByLabel('YAML 正文').waitFor();
    }
    async function beginNode(tab,parent,type,name) {
      await tabs.getByRole('tab',{name:tab,exact:true}).click();
      await button(nav,`在「${parent}」中新增`).click();
      await button(nav,`新增${type==='api'?'接口':'文档'}`).click();
      await page.waitForFunction(()=>document.activeElement?.id==='wb-title');
      await wb.getByLabel('名称',{exact:true}).fill(name);
      if (type==='api') {
        assert.equal(await button(editor,'表单编辑').getAttribute('aria-pressed'),'true');
        assert.equal(await wb.getByLabel('YAML 正文').count(),0);
      }
    }
    async function mutate(action,method,endpoint) {
      const [response] = await Promise.all([page.waitForResponse(r=>r.url()===origin+endpoint && r.request().method()===method),action()]);
      assert.equal(response.status(),200);
      const data = await response.json();
      await wb.getByRole('status').filter({hasText:'草稿已保存'}).waitFor();
      return data;
    }
    await page.goto(`${origin}/admin?doc=editor-fixture-root`); await ready();
    await runVisualEditorRegression({page,wb,editor,workspace,beginNode,apiSourceMode,button,mutate,ready,publicTreeStatus,nonce,tab});
    // A buffered rename alone is a draft change, even before Enter/blur.
    const status400 = editor.getByRole('group',{name:'响应 400',exact:true});
    const open400 = async () => {
      await editor.getByRole('tab',{name:'响应',exact:true}).click();
      await editor.getByRole('tab',{name:'400',exact:true}).click();
    };
    await open400();
    const name = status400.getByLabel('字段名称：message',{exact:true});
    const beforeRename = structuredClone(state);
    assert.equal(writes.length,2);
    await name.fill('code');
    assert.ok(await button(wb,'保存草稿').isDisabled());
    await name.press('ControlOrMeta+s');
    assert.deepEqual(await workspace(),beforeRename,'Duplicate name + shortcut must not write');
    await name.fill('reason'); // No Enter, Tab or click before Cmd/Ctrl+S.
    const renamed = await mutate(()=>name.press('ControlOrMeta+s'),'PUT','/manage/node');
    assert.equal(renamed.revision,beforeRename.revision+1);
    const savedApi = renamed.nodes.find(n=>n.type==='api');
    const previous = parse(beforeRename.nodes.find(n=>n.id===savedApi.id).body);
    const props = previous.paths['/partners/{userId}'].post.responses['400'].content['application/json'].schema.properties;
    props.reason = props.message; delete props.message;
    assert.deepEqual(parse(savedApi.body),previous,'Shortcut commits just the focused field rename');
    validateApiDraft(savedApi.body,renamed.nodes.filter(n=>n.id!==savedApi.id));
    await page.reload(); await ready(); await button(editor,'编辑').click(); await open400();
    assert.equal(await status400.getByLabel('字段名称：reason',{exact:true}).inputValue(),'reason');
    assert.ok(await button(wb,'保存草稿').isDisabled());
    const visibleName=status400.getByLabel('字段名称：reason',{exact:true});
    await visibleName.fill('message');
    const saveButton=button(wb,'保存草稿');
    const clicked=await mutate(()=>clickCenter(page,saveButton),'PUT','/manage/node');
    assert.equal(clicked.revision,renamed.revision+1);
    assert.equal(writes.length,4,'A single pointer click saves a valid buffered rename exactly once');
    const restored=clicked.nodes.find(n=>n.id===savedApi.id);
    assert.deepEqual(parse(restored.body),parse(beforeRename.nodes.find(n=>n.id===savedApi.id).body));
    if(process.env.SMOKE_EDITOR_SCREENSHOTS) {
      const {join}=await import('node:path');
      await editor.getByRole('tab',{name:'200',exact:true}).click();
      for(const [label,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
        await page.setViewportSize({width,height});
        const toolbar=editor.getByRole('tablist',{name:'接口内容',exact:true});
        await toolbar.evaluate(el=>{el.scrollIntoView({block:'start'});window.scrollBy(0,-76);});
        await page.screenshot({path:join(process.env.SMOKE_EDITOR_SCREENSHOTS,`${label}.png`),animations:'disabled'});
      }
      await page.setViewportSize({width:1440,height:1000});
    }
    // Only now expose an in-memory release, built from the actual saved API draft.
    // The earlier assertions still require that neither editor save published anything.
    const api = state.nodes.find(n=>n.type==='api');
    const snapshot = structuredClone({revision:state.revision,nodes:state.nodes.filter(n=>n.id===api.id || n.id===api.parentId)});
    const content = createContent({loadRelease:id=>id===release.id?snapshot:null});
    const release = await content.stage(snapshot);
    const tree = await content.read(`releases/${release.id}/tree.json`);
    publicFiles.set('/content/dev/current/tree.json',tree);
    const specURL = JSON.parse(tree.body).nodes.find(n=>n.id===api.id).url;
    publicFiles.set(specURL,await content.read(specURL.slice('/content/dev/'.length)));
    await page.goto(`${origin}/doc?tab=${api.parentId}&doc=${api.id}`);
    const frame = page.frameLocator(`iframe[title="${api.title}"]`);
    const data = frame.getByRole('button',{name:'data',exact:true});
    const items = frame.getByRole('button',{name:'items',exact:true});
    await data.waitFor();
    if (!await items.isVisible()) await data.click();
    const device = frame.locator('[data-slot="item-title"] code').filter({hasText:/^deviceId$/});
    if (!await device.isVisible()) await items.click();
    await device.waitFor();
    const property = device.locator('xpath=ancestor::*[@data-slot="item"][1]');
    await property.getByText('Unique device identifier',{exact:true}).waitFor();
    await property.getByText('required',{exact:true}).waitFor();
    assert.equal(writes.length,4,'One save per valid shortcut/click, none for the invalid rename');
    assert.deepEqual(errors,[],'No uncaught browser errors');
    assert.deepEqual(unexpected,[],'No unexpected API requests');
    assert.deepEqual(bypasses,[],'Every data request must be intercepted before reaching the static server');
    console.log('PASS in-memory headless editor regression: default visual/form modes, Markdown bold, Ctrl/Cmd+S draft save, inferred required Path /partners/{userId}, scalar Query, Header object with required integer array, JSON body and 200+400 responses in one save, real validateApiDraft acceptance, API source roundtrip, reopened values, no implicit publication, and nested response fields in a staged reader fixture. No database used.');
    if (blockedExternal.length) console.log(`Blocked ${blockedExternal.length} external asset requests.`);
  } catch (error) {
    if (page && !page.isClosed()) console.error('EDITOR FIXTURE STATE',await page.locator('body').innerText({timeout:1500}).catch(()=>'(unavailable)'));
    throw error;
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}
