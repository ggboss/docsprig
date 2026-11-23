import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {parse} from 'yaml';

// Use the existing build toolchain; no added dependency or running backend required.
const require = createRequire(import.meta.resolve('zudoku'));
const {build} = require('esbuild');
const root=fileURLToPath(new URL('../',import.meta.url));

test('structured editor integrates validity gate, dialect preservation, multi-operation selection and mobile layout', {timeout:60000}, async()=>{
  const built=await build({stdin:{contents:`
    import React,{useState,useCallback} from 'react';import {createRoot} from 'react-dom/client';
    import OpenApiEditor from './src/OpenApiEditor.tsx';
    function App(){const [source,setSource]=useState(''),[valid,setValid]=useState(true),[key,setKey]=useState(0);
      const reportValidity=useCallback(next=>{(window.validityEvents ??= []).push(next);setValid(next);},[]);
      window.resetEditor=(next)=>{window.validityEvents=[];window.savedSources=[];setSource(next);setKey(k=>k+1)};
      return <><OpenApiEditor key={key} value={source} onChange={setSource} onValidityChange={reportValidity}/><button id="save" style={{position:"fixed",top:0,right:0,zIndex:100}} disabled={!valid} onClick={()=>window.savedSources.push(source)}>保存测试</button><pre id="source">{source}</pre></>}
    createRoot(document.getElementById('root')).render(<App/>);
  `,resolveDir:root,loader:'tsx'}, bundle:true,write:false,outdir:'api-editor-test',format:'esm',jsx:'automatic'});
  const js=built.outputFiles.find(f=>f.path.endsWith('.js')).text, css=built.outputFiles.find(f=>f.path.endsWith('.css')).text;
  const server=createServer((req,res)=>{
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(js);}
    else if(req.url==='/bundle.css'){res.setHeader('Content-Type','text/css');res.end(css);}
    else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.SMOKE_BROWSER_CHANNEL?{channel:process.env.SMOKE_BROWSER_CHANNEL}:{})});
    const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>typeof window.resetEditor==='function');
    const source=JSON.stringify({
      openapi:'3.1.0', 'x-open-docs-document-kind':'operation', info:{title:'UI',version:'1'},
      paths:{'/items':{
        get:{summary:'List',operationId:'list',
          parameters:[{name:'filter',in:'query',schema:{type:'string'},example:'active'},
            {name:'X-Trace',in:'header',schema:{type:'string'},examples:{trace:{value:'trace-001'}}}],
          requestBody:{content:{'application/json':{schema:{type:'object',properties:{filter:{type:'string'}}},
            examples:{saved:{summary:'Preserved request payload',value:{filter:'active'}}}}}},responses:{'200':{description:'OK',content:{
          'application/json':{schema:{type:'object',properties:{id:{type:'integer'},name:{type:'string'}}},example:{id:1}},
          'application/xml':{schema:{type:'string'},examples:{saved:{summary:'Preserved response payload',value:'<id>1</id>'}}}
        }}}},
        post:{summary:'Create',responses:{'201':{description:'Created'}}}
      }}
    });
    const reset=async text=>{await page.evaluate(text=>window.resetEditor(text),text);await page.waitForTimeout(30);};
    const saved=async()=>parse(await page.locator('#source').textContent());
    const tab=async name=>page.getByRole('tab',{name,exact:true}).click();
    const response=()=>page.getByRole('group',{name:'响应 200',exact:true});
    const body=()=>page.getByRole('group',{name:'请求体',exact:true});
    async function noExampleUI() {
      const editor=page.locator('.api-editor');
      assert.equal(await editor.getByRole('button',{name:/示例|导入|example|import/i,includeHidden:true}).count(),0);
      assert.equal(await editor.getByLabel(/示例|导入|example|import/i).count(),0);
      assert.equal(await editor.locator('summary').filter({hasText:/示例|导入|example|import/i}).count(),0);
      assert.equal(await editor.locator('input[type="file"]').count(),0);
      assert.doesNotMatch(await editor.textContent(),/示例|导入/,'No visible or hidden panel retains example/import UI');
    }
    async function addField(scope,name,type='string') {
      await scope.getByRole('button',{name:'添加字段',exact:true}).click();
      const field=scope.getByLabel('字段名称：field',{exact:true});
      await field.fill(name);await field.blur();
      await scope.getByLabel(`字段类型：${name}`,{exact:true}).selectOption(type);
    }
    function preservedExamples(document) {
      const op=document.paths['/items'].get;
      const original=JSON.parse(source).paths['/items'].get;
      assert.deepEqual(op.parameters,original.parameters,'Parameter examples survive ordinary edits');
      assert.deepEqual(op.requestBody.content['application/json'].examples,original.requestBody.content['application/json'].examples);
      assert.deepEqual(op.responses['200'].content['application/json'].example,original.responses['200'].content['application/json'].example);
      assert.deepEqual(op.responses['200'].content['application/xml'].examples,original.responses['200'].content['application/xml'].examples);
    }
    await reset(source);
    assert.equal(await page.locator('#source').textContent(),source);
    assert.equal(await page.evaluate(()=>window.validityEvents.includes(false)),false);
    await page.getByLabel('接口名称（summary）').fill('Updated');
    await tab('响应');
    await noExampleUI();
    const responseJSON=response().getByRole('group',{name:'application/json',exact:true});
    const fieldName=responseJSON.getByLabel('字段名称：id',{exact:true});
    await fieldName.fill('name');
    assert.equal(await page.locator('#save').isDisabled(),true);
    await tab('请求体');
    await body().waitFor();await noExampleUI();
    assert.equal(await page.locator('#save').isDisabled(),true,'Hidden duplicate field name still blocks save');
    assert.equal(await page.getByLabel('选择操作').isDisabled(),true);
    await tab('响应');
    assert.equal(await fieldName.inputValue(),'name','Switching tabs preserves invalid field names');
    await page.getByLabel('接口名称（summary）').fill('Still editing');
    assert.equal(await page.locator('#save').isDisabled(),true);assert.equal(await fieldName.inputValue(),'name');
    await fieldName.fill('itemId');await fieldName.blur();
    assert.equal(await page.locator('#save').isEnabled(),true);
    preservedExamples(await saved());
    await page.getByLabel('请求路径',{exact:true}).fill('/moved');
    await page.getByLabel('请求路径',{exact:true}).blur();
    assert.match(await page.locator('.api-editor').textContent(),/多个操作/);
    await page.getByLabel('请求路径',{exact:true}).fill('/items');
    await page.getByLabel('选择操作').selectOption(JSON.stringify(['/items','post']));
    await page.getByLabel('接口名称（summary）').fill('Create changed');
    assert.equal((await saved()).paths['/items'].get.summary,'Still editing');
    await tab('参数');
    for(const [location,name] of [['Query','q'],['Header','X-Trace'],['Cookie','session']]){
      await tab(location);
      await page.getByRole('button',{name:'添加参数',exact:true}).click();
      const panel=page.getByRole('tabpanel',{name:location,exact:true});
      await panel.getByLabel('参数名称',{exact:true}).fill(name);
      await panel.getByLabel('参数类型').selectOption({label:'整数'});
    }
    // Top-level Query names: duplicate, empty and whitespace-only names block save,
    // even while another parameter tab is visible. Returning to Query permits repair.
    await tab('Query');
    const query=page.getByRole('tabpanel',{name:'Query',exact:true});
    await query.getByRole('button',{name:'添加参数',exact:true}).click();
    const second=query.getByLabel('参数名称',{exact:true}).nth(1);
    for(const [invalid,message] of [['q','Query 中已有 q'],['','参数名称不能为空'],['   ','参数名称不能为空']]) {
      await second.fill(invalid);
      assert.equal(await second.getAttribute('aria-invalid'),'true');
      assert.ok(await page.locator('#save').isDisabled());
      await tab('Header');
      assert.ok(await page.locator('#save').isDisabled(),'Hidden Query error must still block save');
      assert.ok(await page.getByLabel('选择操作').isDisabled());
      await tab('Query');
      assert.equal(await second.inputValue(),invalid);
      assert.equal(await second.getAttribute('aria-invalid'),'true');
      await query.getByRole('alert').filter({hasText:message}).first().waitFor();
      await second.fill('offset');
      assert.equal(await second.getAttribute('aria-invalid'),'false');
      assert.ok(await page.locator('#save').isEnabled());
      assert.ok(await page.getByLabel('选择操作').isEnabled());
    }
    await query.getByRole('button',{name:'删除参数 offset',exact:true}).click();
    await tab('Cookie');
    assert.deepEqual((await saved()).paths['/items'].post.parameters.map(p=>[p.in,p.name]),[['query','q'],['header','X-Trace'],['cookie','session']]);
    // Tabs implement arrow-key navigation without mutating source.
    const beforeTab=await page.locator('#source').textContent();
    await page.getByRole('tab',{name:'Cookie',exact:true}).press('ArrowLeft');
    assert.equal(await page.getByRole('tab',{name:'Header',exact:true}).getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('#source').textContent(),beforeTab);
    await tab('请求体');await page.getByRole('button',{name:'添加请求体',exact:true}).click();
    await addField(body(),'userId','integer');
    await addField(body(),'name');
    await noExampleUI();
    await body().getByLabel('字段说明：userId',{exact:true}).fill('用户 ID');
    await body().getByLabel('必填：userId',{exact:true}).check();
    const bodySchema=(await saved()).paths['/items'].post.requestBody.content['application/json'].schema;
    assert.deepEqual(bodySchema.properties.userId,{type:'integer',description:'用户 ID'});
    assert.deepEqual(bodySchema.required,['userId']);
    await tab('响应');
    const addResponse=page.getByLabel('新增响应',{exact:true});
    const statusInput=page.getByLabel('新增响应状态码',{exact:true});
    assert.equal(await statusInput.isVisible(),false);
    await addResponse.click();await statusInput.press('Escape');
    assert.equal(await statusInput.isVisible(),false,'Escape closes the response form');
    await addResponse.click();await statusInput.fill('400');
    await page.getByRole('button',{name:'添加响应',exact:true}).click();
    assert.equal(await statusInput.isVisible(),false,'Adding a response closes the form');
    assert.equal(await page.getByRole('tab',{name:'400',exact:true}).getAttribute('aria-selected'),'true');
    const errorResponse=page.getByRole('group',{name:'响应 400',exact:true});
    await errorResponse.getByLabel('响应说明',{exact:true}).fill('参数错误');
    await errorResponse.getByRole('button',{name:'添加 JSON 内容',exact:true}).click();
    await addField(errorResponse,'message');
    await noExampleUI();
    assert.equal((await saved()).paths['/items'].post.responses['400'].content['application/json'].schema.properties.message.type,'string');
    preservedExamples(await saved());
    await tab('201');assert.equal(await page.getByRole('group',{name:'响应 201',exact:true}).isVisible(),true);
    if(process.env.API_EDITOR_SCREENSHOTS) await page.locator('.api-editor').screenshot({path:`${process.env.API_EDITOR_SCREENSHOTS}/api-editor-desktop.png`});
    await page.setViewportSize({width:390,height:844});await tab('参数');await tab('Header');
    assert.ok(await page.locator('.api-editor').evaluate(el=>el.scrollWidth<=el.clientWidth));
    if(process.env.API_EDITOR_SCREENSHOTS) await page.locator('.api-editor').screenshot({path:`${process.env.API_EDITOR_SCREENSHOTS}/api-editor-mobile.png`});
    // Complex response schemas come from the global source, not a second JSON editor.
    const legacy=JSON.parse(source);
    legacy.openapi='3.0.3';
    const complex={oneOf:[{type:'string',pattern:'^dev-'},{type:'integer',minimum:1}],
      'x-device-format':{preserve:true}};
    legacy.paths['/items'].get.responses['200'].content['application/json'].schema=complex;
    const legacySource=JSON.stringify(legacy,null,2);
    await reset(legacySource);await tab('响应');
    const media=response().getByRole('group',{name:'application/json',exact:true});
    await media.waitFor();await noExampleUI();
    assert.equal(await media.getByText('高级 schema · application/json',{exact:true}).count(),0);
    assert.equal(await media.getByLabel('application/json schema',{exact:true}).count(),0);
    assert.equal(await page.locator('#source').textContent(),legacySource,'Opening the form must not rewrite complex source');
    await response().getByLabel('响应说明',{exact:true}).fill('Legacy device result');
    const roundtrip=await page.locator('#source').textContent();
    legacy.paths['/items'].get.responses['200'].description='Legacy device result';
    assert.deepEqual(parse(roundtrip),legacy,'Editing a sibling preserves dialect, union, constraints and extension');
    await reset(roundtrip);await tab('响应');
    assert.equal(await response().getByLabel('响应说明',{exact:true}).inputValue(),'Legacy device result');
    assert.equal(await page.locator('#source').textContent(),roundtrip);
    assert.ok(await page.locator('#save').isEnabled());
    await media.getByLabel('根结构结构 1 说明',{exact:true}).fill('Editable union branch');
    const editedUnion=await saved();
    assert.deepEqual(editedUnion.paths['/items'].get.responses['200'].content['application/json'].schema,
      {...complex,oneOf:[{...complex.oneOf[0],description:'Editable union branch'},complex.oneOf[1]]});
    await reset(JSON.stringify(editedUnion));await tab('响应');
    assert.equal(await media.getByLabel('根结构结构 1 说明',{exact:true}).inputValue(),'Editable union branch');
    const pathSource=JSON.stringify({openapi:'3.1.0',info:{title:'Paths',version:'1'},paths:{'/users/{id}':{get:{responses:{'200':{description:'OK'}}}}}});
    await reset(pathSource);await tab('Path');
    assert.equal(await page.locator('#source').textContent(),pathSource);
    assert.equal(await page.evaluate(()=>window.validityEvents.includes(false)),false);
    assert.match(await page.getByRole('tabpanel',{name:'Path',exact:true}).textContent(),/id.*待补齐/);
    await page.getByRole('button',{name:'补齐路径参数'}).click();
    assert.equal(await page.getByRole('tabpanel',{name:'Path',exact:true}).getByLabel('参数名称',{exact:true}).getAttribute('readonly'),'');
    assert.deepEqual((await saved()).paths['/users/{id}'].get.parameters,[{name:'id',in:'path',required:true,schema:{type:'string'}}]);
    await page.getByLabel('请求路径',{exact:true}).fill('/users/{id}/files/{file}');
    await page.getByLabel('请求路径',{exact:true}).blur();
    assert.equal((await saved()).paths['/users/{id}/files/{file}'].get.parameters[1].name,'file');
    await page.getByLabel('请求路径',{exact:true}).fill('/users/{other}');
    await page.getByLabel('请求路径',{exact:true}).blur();
    assert.match(await page.locator('.api-editor').textContent(),/不会自动丢弃/);
    assert.equal(await page.locator('#save').isDisabled(),true);
    // Merely opening or re-focusing a route never materializes missing parameters.
    await reset(pathSource);
    const route=page.getByLabel('请求路径',{exact:true});
    for(let i=0;i<2;i++){await route.focus();await route.blur();}
    assert.equal(await page.locator('#source').textContent(),pathSource);
    assert.equal(await page.evaluate(()=>window.validityEvents.includes(false)),false);
    await tab('响应');
    await route.fill('/users/{id}/files/{');
    assert.equal(await page.locator('#source').textContent(),pathSource,'Typing is buffered');
    await route.blur();
    assert.equal(await route.inputValue(),'/users/{id}/files/{');
    assert.equal(await page.locator('#source').textContent(),pathSource,'Incomplete routes do not modify source');
    assert.equal(await page.locator('#save').isDisabled(),true);
    await page.getByLabel('接口名称（summary）').fill('Edited while route incomplete');
    assert.equal(await route.inputValue(),'/users/{id}/files/{','Other edits preserve the route buffer');
    await route.fill('/users/{id}/files/{file}');
    assert.equal((await saved()).paths['/users/{id}'].get.parameters,undefined);
    await route.blur();
    assert.equal(await page.getByRole('tab',{name:'参数',exact:true}).getAttribute('aria-selected'),'true');
    assert.equal(await page.getByRole('tab',{name:'Path',exact:true}).getAttribute('aria-selected'),'true');
    assert.deepEqual((await saved()).paths['/users/{id}/files/{file}'].get.parameters.map(p=>[p.name,p.in,p.required]),
      [['id','path',true],['file','path',true]]);
    assert.equal((await saved()).paths['/users/{id}/files/{file}'].get.summary,'Edited while route incomplete');
    const committed=await page.locator('#source').textContent();
    await route.focus();await route.blur();
    assert.equal(await page.locator('#source').textContent(),committed);
    assert.equal(await page.locator('#save').isEnabled(),true);

    // A pending address blocks save without requiring a JSON editor.
    const buffered=JSON.parse(source);delete buffered.paths['/items'].post;
    await reset(JSON.stringify(buffered));await tab('请求体');
    const beforeRoute=await page.locator('#source').textContent();
    await route.fill('/items/{');
    assert.ok(await page.locator('#save').isDisabled());
    await tab('响应');
    assert.equal(await route.inputValue(),'/items/{');
    assert.equal(await page.locator('#source').textContent(),beforeRoute);
    await route.fill('/items/{id}');await route.blur();
    assert.equal(await page.getByRole('tab',{name:'Path',exact:true}).getAttribute('aria-selected'),'true');
    assert.deepEqual((await saved()).paths['/items/{id}'].get.responses['200'].content['application/json'].example,{id:1});
    await noExampleUI();

    const inherited={openapi:'3.1.0',info:{title:'Inherited',version:'1'},
      components:{parameters:{id:{name:'id',in:'path',required:true,schema:{type:'integer'}}}},
      paths:{'/users/{id}':{parameters:[{$ref:'#/components/parameters/id'}],get:{responses:{'200':{description:'OK'}}}}}};
    await reset(JSON.stringify(inherited));
    await route.fill('/users/{id}/files/{file}');await route.blur();
    const moved=(await saved()).paths['/users/{id}/files/{file}'];
    assert.deepEqual(moved.parameters,inherited.paths['/users/{id}'].parameters);
    assert.deepEqual(moved.get.parameters,[{name:'file',in:'path',required:true,schema:{type:'string'}}]);
    for(const fixture of [
      {...inherited,components:{parameters:{id:{...inherited.components.parameters.id,required:false}}}},
      {...inherited,components:{}},
    ]) {
      const original=JSON.stringify(fixture);await reset(original);
      await route.fill('/users/{id}/files/{file}');await route.blur();
      assert.equal(await page.locator('#source').textContent(),original,'Inherited/ref conflicts are atomic');
      assert.equal(await route.inputValue(),'/users/{id}/files/{file}');
      assert.equal(await page.locator('#save').isDisabled(),true);
      assert.match(await page.locator('.api-editor-route').textContent(),/继承或引用|未解析引用/);
    }
    const referenced=JSON.stringify({openapi:'3.1.0',info:{title:'Referenced API',version:'1'},
      paths:{'/items':{$ref:'#/components/pathItems/items'}},
      components:{pathItems:{items:{get:{responses:{'200':{description:'OK'}}}}}}});
    await reset(referenced);
    assert.match(await page.locator('.api-editor').textContent(),/源码/);
    assert.equal(await page.locator('#source').textContent(),referenced);
    assert.equal(await page.locator('#save').isEnabled(),true);
    assert.equal(await page.evaluate(()=>window.validityEvents.includes(false)),false);
    // A response can be removed from its status tab even before it has content.
    await reset(source);await tab('响应');
    const responseTabs=page.getByRole('tablist',{name:'响应状态码',exact:true});
    await page.getByLabel('新增响应',{exact:true}).click();
    await page.getByLabel('新增响应状态码').fill('201');
    await page.getByRole('button',{name:'添加响应',exact:true}).click();
    const beforeDelete=(await saved()).paths['/items'].get.responses['200'];
    await responseTabs.getByRole('button',{name:'删除响应 201',exact:true}).click();
    assert.equal(await page.getByRole('tab',{name:'201',exact:true}).count(),0);
    assert.equal(await page.getByRole('tab',{name:'200',exact:true}).getAttribute('aria-selected'),'true');
    assert.deepEqual((await saved()).paths['/items'].get.responses,{'200':beforeDelete});
    const pendingDelete=response().getByRole('group',{name:'application/json',exact:true}).getByLabel('字段名称：id',{exact:true});
    await pendingDelete.fill(' ');
    assert.ok(await page.locator('#save').isDisabled());
    assert.ok(await responseTabs.getByRole('button',{name:'删除响应 200',exact:true}).isDisabled());
    await pendingDelete.fill('id');await pendingDelete.blur();
    assert.ok(await page.locator('#save').isEnabled());
    await responseTabs.getByRole('button',{name:'删除响应 200',exact:true}).click();
    assert.deepEqual((await saved()).paths['/items'].get.responses,{});
    await page.getByLabel('新增响应',{exact:true}).click();
    await page.getByLabel('新增响应状态码').fill('200');
    await page.getByRole('button',{name:'添加响应',exact:true}).click();
    assert.ok(await response().isVisible());
    await noExampleUI();
    // Moving a route/method must not remount and discard an invalid parameter draft.
    const basic={openapi:'3.1.0',info:{title:'Basic regressions',version:'1'},paths:{'/basic':{get:{
      parameters:[{name:'filter',in:'query',schema:{type:'object',properties:{id:{type:'string'},name:{type:'string'}}}}],
      responses:{'200':{description:'OK'}}
    }}}};
    await reset(JSON.stringify(basic));
    await page.getByRole('button',{name:'展开参数结构',exact:true}).click();
    const nestedName=page.getByLabel('字段名称：id',{exact:true});
    await nestedName.fill('name');
    const beforeMove=await page.locator('#source').textContent();
    await route.fill('/renamed');await route.blur();
    assert.equal(await page.locator('#source').textContent(),beforeMove,'Route edits cannot discard an invalid parameter buffer');
    assert.equal(await nestedName.inputValue(),'name');
    assert.ok(await page.locator('#save').isDisabled());
    await page.getByLabel('HTTP 方法').selectOption('post');
    await page.getByLabel('HTTP 方法').blur();
    assert.equal(await page.locator('#source').textContent(),beforeMove,'Method edits cannot discard an invalid parameter buffer');
    await nestedName.fill('itemId');await nestedName.blur();
    await route.focus();await route.blur();
    assert.equal((await saved()).paths['/renamed'].post.parameters[0].schema.properties.itemId.type,'string');
    assert.ok(await page.locator('#save').isEnabled());

    // Real pointer input, not locator.click(): disabled buttons may suppress focus/blur.
    await reset(JSON.stringify(basic));
    await route.fill('/saved-by-click');
    assert.ok(await page.locator('#save').isDisabled());
    const clickSave=async()=>{await page.locator('#save').scrollIntoViewIfNeeded();const box=await page.locator('#save').boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);};
    await clickSave();
    assert.equal(await page.evaluate(()=>window.savedSources.length),1,'One click flushes a complete route before saving');
    assert.ok(parse(await page.evaluate(()=>window.savedSources[0])).paths['/saved-by-click']);
    await route.fill('/invalid/{');await clickSave();
    assert.equal(await page.evaluate(()=>window.savedSources.length),1,'An invalid route cannot be saved by pointer');
    assert.equal(await route.inputValue(),'/invalid/{');
    assert.ok(await page.locator('#save').isDisabled());
    await route.fill('/enter-commit');await route.press('Enter');
    assert.ok((await saved()).paths['/enter-commit']);assert.ok(await page.locator('#save').isEnabled());

    // Deleting an earlier row must preserve the later parameter's own disclosure identity.
    const rows=structuredClone(basic);
    rows.paths['/basic'].get.parameters.unshift({name:'first',in:'query',schema:{type:'string'}});
    await reset(JSON.stringify(rows));
    await page.getByRole('button',{name:'展开参数结构',exact:true}).click();
    await page.getByRole('button',{name:'删除参数 first',exact:true}).click();
    assert.ok(await page.getByLabel('字段名称：id',{exact:true}).isVisible(),'Later row stays expanded after deleting its predecessor');
    await page.getByLabel('字段名称：id',{exact:true}).fill('renamed');
    await page.getByLabel('字段名称：id',{exact:true}).blur();
    assert.equal((await saved()).paths['/basic'].get.parameters[0].schema.properties.renamed.type,'string');
    await page.getByRole('button',{name:'添加参数',exact:true}).click();
    await page.getByLabel('字段名称：renamed',{exact:true}).fill('name');
    assert.ok(await page.getByRole('button',{name:'删除参数 parameter',exact:true}).isDisabled(),'Other row deletion cannot erase an invalid subtree');
    await tab('Header');await tab('Query');
    assert.equal(await page.getByLabel('字段名称：renamed',{exact:true}).inputValue(),'name');
    await page.getByLabel('字段名称：renamed',{exact:true}).fill('renamed');
    await page.getByLabel('字段名称：renamed',{exact:true}).blur();
    await page.getByRole('button',{name:'删除参数 parameter',exact:true}).click();
    assert.ok(await page.getByLabel('字段名称：renamed',{exact:true}).isVisible());

    // A preloaded error in a hidden Header panel is repairable without locking tabs.
    const headerFixture=structuredClone(basic);
    headerFixture.paths['/basic'].get.parameters=[
      {name:'shared',in:'query',schema:{type:'string'}},
      {name:'shared',in:'header',schema:{type:'string'}},
      {name:'shared',in:'header',schema:{type:'string'}},
    ];
    await reset(JSON.stringify(headerFixture));
    assert.ok(await page.locator('#save').isDisabled());
    await tab('Header');
    await page.getByRole('tabpanel',{name:'Header',exact:true}).getByLabel('参数名称',{exact:true}).nth(1).fill('X-Other');
    assert.ok(await page.locator('#save').isEnabled(),'Same name in different locations is valid');
    await page.getByRole('button',{name:'删除参数 X-Other',exact:true}).click();
    assert.equal((await saved()).paths['/basic'].get.parameters.length,2);

    // Duplicate Path entries must remain repairable even when their names are route-bound.
    const duplicatePath={openapi:'3.1.0',info:{title:'Duplicate path',version:'1'},paths:{'/basic/{id}/{other}':{get:{
      parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}},{name:'id',in:'path',required:true,schema:{type:'integer'}}],
      responses:{'200':{description:'OK'}}
    }}}};
    await reset(JSON.stringify(duplicatePath));
    assert.ok(await page.locator('#save').isDisabled());await tab('Path');
    const duplicate=page.getByRole('tabpanel',{name:'Path',exact:true}).getByLabel('参数名称',{exact:true}).nth(1);
    assert.ok(await duplicate.isEditable(),'A duplicate route-bound name must not be locked against repair');
    await duplicate.fill('other');
    assert.ok(await page.locator('#save').isEnabled());
    assert.equal(await duplicate.getAttribute('readonly'),'');
    assert.deepEqual((await saved()).paths['/basic/{id}/{other}'].get.parameters.map(p=>p.name),['id','other']);

    // Request bodies, like responses, support deletion and recreation, but not while drafts are invalid.
    await reset(JSON.stringify(basic));await tab('请求体');
    await page.getByRole('button',{name:'添加请求体',exact:true}).click();
    const deleteBody=body().locator('.api-editor-section-meta').getByRole('button',{name:'删除请求体',exact:true});
    assert.equal(await deleteBody.textContent(),'×');
    assert.equal(await deleteBody.getAttribute('title'),'删除请求体');
    assert.ok((await deleteBody.getAttribute('class')).split(' ').includes('cp-icon'));
    await addField(body(),'payload');
    await body().getByLabel('请求体必填',{exact:true}).check();
    await body().getByLabel('字段名称：payload',{exact:true}).fill(' ');
    assert.ok(await page.locator('#save').isDisabled());
    assert.ok(await page.getByRole('button',{name:'删除请求体',exact:true}).isDisabled());
    await tab('响应');await tab('请求体');
    assert.equal(await body().getByLabel('字段名称：payload',{exact:true}).inputValue(),' ');
    await body().getByLabel('字段名称：payload',{exact:true}).fill('payload');
    await body().getByLabel('字段名称：payload',{exact:true}).blur();
    await page.getByRole('button',{name:'删除请求体',exact:true}).click();
    assert.equal((await saved()).paths['/basic'].get.requestBody,undefined);
    assert.deepEqual((await saved()).paths['/basic'].get.responses,basic.paths['/basic'].get.responses);
    await page.getByRole('button',{name:'添加请求体',exact:true}).click();
    assert.deepEqual((await saved()).paths['/basic'].get.requestBody,{required:false,content:{'application/json':{schema:{type:'object'}}}});
    assert.ok(await page.locator('#save').isEnabled());await noExampleUI();
    const connected=JSON.parse(source);
    connected.servers=[{url:'https://original.example',description:'Production','x-keep':true}];
    connected.components={securitySchemes:{Authorization:{type:'apiKey',in:'header',name:'Authorization',description:'Partner key'}}};
    connected.paths['/items'].get.security=[{Authorization:[]}];
    connected.paths['/items'].post.security=[{Authorization:[]}];
    await reset(JSON.stringify(connected));await tab('服务与鉴权');
    assert.equal(await page.getByLabel('服务地址 1',{exact:true}).inputValue(),'https://original.example');
    assert.equal(await page.getByLabel('鉴权方式',{exact:true}).inputValue(),'apiKey');
    assert.equal(await page.getByLabel('鉴权参数名',{exact:true}).inputValue(),'Authorization');
    await page.getByLabel('服务地址 1',{exact:true}).fill('javascript:bad');
    await page.getByLabel('服务地址 1',{exact:true}).press('Tab');
    assert.ok(await page.locator('#save').isDisabled());
    assert.equal((await saved()).paths['/items'].get.servers,undefined);
    await page.getByLabel('服务地址 1',{exact:true}).fill('https://partner.example/v2');
    await page.getByLabel('服务地址 1',{exact:true}).press('Tab');
    await page.getByLabel('鉴权参数名',{exact:true}).fill('X-Partner-Key');
    await page.getByLabel('鉴权参数名',{exact:true}).press('Tab');
    await page.getByLabel('鉴权参数位置',{exact:true}).selectOption('query');
    const connection=await saved(),schemeKey=Object.keys(connection.paths['/items'].get.security[0])[0];
    assert.deepEqual(connection.paths['/items'].get.servers,[{...connected.servers[0],url:'https://partner.example/v2'}]);
    assert.deepEqual(connection.servers,connected.servers);
    assert.deepEqual(connection.paths['/items'].post,connected.paths['/items'].post);
    assert.deepEqual(connection.components.securitySchemes.Authorization,connected.components.securitySchemes.Authorization);
    assert.deepEqual(connection.components.securitySchemes[schemeKey],{type:'apiKey',in:'query',name:'X-Partner-Key',description:'Partner key'});
    assert.ok(await page.locator('#save').isEnabled());
    await page.locator('#save').click();
    const stored=await page.evaluate(()=>window.savedSources.at(-1));
    await reset(stored);await tab('服务与鉴权');
    assert.equal(await page.getByLabel('服务地址 1',{exact:true}).inputValue(),'https://partner.example/v2');
    assert.equal(await page.getByLabel('鉴权参数名',{exact:true}).inputValue(),'X-Partner-Key');
    await page.getByLabel('鉴权方式',{exact:true}).selectOption('bearer');
    await page.getByLabel('Token 格式',{exact:true}).fill('JWT');await page.getByLabel('Token 格式',{exact:true}).press('Tab');
    assert.deepEqual((await saved()).components.securitySchemes[schemeKey],{type:'http',scheme:'bearer',bearerFormat:'JWT'});
    await page.getByLabel('鉴权方式',{exact:true}).selectOption('none');
    assert.deepEqual((await saved()).paths['/items'].get.security,[]);
    await page.getByLabel('鉴权方式',{exact:true}).selectOption('inherit');
    assert.equal(Object.hasOwn((await saved()).paths['/items'].get,'security'),false);
    await page.getByRole('button',{name:'恢复继承',exact:true}).click();
    assert.equal(Object.hasOwn((await saved()).paths['/items'].get,'servers'),false);
    assert.ok(await page.locator('.api-editor').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await reset('openapi: [invalid');
    assert.equal(await page.locator('#source').textContent(),'openapi: [invalid');
    assert.equal(await page.locator('#save').isEnabled(),true);
    assert.equal(await page.evaluate(()=>window.validityEvents.includes(false)),false);
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
