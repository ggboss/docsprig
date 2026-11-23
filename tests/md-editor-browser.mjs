import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { markdownSemantics } from '../src/md-editor-codec.mjs';

test('Markdown visual editing, source fallback and controlled roundtrips in Chromium', {timeout:120_000}, async t=>{
  const server=await createServer({configFile:false,root:new URL('../',import.meta.url).pathname,
    oxc:{jsx:{runtime:'automatic'}},server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await server.listen();t.after(()=>server.close());
  const browser=await chromium.launch({channel:process.env.SMOKE_BROWSER_CHANNEL || undefined});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  const errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1')&&!r.url().startsWith('data:'))external.push(r.url());});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/md-editor-fixture.html`);
  const visual=()=>page.getByRole('textbox',{name:'Markdown 可视化正文'});
  const state=()=>page.evaluate(()=>({value:window.mdHarness.value,calls:window.mdHarness.calls}));
  const replace=async value=>{await page.evaluate(value=>window.mdHarness.replace(value),value);await page.waitForFunction(value=>window.mdHarness.value===value,value);await page.evaluate(()=>new Promise(requestAnimationFrame));};
  const waitVisual=async()=>{await visual().waitFor();};
  await waitVisual();
  const initial=await state();
  assert.equal(initial.calls,0);assert.equal(initial.value,'# 标题\r\n\r\n原始 **粗体**。\r\n');
  await visual().click();await page.keyboard.press('ArrowRight');
  assert.equal((await state()).calls,0,'focus/selection never dirties source');

  const assertPopupBounds=async()=> {
    const box=await page.getByRole('dialog').boundingBox(), viewport=page.viewportSize();
    assert.ok(box && box.x>=0 && box.y>=0 && box.x+box.width<=viewport.width && box.y+box.height<=viewport.height,'popup remains inside viewport');
  };
  await t.test('focused nonblank canvas has no permanent editing toolbar',async()=>{
    const editor=page.locator('.md-editor');
    assert.equal(await editor.getByRole('toolbar').count(),0);
    assert.equal(await editor.getByRole('group',{name:'编辑辅助'}).count(),0);
    assert.deepEqual(await editor.getByRole('button').allTextContents(),[]);
  });

  await t.test('blank-line palette, keyboard search and cancellation',async()=>{
    assert.equal(await page.getByRole('button',{name:'粗体',exact:true}).count(),0);
    await replace('');await waitVisual();await visual().click();
    const before=await state();
    await page.getByRole('button',{name:'在空行插入内容'}).click();
    const search=page.getByRole('combobox',{name:'搜索插入内容'});
    await search.waitFor();assert.equal(await search.evaluate(el=>el===document.activeElement),true);
    await assertPopupBounds();
    await search.fill('不存在');
    assert.equal(await page.getByRole('option').count(),0);
    await page.keyboard.press('Enter');assert.deepEqual(await state(),before);
    await page.keyboard.press('Escape');assert.deepEqual(await state(),before);
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Markdown 可视化正文');
    await page.keyboard.type('/');
    await search.waitFor();await search.fill('标题');
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.keyboard.insertText('键盘标题');
    assert.equal((await state()).value,'## 键盘标题');
    await page.keyboard.press('Alt+Shift+i');
    await search.waitFor();await page.keyboard.press('Escape');
    await page.keyboard.type('/');
    assert.match((await state()).value,/键盘标题\/$/,'slash is literal on nonblank lines');
  });

  await t.test('selection formatting floats without stealing focus and dismisses with Escape',async()=>{
    await replace('Select this');await waitVisual();await visual().click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByRole('dialog',{name:'文字格式'}).waitFor();
    assert.equal(await visual().evaluate(el=>el===document.activeElement),true);
    await assertPopupBounds();
    if(process.env.MD_EDITOR_SCREENSHOT) await page.screenshot({path:process.env.MD_EDITOR_SCREENSHOT.replace('.png','-selection.png')});
    await page.getByRole('button',{name:'粗体',exact:true}).click();
    assert.equal((await state()).value,'**Select this**');
    assert.equal(await page.evaluate(()=>window.getSelection().toString()),'Select this');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(),0);
  });

  await t.test('palette inserts code and table with contextual table operations',async()=>{
    await replace('');await waitVisual();await visual().click();
    await page.keyboard.type('/');
    await page.getByRole('combobox',{name:'搜索插入内容'}).fill('代码');
    await page.keyboard.press('Enter');await page.keyboard.insertText('const x = 1;');
    assert.equal(await visual().locator('pre').innerText(),'const x = 1;');
    await replace('');await waitVisual();await visual().click();
    await page.getByRole('button',{name:'在空行插入内容'}).click();
    await page.getByRole('option',{name:'表格',exact:true}).click();
    assert.equal(await visual().locator('tr').count(),3);
    await page.keyboard.press('Alt+Shift+f');
    await page.getByRole('button',{name:'下方插入行'}).click();
    assert.equal(await visual().locator('tr').count(),4);
    await page.keyboard.press('Escape');
  });

  await t.test('mobile non-selection controls offer keyboard and touch-sized fallbacks',async()=>{
    await page.setViewportSize({width:390,height:844});
    await replace('Mobile');await waitVisual();await visual().click();
    await page.keyboard.press('Alt+Shift+f');
    const select=page.getByRole('combobox',{name:'段落格式'});
    assert.equal(await select.evaluate(el=>el===document.activeElement),true);
    await assertPopupBounds();
    await select.selectOption('h2');
    assert.equal((await state()).value,'## Mobile');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Alt+Shift+i');
    await assertPopupBounds();
    assert.ok((await page.getByRole('option',{name:'图片',exact:true}).boundingBox()).height>=44);
    if(process.env.MD_EDITOR_SCREENSHOT) await page.screenshot({path:process.env.MD_EDITOR_SCREENSHOT.replace('.png','-palette-mobile.png')});
    await page.locator('h1').first().click();
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.setViewportSize({width:1280,height:720});
  });

  await t.test('empty list and quote insertion stays guarded and replaces selected labels',async()=>{
    for (const [name,expected] of [['无序列表','- 内容'],['有序列表','1. 内容'],['引用','> 内容']]) {
      await replace('');await waitVisual();await visual().click();
      await page.getByRole('button',{name:'在空行插入内容'}).click();
      await page.getByRole('option',{name,exact:true}).click();
      await page.keyboard.insertText('内容');
      assert.equal((await state()).value,expected);
    }
  });

  await t.test('touch users can insert from the blank-line plus without selecting text',async()=>{
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    try {
      const touch=await context.newPage();
      await touch.goto(page.url());
      const editor=touch.getByRole('textbox',{name:'Markdown 可视化正文'});
      await editor.waitFor();await touch.evaluate(()=>window.mdHarness.replace(''));
      await editor.tap();
      await touch.getByRole('button',{name:'在空行插入内容'}).tap();
      await touch.getByRole('combobox',{name:'搜索插入内容'}).fill('图片');
      await touch.getByRole('option',{name:'图片',exact:true}).tap();
      await touch.getByRole('textbox',{name:'图片地址'}).waitFor();
      await touch.getByRole('button',{name:'取消',exact:true}).tap();
      assert.equal(await touch.getByRole('dialog').count(),0);
      assert.equal(await touch.evaluate(()=>window.mdHarness.calls),0);
    } finally {await context.close();}
  });

  await t.test('ordinary typing, Enter, Chinese IME, formatting and keyboard undo/redo',async()=>{
    await replace('');await waitVisual();await visual().click();
    await page.keyboard.type('hello world');await page.keyboard.press('Enter');
    await page.keyboard.insertText('中文输入');
    assert.match((await state()).value,/hello world\n\n中文输入/);
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition',{text:'拼音',selectionStart:2,selectionEnd:2});
    await cdp.send('Input.insertText',{text:'输入法'});await cdp.detach();
    assert.match((await state()).value,/中文输入输入法/);
    await page.keyboard.press('Enter');await page.keyboard.type('third');
    const unformatted=(await state()).value;
    for (const _ of 'third') await page.keyboard.press('Shift+ArrowLeft');
    await page.getByRole('button',{name:'粗体',exact:true}).click();
    const formatted=(await state()).value;
    assert.equal(formatted,unformatted.replace(/third$/,'**third**'));
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal((await state()).value,unformatted);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    assert.equal((await state()).value,formatted);
    assert.ok(!(await page.locator('.md-editor-status').innerText()).includes('无法完整'));
  });

  await t.test('multi-line paste uses literal text and preserves separate lines',async()=>{
    await replace('start');await waitVisual();await visual().click();await page.keyboard.press('ControlOrMeta+End');
    await visual().evaluate(element=>{
      const data=new DataTransfer();data.setData('text/plain','第一行\n第二行\n\n**literal**');
      data.setData('text/html','<img src="https://should-not-load.invalid/a" onerror="alert(1)">');
      element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    });
    const source=(await state()).value;
    assert.match(source,/第一行/);assert.match(source,/第二行/);assert.match(source,/\\\*\\\*literal\\\*\\\*/);
    assert.equal(await visual().locator('img').count(),0);
  });

  await t.test('external values reset undo and parent source toggle does not dirty the document',async()=>{
    await replace('New document');await waitVisual();
    const before=await state();
    await visual().click();await page.keyboard.press('ControlOrMeta+z');
    assert.deepEqual(await state(),before);
    await page.getByRole('button',{name:'父级源码切换'}).click();
    assert.equal(await page.getByRole('textbox',{name:'父级源码',exact:true}).inputValue(),'New document');
    await page.getByRole('button',{name:'父级源码切换'}).click();await waitVisual();
    assert.deepEqual(await state(),before);
  });

  await t.test('source fallback is byte-preserving and remains editable',async()=>{
    const unsupported='---\r\ntitle: keep\r\n---\r\n\r\nText[^note]\r\n\r\n[^note]: reference\r\n';
    const before=(await state()).calls;await replace(unsupported);
    const fallback=page.getByRole('textbox',{name:'Markdown 源码（兼容模式）'});await fallback.waitFor();
    assert.equal((await state()).value,unsupported);assert.equal((await state()).calls,before);
    await fallback.fill(unsupported+'edited');assert.match((await state()).value,/edited$/);
    assert.equal(await visual().count(),0);
  });

  await t.test('editing the last paragraph preserves untouched original blocks byte-for-byte',async()=>{
    const prefix='Setext title\n============\n\n~~~js title="keep"\nconst n = 1;\n~~~\n\n*   item one\n*   item two\n\n';
    await replace(prefix+'Last paragraph.\n');await waitVisual();
    await visual().locator('p').last().click();await page.keyboard.press('End');await page.keyboard.insertText(' 中文修改');
    assert.equal((await state()).value,prefix+'Last paragraph. 中文修改\n');
    await page.keyboard.press('ControlOrMeta+z');assert.equal((await state()).value,prefix+'Last paragraph.\n');
  });

  await t.test('safe image URL and alt input create an inert preserved reference',async()=>{
    await replace('');await waitVisual();await visual().click();
    await page.getByRole('button',{name:'在空行插入内容'}).click();
    await page.getByRole('option',{name:'图片',exact:true}).click();
    await page.getByRole('textbox',{name:'图片地址'}).fill('javascript:alert(1)');
    await page.getByRole('button',{name:'插入图片'}).click();
    assert.equal((await state()).value,'');
    await page.getByRole('textbox',{name:'图片地址'}).fill('https://should-not-load.invalid/chart.png');
    await page.getByRole('textbox',{name:'替代文字'}).fill('图表中文替代文字');
    await page.getByRole('button',{name:'插入图片'}).click();
    assert.equal((await state()).value,'![图表中文替代文字](https://should-not-load.invalid/chart.png)');
    assert.equal(await visual().locator('[data-md-image]').count(),1);
    assert.equal(await visual().locator('img').count(),0);
  });

  await t.test('table, code, links, tasks and long prose retain semantics through edits',async()=>{
    const source=await readFile(new URL('./fixtures/long-markdown.zh-CN.md',import.meta.url),'utf8');
    await replace(source);await waitVisual();
    await visual().locator('table').waitFor();
    assert.equal(await visual().locator('table').count(),1);
    assert.equal(await visual().locator('pre').count(),3);
    if (process.env.MD_EDITOR_SCREENSHOT) await page.screenshot({path:process.env.MD_EDITOR_SCREENSHOT});
    await visual().locator('h2').first().evaluate(el=>{el.closest('[contenteditable]').focus();const range=document.createRange();range.setStart(el.firstChild,0);range.collapse(true);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);});await page.keyboard.insertText('更新：');
    const next=(await state()).value;
    assert.deepEqual(markdownSemantics(next),markdownSemantics(source.replace('## 社区声音','## 更新：社区声音')));
    await page.keyboard.press('ControlOrMeta+z');assert.equal((await state()).value,source);
    await replace('- [ ] 待办\n- [x] 已完成');await waitVisual();
    await visual().locator('input[type=checkbox]').first().check();
    assert.match((await state()).value,/- \[x\] 待办/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  });
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
