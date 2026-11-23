import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MarkdownManager } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import CodeBlock from '@tiptap/extension-code-block';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

// Images retain their complete Markdown attributes, but editing never requests
// document URLs or external resources. Published rendering owns URL resolution.
const InertImage = Image.extend({
  renderHTML({ node }) {
    return ['span', { class: 'md-editor-image', 'data-md-image': '', contenteditable: 'false',
      role: 'img', 'aria-label': node.attrs.alt || '图片', title: node.attrs.src },
    `图片 · ${node.attrs.alt || node.attrs.src || '未命名'}`];
  },
});

const SafeCodeBlock = CodeBlock.extend({
  renderMarkdown(node) {
    const body = (node.content ?? []).map(child => child.text ?? '').join('');
    const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${node.attrs?.language ?? ''}\n${body}\n${fence}`;
  },
});

export function markdownExtensions() {
  return [StarterKit.configure({ underline: false, trailingNode: false, codeBlock: false,
    link: { openOnClick: false, autolink: false, linkOnPaste: false } }),
  TableKit.configure({ table: { resizable: false } }), InertImage, SafeCodeBlock,
  TaskList, TaskItem.configure({ nested: true })];
}
const extensions = markdownExtensions();
const schema = getSchema(extensions);
const manager = new MarkdownManager({ extensions });
const parser = unified().use(remarkParse).use(remarkGfm);
const unsupported = new Set(['html', 'definition', 'linkReference', 'imageReference', 'footnoteDefinition', 'footnoteReference']);

function stripPositions(value) {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'position' && key !== 'spread')
    .map(([key, child]) => [key, stripPositions(child)]));
}
export const markdownSemantics = source => stripPositions(parser.parse(source));
function containsUnsupported(node) {
  return unsupported.has(node.type) || (node.type === 'link' && !safeLink(node.url)) || node.children?.some(containsUnsupported);
}
function canonicalDocument(doc) {
  const json = structuredClone(doc.toJSON());
  const normalize = node => {
    if (['paragraph','heading'].includes(node.type) && node.content?.every(child => child.type === 'text' && /^[ \t\r\n]*$/.test(child.text))) delete node.content;
    node.content?.forEach(normalize);
  };
  normalize(json);
  // Empty top-level paragraphs are spacing, not document content. Markdown
  // cannot distinguish a cursor's trailing empty paragraph from a blank line.
  json.content = (json.content ?? []).filter(n => n.type !== 'paragraph' || n.content?.length);
  return JSON.stringify(json);
}
function parseDocument(source) {
  const parsed = manager.parse(source);
  if (!parsed.content?.length) parsed.content = [{ type: 'paragraph' }];
  const doc = schema.nodeFromJSON(parsed);
  doc.check();
  return doc;
}

/** Fail closed before mounting the editable view; never emit normalized source here. */
export function inspectMarkdown(source) {
  if (source.length > 200_000) return { supported: false, reason: '正文较长，已使用源码编辑以保持输入流畅。' };
  try {
    const ast = parser.parse(source);
    if (containsUnsupported(ast) || /^(?:---|\+\+\+)\r?\n/.test(source) || /^\s*:::/m.test(source)) {
      return { supported: false, reason: '正文含有需原样保留的语法，已使用源码编辑。' };
    }
    const doc = parseDocument(source);
    const normalized = manager.serialize(doc.toJSON());
    if (JSON.stringify(stripPositions(ast)) !== JSON.stringify(markdownSemantics(normalized)) ||
      canonicalDocument(doc) !== canonicalDocument(parseDocument(normalized))) {
      return { supported: false, reason: '此正文暂不能无损转换为可视化内容，已保留源码。' };
    }
    return { supported: true, document: structuredClone(doc.toJSON()) };
  } catch {
    return { supported: false, reason: '此正文暂不能无损转换为可视化内容，已保留源码。' };
  }
}

/** Reuse original bytes for unambiguously unchanged top-level blocks.
 * Offsets come from the Markdown parser, never regex boundaries. Ambiguous
 * duplicate blocks use the canonical serializer; a whole-document semantic
 * check rejects any splice whose surrounding Markdown changes interpretation.
 */
export function preserveMarkdownBlocks(original, edited) {
  try {
    const before = parser.parse(original), after = parser.parse(edited);
    const key = node => JSON.stringify(stripPositions(node));
    const originals = new Map(), counts = new Map();
    before.children.forEach((node, index) => {
      const fingerprint = key(node);
      if (originals.has(fingerprint)) originals.set(fingerprint, null);
      else originals.set(fingerprint, { node, index });
    });
    after.children.forEach(node => { const fingerprint = key(node); counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1); });
    const matches = after.children.map(node => counts.get(key(node)) === 1 ? originals.get(key(node)) : null);
    let candidate = '', cursor = 0;
    after.children.forEach((node, index) => {
      const match = matches[index], previous = matches[index - 1];
      const start = node.position.start.offset, end = node.position.end.offset;
      if (index === 0 && match?.index === 0) candidate += original.slice(0, match.node.position.start.offset);
      else if (match && previous && match.index === previous.index + 1) {
        candidate += original.slice(previous.node.position.end.offset, match.node.position.start.offset);
      } else if (previous && before.children.length === after.children.length && previous.index === index - 1) {
        // Editing a neighboring block need not normalize the original separator.
        candidate += original.slice(previous.node.position.end.offset, before.children[index].position.start.offset);
      } else candidate += edited.slice(cursor, start);
      candidate += match ? original.slice(match.node.position.start.offset, match.node.position.end.offset) : edited.slice(start, end);
      cursor = end;
    });
    const last = matches.at(-1);
    candidate += last && last.index === before.children.length - 1 ? original.slice(last.node.position.end.offset) : edited.slice(cursor);
    return JSON.stringify(stripPositions(parser.parse(candidate))) === JSON.stringify(stripPositions(after)) ? candidate : edited;
  } catch { return edited; }
}

/** Validate each edited document before accepting a transaction or emitting source. */
export function serializeMarkdown(document) {
  try {
    const doc = schema.nodeFromJSON(document);
    doc.check();
    const markdown = manager.serialize(doc.toJSON());
    if (containsUnsupported(parser.parse(markdown)) ||
      canonicalDocument(doc) !== canonicalDocument(parseDocument(markdown))) {
      return { ok: false, reason: '此格式无法完整保存为 Markdown，已保留修改前的内容。' };
    }
    return { ok: true, markdown };
  } catch {
    return { ok: false, reason: '此格式无法完整保存为 Markdown，已保留修改前的内容。' };
  }
}

export function safeLink(value) {
  const url = value.trim();
  if (!url || /[\u0000-\u0020\u007f\\]/u.test(url) || url.startsWith('//')) return false;
  try {
    const parsed = new URL(url, 'https://markdown-editor.invalid/');
    if (/^[a-z][\w+.-]*:/i.test(url)) {
      return ['mailto:', 'tel:'].includes(parsed.protocol) ||
        (/^https?:\/\//i.test(url) && ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname);
    }
    return parsed.origin === 'https://markdown-editor.invalid';
  } catch { return false; }
}

export function safeImageSource(value) {
  const url = value.trim();
  return safeLink(url) && !url.startsWith('#') && (!/^[\w+.-]+:/i.test(url) || /^https?:\/\//i.test(url));
}
