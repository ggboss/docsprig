import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectMarkdown, markdownSemantics, serializeMarkdown, safeLink, safeImageSource, preserveMarkdownBlocks } from '../src/md-editor-codec.mjs';

const supported = [
  '', '# 中文标题\r\n\r\n正文 **粗体** 和 *斜体*、~~删除线~~、`code`。\r\n',
  '一级标题\n===\n\n二级标题\n---\n\n正文\n软换行  \n硬换行',
  '- 第一项\n  - 嵌套\n- 第二项\n\n3. 有序起点\n4. 下一项',
  '- [ ] 待办\n- [x] 已完成\n  - [ ] 子任务',
  '> 引用\n>\n> - 嵌套列表\n> - 第二项',
  '```javascript title="样例"\nconst n = `hello`;\n```\n\n---',
  '````text\n```\n内含代码围栏\n```\n````',
  '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| `a` | **b** | c |',
  '[中文链接](../guide "保留标题")\n\n![图片](./badge.svg "图注")',
  '标点 \\*literal\\* &amp; &lt;tag&gt; 和 😀\n\n\n\n另一个段落',
];
for (const source of supported) test(`semantic roundtrip: ${JSON.stringify(source.slice(0,40))}`, () => {
  const result = inspectMarkdown(source);
  assert.equal(result.supported,true,result.reason);
  const serialized = serializeMarkdown(result.document);
  assert.equal(serialized.ok,true,serialized.reason);
  assert.deepEqual(markdownSemantics(serialized.markdown),markdownSemantics(source));
  assert.equal(inspectMarkdown(serialized.markdown).supported,true);
});

test('long Chinese fixture retains table alignment, code metadata, image references and prose', async () => {
  const source=await readFile(new URL('./fixtures/long-markdown.zh-CN.md',import.meta.url),'utf8');
  let current=source;
  for (let round=0;round<4;round++) {
    const read=inspectMarkdown(current);assert.equal(read.supported,true,read.reason);
    const write=serializeMarkdown(read.document);assert.equal(write.ok,true,write.reason);
    assert.deepEqual(markdownSemantics(write.markdown),markdownSemantics(source));current=write.markdown;
  }
});

test('unsupported source falls back before any normalization or HTML parsing', () => {
  for (const source of ['<script>alert(1)</script>','before <em>HTML</em> after','<!-- keep comment -->',
    '[label][ref]\n\n[ref]: /url "title"','![image][ref]\n\n[ref]: ./badge.svg',
    'text[^note]\n\n[^note]: footnote','---\ntitle: test\n---\n\nbody',
    '+++\ntitle = "test"\n+++',':::note\nkeep\n:::',
    '[click](javascript:alert(1))','[click](data:text/html,test)',
    'inline ![image](./badge.svg) here','a'.repeat(200001)]) {
    const result=inspectMarkdown(source);assert.equal(result.supported,false,source.slice(0,80));
    assert.equal(Object.hasOwn(result,'document'),false);
    assert.equal(Object.hasOwn(result,'markdown'),false);
  }
});

test('unrepresentable rich content cannot silently flatten into Markdown', () => {
  const table=inspectMarkdown('| a | b |\n| --- | --- |\n| c | d |').document;
  table.content[0].content[1].content[0].content.push({type:'paragraph',content:[{type:'text',text:'second paragraph'}]});
  assert.equal(serializeMarkdown(table).ok,false);
  const merged=inspectMarkdown('| a | b |\n| --- | --- |\n| c | d |').document;
  merged.content[0].content[1].content[0].attrs.colspan=2;
  assert.equal(serializeMarkdown(merged).ok,false);
  assert.equal(serializeMarkdown({type:'doc',content:[{type:'unsupportedNode'}]}).ok,false);
});

test('literal typed punctuation survives serialization without becoming formatting', () => {
  for (const text of ['**literal**','[link](https://example.com)','<img src=x>','a | b','## title','- item',
    '1. item','`backticks`','中文 😀 \\ path','a\nb','a  b','trailing ',' leading','&nbsp;']) {
    const document={type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]};
    const result=serializeMarkdown(document);
    // A serializer limitation is a blocked edit, never a silently changed meaning.
    if (result.ok) assert.deepEqual(markdownSemantics(result.markdown),{type:'root',children:[{type:'paragraph',children:[{type:'text',value:text.trim()}]}]});
    else assert.ok(result.reason);
  }
});

test('link input accepts relative paths but rejects unsafe schemes and controls', () => {
  for (const url of ['https://example.com','http://localhost','mailto:a@example.com','tel:123','../guide','/doc','#section','guide.md']) assert.equal(safeLink(url),true,url);
  for (const url of ['javascript:alert(1)','data:text/html,x','vbscript:x','//example.com','java\nscript:x','']) assert.equal(safeLink(url),false,url);
});


test('image URL entry rejects executable, upload and malformed addresses', () => {
  for (const url of ['https://example.com/image.png','http://localhost/image.svg','./badge.svg','../asset.png','/content/image.png']) assert.equal(safeImageSource(url),true,url);
  for (const url of ['javascript:alert(1)','data:image/png;base64,a','file:///tmp/a','blob:https://example.com/a','mailto:a@example.com','#image','https://','https://[bad','\\\\external.invalid/image.png']) assert.equal(safeImageSource(url),false,url);
});


test('editing the last block preserves original Setext, fence info, bullets and line endings', () => {
  const prefix='标题\r\n====\r\n\r\n~~~js title="keep metadata"\r\nconst n = 1;\r\n~~~\r\n\r\n*   第一项\r\n*   第二项\r\n\r\n';
  const original=prefix+'最后一段。\r\n';
  const document=inspectMarkdown(original).document;
  document.content.at(-1).content[0].text='修改后的最后一段。';
  const serialized=serializeMarkdown(document);assert.equal(serialized.ok,true);
  const result=preserveMarkdownBlocks(original,serialized.markdown+'\r\n');
  assert.ok(result.startsWith(prefix));assert.ok(result.endsWith('修改后的最后一段。\r\n'));
  assert.deepEqual(markdownSemantics(result),markdownSemantics(serialized.markdown));
});

test('splice preserves moved unique blocks but avoids guessing between duplicates', () => {
  const original='Heading\n=======\n\n* item\n\nTail';
  const moved='Tail\n\n# Heading\n\n- item';
  const result=preserveMarkdownBlocks(original,moved);
  assert.ok(result.includes('Heading\n======='));assert.ok(result.includes('* item'));
  assert.deepEqual(markdownSemantics(result),markdownSemantics(moved));
  const duplicates='same\n====\n\nsame\n====';
  assert.equal(preserveMarkdownBlocks(duplicates,'# same\n\n# same'),'# same\n\n# same');
});

test('unsafe block context falls back to the semantically verified serialization', () => {
  const original='    indented code\n\nEnd';
  const edited='New paragraph\n\n```\nindented code\n```\n\nChanged end';
  const result=preserveMarkdownBlocks(original,edited);
  assert.deepEqual(markdownSemantics(result),markdownSemantics(edited));
});
