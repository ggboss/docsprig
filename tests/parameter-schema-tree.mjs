import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test('controlled recursive parameter schema editing', async t => {
  const server = await createServer({configFile: false, root: new URL('../', import.meta.url).pathname,
    plugins: [{name: 'fixture-disclosure-prop', transformIndexHtml: {order: 'pre', handler: html =>
      html.replace('schema, disabled, onValidityChange:', 'schema, disabled, rootDisclosure: window.rootDisclosure, onValidityChange:')}}],
    oxc: {jsx: {runtime: 'automatic'}}, server: {host: '127.0.0.1', port: 0}, logLevel: 'error'});
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({channel: process.env.SMOKE_BROWSER_CHANNEL || undefined});
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/parameter-schema-tree.html`);
  const ref = {$ref: '#/components/schemas/T', 'x-note': false};
  const items = {type: 'object', required: ['field', 'unlisted'], properties: {nested: {type: 'array'}, ref: {type: 'string'}, field: false}};
  const initial = {type: 'array', 'x-root': 0, items: {type: 'array', items}};
  await page.evaluate(s => window.show(s), initial);
  const control = label => page.getByLabel(label, {exact: true});
  // Use JSON transport so arbitrary property names survive the browser bridge.
  const value = async () => JSON.parse(await page.evaluate(() => JSON.stringify(window.value)));
  await control('添加字段').click();
  const name = control('字段名称：field1');
  await name.fill('ref'); await name.press('Enter');
  assert.equal(await name.getAttribute('aria-invalid'), 'true');
  await name.press('Tab');
  const save = page.getByRole('button', {name: '保存'});
  assert.ok(await save.isDisabled());
  const disclosure = text => page.getByText(text, {exact: true});
  const object = disclosure('每一项：对象（4 个字段）');
  const outer = disclosure('根结构：数组（元素：数组）');
  const middle = disclosure('每一项：数组（元素：对象）');
  const beforeFold = await page.evaluate(() => window.calls);
  await object.click();
  assert.ok(await name.isHidden());
  assert.ok(await save.isDisabled());
  await middle.focus(); await middle.press('Enter');
  await outer.click(); await outer.click();
  assert.ok(await object.isHidden(), 'reopening root keeps the inner array collapsed');
  await middle.click();
  assert.ok(await name.isHidden(), 'reopening array keeps its item object collapsed');
  await object.click();
  assert.equal(await name.inputValue(), 'ref');
  assert.equal(await name.getAttribute('aria-invalid'), 'true');
  assert.ok(await save.isDisabled());
  assert.equal(await page.evaluate(() => window.calls), beforeFold);
  const other = control('字段名称：ref');
  await other.fill(' '); await other.press('Tab');
  await name.focus(); await name.press('Escape');
  assert.ok(await save.isDisabled(), 'another invalid draft still blocks save');
  await other.focus(); await other.press('Escape');
  assert.ok(await save.isEnabled());
  await name.fill('__proto__'); await name.press('Enter');
  await control('字段类型：__proto__').selectOption('integer');
  await control('必填：__proto__').check();
  await control('数组元素类型').last().selectOption('object');
  await control('添加字段').first().click();
  const deep = disclosure('每一项：对象（1 个字段）');
  await deep.click();
  assert.ok(await control('字段名称：field').first().isHidden());
  assert.ok(await control('字段名称：field').last().isVisible());
  await deep.click();
  await control('字段名称：field').last().fill('flag');
  await control('字段名称：field').last().press('Tab');
  const expected = structuredClone(initial);
  const inner = expected.items.items;
  inner.properties.nested.items = {type: 'object', properties: {field: {type: 'string'}}};
  delete inner.properties.field;
  inner.properties.flag = false;
  Object.defineProperty(inner.properties, '__proto__', {value: {type: 'integer'}, enumerable: true});
  inner.required = ['flag', 'unlisted', '__proto__'];
  assert.deepEqual(await value(), expected);
  await control('删除字段：flag').click();
  delete inner.properties.flag; inner.required.shift();
  assert.deepEqual(await value(), expected);
  await page.evaluate(() => window.show(window.value, true));
  assert.ok(await control('字段类型：nested').isDisabled());
  assert.ok(await control('删除字段：ref').isDisabled());
  assert.ok(await control('字段类型：ref').isDisabled());
  const source = { type: 'array', items: {type: 'object', properties: {ref}, required: ['ref'], description: 'keep me', 'x-keep': 1} };
  await page.evaluate(s => window.show(s), source);
  const select = control('数组元素类型');
  let prompt;
  page.once('dialog', dialog => { prompt = dialog.message(); return dialog.dismiss(); });
  await select.selectOption('array');
  assert.match(prompt, /「数组」.*对象子字段、必填字段设置/);
  assert.deepEqual(await value(), source);
  assert.equal(await select.inputValue(), 'object');
  page.once('dialog', dialog => dialog.accept());
  await select.selectOption('array');
  assert.deepEqual(await value(), {type: 'array', items: {type: 'array', items: {type: 'string'}, description: 'keep me', 'x-keep': 1}});
  const beforeOpen = await page.evaluate(() => window.calls);
  await page.evaluate(() => window.show({type: 'array'}));
  assert.deepEqual(await value(), {type: 'array'});
  assert.equal(await page.evaluate(() => window.calls), beforeOpen);
  const priorItems = {type: 'integer', minimum: 2};
  await page.evaluate(items => window.show({type: 'object', properties: {list: {type: 'string', items, maxLength: 10}}}), priorItems);
  const listType = control('字段类型：list');
  page.once('dialog', dialog => { prompt = dialog.message(); return dialog.accept(); });
  await listType.selectOption('array');
  assert.match(prompt, /「数组」.*文本长度范围约束/);
  assert.deepEqual((await value()).properties.list, {type: 'array', items: priorItems});
  page.once('dialog', dialog => { prompt = dialog.message(); return dialog.dismiss(); });
  await listType.selectOption('boolean');
  assert.match(prompt, /「布尔」.*数组元素定义/);
  assert.equal(await listType.inputValue(), 'array');
  for (const protection of [
    {dependentRequired: {trigger: ['target']}}, {dependencies: {trigger: ['target']}},
    {dependentSchemas: {trigger: {required: ['target']}}},
    {$defs: {deep: {allOf: [{$ref: '#/properties/target'}]}}},
  ]) {
    const schema = {type: 'object', properties: {target: {type: 'integer'}, trigger: {type: 'boolean'}}, ...protection};
    await page.evaluate(s => window.show(s), schema);
    assert.ok(!await control('字段名称：target').isEditable());
    assert.ok(await control('删除字段：target').isDisabled());
    await control('字段说明：target').fill('仍可编辑说明');
    schema.properties.target.description = '仍可编辑说明';
    assert.deepEqual(await value(), schema);
  }
  await t.test('literal $ref data and property names do not lock structural edits', async () => {
    const literal = {$ref: '#/properties/target'};
    const metadata = {example: literal, examples: [literal], default: literal, const: literal, enum: [literal], 'x-ui': {items: literal}};
    const field = {type: 'string', description: '普通字段'};
    const schema = {type: 'object', ...metadata, properties: {$ref: field, target: {type: 'integer'}}, required: ['$ref']};
    await page.evaluate(s => window.show(s), schema);
    assert.ok(await control('字段名称：$ref').isEditable());
    assert.ok(await control('删除字段：$ref').isEnabled());
    await control('字段名称：$ref').fill('literalRef');
    await control('字段名称：$ref').press('Enter');
    await control('删除字段：target').click();
    assert.deepEqual(await value(), {...schema, properties: {literalRef: field}, required: ['literalRef']});
  });

  await t.test('real references reached through schema positions still protect sibling fields', async () => {
    const pointer = {$ref: '#/properties/target'};
    for (const linked of [pointer, {type: 'array', items: pointer}, {type: 'object', additionalProperties: pointer}, {anyOf: [pointer]}]) {
      // Even a field named "$ref" may have a real reference *inside its schema*.
      const schema = {type: 'object', properties: {target: {type: 'integer'}, $ref: linked}};
      await page.evaluate(s => window.show(s), schema);
      assert.equal(await control('字段名称：target').isEditable(), false);
      assert.ok(await control('删除字段：target').isDisabled());
      assert.ok(await control('字段说明：target').isEditable());
      assert.deepEqual(await value(), schema);
    }
  });
  await t.test('type changes preserve compatible constraints and confirm all losses exactly once', async () => {
    const metadata = {description: '数量', deprecated: true, 'x-ui': {tags: ['keep']}};
    const initialItem = {type: 'integer', ...metadata, minimum: 0, nullable: true, enum: [0, null], default: 0, const: null};
    const showItem = items => page.evaluate(items => window.show({type: 'array', items}), items);
    const calls = () => page.evaluate(() => window.calls);
    const dialogs = [];
    let accept = false;
    const answer = dialog => { dialogs.push(dialog.message()); return accept ? dialog.accept() : dialog.dismiss(); };
    page.on('dialog', answer);
    try {
      await showItem(initialItem);
      const start = await calls();
      assert.ok(await select.isEnabled());
      await select.selectOption('integer');
      assert.equal(await calls(), start, 'same type must not dirty the schema');
      await select.selectOption('number');
      const widened = {...initialItem, type: 'number'};
      assert.deepEqual(await value(), {type: 'array', items: widened});
      assert.equal(dialogs.length, 0, 'widening and nullable nulls are lossless');
      const beforeCancel = await calls();
      await select.selectOption('string');
      assert.equal(dialogs.length, 1);
      assert.equal(await select.inputValue(), 'number');
      assert.equal(await calls(), beforeCancel);
      assert.deepEqual(await value(), {type: 'array', items: widened});
      accept = true;
      await select.selectOption('string');
      assert.equal(dialogs.length, 2, 'one prompt per attempted destructive switch');
      assert.equal(await calls(), beforeCancel + 1);
      assert.deepEqual(await value(), {type: 'array', items: {type: 'string', ...metadata, nullable: true, const: null}});
      // A fractional const is incompatible with integer; enum and default are compatible.
      await showItem({type: 'number', enum: [0, 1], default: 0, const: 1.5, ...metadata});
      await select.selectOption('integer');
      assert.equal(dialogs.length, 3);
      assert.deepEqual(await value(), {type: 'array', items: {type: 'integer', enum: [0, 1], default: 0, ...metadata}});
    } finally { page.off('dialog', answer); }
  });

  await t.test('one pointer click after a rename still operates on that row', async () => {
    const root = {type: 'object', 'x-root': {v: 1}, properties: {untouched: {type: 'boolean', default: false}}};
    await page.evaluate(s => window.show(s), root);
    // Click physical coordinates once: no locator retry after blur, synthetic change, or refocus.
    async function clickOnce(target) {
      await target.scrollIntoViewIfNeeded();
      const b = await target.boundingBox();
      assert.ok(b);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    }
    const rename = (from, to) => control(`字段名称：${from}`).fill(to);
    for (let n = 0; n < 3; n++) await control('添加字段').click();
    await rename('field', 'first');
    await clickOnce(control('必填：field'));
    assert.deepEqual((await value()).required, ['first']);
    await rename('field1', 'list');
    await clickOnce(control('字段说明：field1'));
    await page.keyboard.insertText('保留字段说明');
    assert.equal((await value()).properties.list.description, '保留字段说明');
    await rename('list', 'rows');
    await clickOnce(control('字段类型：list'));
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '字段类型：rows');
    assert.ok(await control('字段类型：rows').evaluate(el => el.matches(':open')), 'one click opens the native picker');
    // The native popup itself is outside Playwright’s DOM; select only after verifying it opened.
    await page.keyboard.press('Escape');
    await control('字段类型：rows').selectOption('array');
    assert.deepEqual((await value()).properties.rows, {type: 'array', items: {type: 'string'}, description: '保留字段说明'});
    await select.selectOption('object');
    const nested = page.getByText('每一项：对象（0 个字段）', {exact: true}).locator('..');
    await nested.getByLabel('添加字段', {exact: true}).click();
    await rename('field', 'id'); await clickOnce(control('必填：field'));
    await rename('field2', 'discard'); await clickOnce(control('删除字段：field2'));
    await control('删除字段：first').click();
    assert.deepEqual(await value(), {...root, properties: {...root.properties, rows: {
      type: 'array', description: '保留字段说明', items: {type: 'object', required: ['id'], properties: {id: {type: 'string'}}},
    }}});
  });
  await page.evaluate(() => {
    window.rootDisclosure = false;
    window.show({type: 'object', properties: {list: {type: 'array', items: {type: 'object'}}}});
  });
  const summaries = page.locator('.parameter-schema-tree summary');
  assert.deepEqual(await summaries.allTextContents(), ['list：数组（元素：对象）', '每一项：对象（0 个字段）']);
  await summaries.first().click();
  assert.ok(await control('数组元素类型').isHidden());
  await page.evaluate(() => { delete window.rootDisclosure; });
  await t.test('nullable and union response fields remain editable without losing branches', async () => {
    const response = {type:'object', properties:{
      data:{description:'Return data', anyOf:[
        {type:'object',properties:{token:{type:'string'}},required:['token']},
        {type:'null'},
        {type:'object',additionalProperties:{type:'string'},description:'Error fields'},
      ], 'x-preserve':true},
      errorData:{type:['object','null'],description:'Error detail', 'x-preserve':false},
    }};
    await page.evaluate(s=>window.show(s),response);
    assert.deepEqual(await value(),response,'Opening must not rewrite the schema');
    assert.equal(await page.getByText('自定义',{exact:true}).count(),0);
    assert.equal(await control('字段说明：data').inputValue(),'Return data');
    assert.match(await control('字段类型：errorData').textContent(),/可为空/);
    await control('字段说明：errorData').fill('Updated error detail');
    await control('字段类型：errorData').selectOption('array');
    let result=await value();
    assert.deepEqual(result.properties.errorData,{type:['array','null'],description:'Updated error detail','x-preserve':false,items:{type:'string'}});
    await control('字段名称：token').fill('accessToken');await control('字段名称：token').press('Tab');
    await control('字段说明：accessToken').fill('Access token');
    await control('data结构 3 说明').fill('Validation errors');
    result=await value();
    assert.deepEqual(result.properties.data.anyOf[0],{type:'object',properties:{accessToken:{type:'string',description:'Access token'}},required:['accessToken']});
    assert.deepEqual(result.properties.data.anyOf[1],{type:'null'});
    assert.deepEqual(result.properties.data.anyOf[2],{type:'object',additionalProperties:{type:'string'},description:'Validation errors'});
    assert.equal(result.properties.data['x-preserve'],true);
    await control('添加data结构').click();
    await control('data结构 4 类型').selectOption('boolean');
    page.once('dialog',dialog=>dialog.dismiss());await control('删除data结构 2').click();
    assert.equal((await value()).properties.data.anyOf.length,4);
    page.once('dialog',dialog=>dialog.accept());await control('删除data结构 2').click();
    assert.deepEqual((await value()).properties.data.anyOf.map(s=>s.type),['object','object','boolean']);
    for(const mode of ['oneOf','allOf']) {
      const union={[mode]:[{type:'string',pattern:'^keep'},{type:'integer',minimum:1}],description:'Mixed', 'x-preserve':0};
      await page.evaluate(s=>window.show(s),union);
      assert.deepEqual(await value(),union);
      await control('根结构结构 2 说明').fill('Count');
      assert.deepEqual(await value(),{...union,[mode]:[union[mode][0],{...union[mode][1],description:'Count'}]});
    }
  });
  const calls = await page.evaluate(() => window.calls);
  for (const schema of [ref, {type: 'array', items: [ref]}, {type: 'object', required: null}, true]) {
    await page.evaluate(s => window.show(s), schema);
    await page.locator('.parameter-schema-tree .pst-opaque').first().waitFor();
    assert.equal(await page.getByRole('combobox').count(), 0);
    assert.equal(await page.locator('fieldset').getByRole('button').count(), 0);
    assert.deepEqual(await value(), schema);
  }
  assert.equal(await page.evaluate(() => window.calls), calls);
});
