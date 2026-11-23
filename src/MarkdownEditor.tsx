import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Extension, type ChainedCommands, type JSONContent } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { inspectMarkdown, markdownExtensions, safeLink, safeImageSource, preserveMarkdownBlocks, serializeMarkdown } from './md-editor-codec.mjs';
import './md-editor.css';

type Props = { value: string; onChange: (value: string) => void };
type Assessment = { supported: boolean; reason?: string; document?: JSONContent };

function VisualEditor({ source, document, onChange }: {
  source: string; document: JSONContent; onChange: Props['onChange'];
}) {
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<'insert' | 'format' | 'link' | 'image' | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [dismissedSelection, setDismissedSelection] = useState('');
  const [query, setQuery] = useState(''), [activeItem, setActiveItem] = useState(0);
  const [link, setLink] = useState('');
  const [imageURL, setImageURL] = useState(''), [imageAlt, setImageAlt] = useState('');
  const rootRef = useRef<HTMLDivElement>(null), popupRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<HTMLElement | null>(null), searchRef = useRef<HTMLInputElement>(null);
  const openLinkRef = useRef(() => {});
  const [popupPosition, setPopupPosition] = useState({ left: 12, top: 12, visible: false });
  const [lineTop, setLineTop] = useState<number | null>(null);
  const imageURLId = useId(), imageAltId = useId(), popupId = useId(), listId = useId();
  const linkId = useId(), errorId = useId(), hintId = useId();
  const callback = useRef(onChange);
  callback.current = onChange;
  const emitted = useRef(source);
  const extensions = useMemo(() => [...markdownExtensions(), Extension.create({
    name: 'markdownRoundtripGuard',
    addProseMirrorPlugins() {
      return [new Plugin({ filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        const result = serializeMarkdown(transaction.doc.toJSON());
        if (!result.ok) setError(result.reason);
        else setError('');
        return result.ok;
      } })];
    },
  })], []);
  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: document,
    editorProps: {
      attributes: { class: 'md-editor-document', role: 'textbox', 'aria-label': 'Markdown 可视化正文',
        'aria-multiline': 'true', 'aria-describedby': `${hintId} ${errorId}`, spellcheck: 'false' },
      handleKeyDown(view, event) {
        if (event.isComposing || view.composing) return false;
        const blank = view.state.selection.empty && view.state.selection.$from.depth === 1 &&
          view.state.selection.$from.parent.type.name === 'paragraph' && view.state.selection.$from.parent.content.size === 0;
        if ((event.key === '/' && blank && !event.metaKey && !event.ctrlKey && !event.altKey) ||
          (event.altKey && event.shiftKey && event.code === 'KeyI')) {
          event.preventDefault(); originRef.current = null; setQuery(''); setActiveItem(0); setPanel('insert'); return true;
        }
        if (event.altKey && event.shiftKey && event.code === 'KeyF') {
          event.preventDefault(); originRef.current = null; setPanel('format'); return true;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault(); openLinkRef.current(); return true;
        }
        return false;
      },
      // A paste from a web page must not silently import unsupported formatting,
      // executable HTML, or remote images. Preserve its text as literal content.
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined || event.clipboardData?.files.length) {
          setError('暂不支持粘贴文件，请在空行输入 / 并选择「图片」。');
          return true;
        }
        event.preventDefault();
        if (!/[\r\n]/.test(text) || view.state.selection.$from.parent.type.spec.code) {
          view.dispatch(view.state.tr.insertText(text));
        } else {
          const paragraphs = text.split(/\r\n?|\n/).map(line => view.state.schema.nodes.paragraph.create(null,
            line ? view.state.schema.text(line) : undefined));
          view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 1, 1)).scrollIntoView());
        }
        return true;
      },
      handleDrop(_view, event) {
        if (event.dataTransfer?.files.length || event.dataTransfer?.getData('text/html')) {
          setError('暂不支持拖入文件或网页内容，请粘贴纯文本，或用「图片」插入图片地址。');
          return true;
        }
        return false;
      },
    },
    onFocus() { setEngaged(true); },
    onSelectionUpdate() { originRef.current = null; },
    onBlur({ event }) {
      const next = event.relatedTarget as Node | null;
      if (!rootRef.current?.contains(next) && !popupRef.current?.contains(next)) setEngaged(false);
    },
    onUpdate({ editor: active }) {
      const result = serializeMarkdown(active.getJSON());
      if (!result.ok) { setError(result.reason); return; }
      const original = active.schema.nodeFromJSON(document);
      let next = active.state.doc.eq(original) ? source : result.markdown;
      if (next !== source) {
        const ending = source.match(/(?:\r?\n)+$/)?.[0] ?? '';
        next = next.replace(/\n+$/, '') + ending;
        if (source.includes('\r\n')) next = next.replace(/(?<!\r)\n/g, '\r\n');
        next = preserveMarkdownBlocks(source, next);
      }
      if (next !== emitted.current) { emitted.current = next; callback.current(next); }
    },
  });
  const editorState = useEditorState({ editor, selector: ({ editor: active }) => ({
    doc: active?.state.doc, selection: active?.state.selection, marks: active?.state.storedMarks,
  }) });
  const selection = editorState?.selection;
  const selectionKey = selection ? `${selection.from}:${selection.to}` : '';
  const hasSelection = !!selection && !selection.empty && !!editorState?.doc?.textBetween(selection.from, selection.to).trim();
  const showFormat = panel === 'format' || (!panel && engaged && hasSelection && dismissedSelection !== selectionKey);
  const popupOpen = !!panel || showFormat;
  const blankLine = !!selection?.empty && selection.$from.depth === 1 && selection.$from.parent.type.name === 'paragraph' && selection.$from.parent.content.size === 0;

  const closePopup = (restoreFocus = true) => {
    setPanel(null); setDismissedSelection(selectionKey);
    if (restoreFocus) editor?.view.focus();
  };
  const openInsert = (origin: HTMLElement | null = null) => {
    originRef.current = origin; setQuery(''); setActiveItem(0); setPanel('insert');
  };
  const openLink = () => {
    setLink(editor?.getAttributes('link').href ?? ''); setPanel('link');
  };
  openLinkRef.current = () => { originRef.current = null; openLink(); };

  useLayoutEffect(() => {
    if (!editor || !rootRef.current) return;
    const position = () => {
      if (editor.isDestroyed || !rootRef.current) return;
      const root = rootRef.current.getBoundingClientRect();
      const start = editor.view.coordsAtPos(editor.state.selection.from);
      setLineTop(blankLine && engaged ? start.top - root.top - 4 : null);
      if (!popupOpen) return;
      const end = editor.view.coordsAtPos(editor.state.selection.to);
      const anchor = originRef.current?.getBoundingClientRect() ?? {
        left: Math.min(start.left, end.left), right: Math.max(start.right, end.right),
        top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom),
      };
      const viewport = window.visualViewport;
      const minX = viewport?.offsetLeft ?? 0, minY = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const popupWidth = popupRef.current?.offsetWidth ?? 340, popupHeight = popupRef.current?.offsetHeight ?? 56;
      const left = Math.max(minX + 12, Math.min(anchor.left, minX + width - popupWidth - 12));
      const above = showFormat && !originRef.current && anchor.top - popupHeight > minY + 16;
      const top = Math.max(minY + 12, Math.min(above ? anchor.top - popupHeight - 8 : anchor.bottom + 8, minY + height - popupHeight - 12));
      setPopupPosition({ left, top, visible: !!panel || (anchor.bottom >= minY && anchor.top <= minY + height) });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(rootRef.current);
    if (popupRef.current) observer.observe(popupRef.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position); window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [editor, editorState, blankLine, engaged, popupOpen, panel, showFormat]);

  useEffect(() => {
    if (!popupOpen) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !popupRef.current?.contains(event.target as Node)) {
        setPanel(null); setEngaged(false); setDismissedSelection(selectionKey);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault(); setPanel(null); setDismissedSelection(selectionKey); editor?.view.focus();
      }
    };
    window.document.addEventListener('pointerdown', outside);
    window.document.addEventListener('keydown', escape);
    return () => { window.document.removeEventListener('pointerdown', outside); window.document.removeEventListener('keydown', escape); };
  }, [popupOpen, selectionKey, editor]);

  useEffect(() => {
    if (!popupPosition.visible) return;
    if (panel === 'insert') searchRef.current?.focus();
    if (panel === 'format') popupRef.current?.querySelector<HTMLSelectElement>('select')?.focus();
    if (panel === 'image' || panel === 'link') popupRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [panel, popupPosition.visible]);
  useEffect(() => {
    if (panel === 'insert') popupRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeItem, query, panel]);

  if (!editor) return <div className="md-editor-loading" role="status">正在打开编辑器…</div>;
  const run = (action: () => void) => { action(); setPanel(null); setDismissedSelection(selectionKey); editor.view.focus(); };
  const button = (label: string, text: string, action: () => void, active?: boolean, disabled = false) =>
    <button key={label} type="button" title={label} aria-label={label} aria-pressed={active}
      disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={action}>{text}</button>;
  const format = editor.isActive('heading') ? `h${editor.getAttributes('heading').level}` : 'paragraph';
  // Empty headings/lists/quotes are not roundtrippable in the codec. Insert a
  // selected label in the SAME guarded transaction, ready to replace by typing.
  const block = (transform: (chain: ChainedCommands) => ChainedCommands, label: string) => {
    const needsLabel = editor.state.selection.$from.parent.content.size === 0;
    let chain = transform(editor.chain().focus());
    if (needsLabel) chain = chain.insertContent(label).command(({ tr }) => {
      const end = tr.selection.to;
      tr.setSelection(TextSelection.create(tr.doc, end - label.length, end));
      return true;
    });
    chain.run();
  };
  const insertionItems: { name: string; icon: string; description: string; action: () => void; disabled?: boolean; keepOpen?: boolean }[] = [
    { name: '正文', icon: 'T', description: '普通段落', action: () => editor.chain().focus().setParagraph().run() },
    ...([1, 2, 3] as const).map(level => ({ name: `标题 ${level}`, icon: `H${level}`, description: ['大标题', '章节标题', '小节标题'][level - 1], action: () => block(chain => chain.setHeading({ level }), '标题') })),
    { name: '无序列表', icon: '•', description: '逐项记录要点', action: () => block(chain => chain.toggleBulletList(), '列表项') },
    { name: '有序列表', icon: '1.', description: '按顺序组织步骤', action: () => block(chain => chain.toggleOrderedList(), '列表项') },
    { name: '任务列表', icon: '☑', description: '可勾选的待办事项', action: () => editor.chain().focus().toggleTaskList().run() },
    { name: '引用', icon: '❝', description: '突出引用内容', action: () => block(chain => chain.toggleBlockquote(), '引用') },
    { name: '代码块', icon: '</>', description: '保留代码与换行', action: () => editor.chain().focus().toggleCodeBlock().run() },
    { name: '表格', icon: '▦', description: '插入两列表格', action: () => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run(), disabled: editor.isActive('table') },
    { name: '图片', icon: '▧', description: '图片地址与替代文字', action: () => { setImageURL(''); setImageAlt(''); setPanel('image'); }, keepOpen: true },
    { name: '分隔线', icon: '—', description: '分开不同章节', action: () => editor.chain().focus().setHorizontalRule().run() },
  ];
  const insertions = insertionItems.filter(item => `${item.name} ${item.description} ${item.icon}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedItem = Math.min(activeItem, Math.max(0, insertions.length - 1));
  const chooseInsertion = (index: number) => {
    const item = insertions[index];
    if (!item || item.disabled) return;
    if (item.keepOpen) item.action(); else run(item.action);
  };

  const popup = popupOpen && createPortal(<div ref={popupRef} id={popupId}
    className={`md-editor-overlay ${panel === 'insert' ? 'md-editor-palette' : showFormat ? 'md-editor-format' : 'md-editor-form'}`}
    style={{ left: popupPosition.left, top: popupPosition.top, visibility: popupPosition.visible ? 'visible' : 'hidden' }}
    role="dialog" aria-label={panel === 'insert' ? '插入内容' : panel === 'link' ? '编辑链接' : panel === 'image' ? '插入图片' : '文字格式'}>
    {panel === 'insert' ? <>
      <div className="md-editor-popup-heading"><span>插入内容</span><button type="button" aria-label="关闭插入面板" onClick={() => closePopup()}>×</button></div>
      <input ref={searchRef} className="md-editor-search" aria-label="搜索插入内容" role="combobox" aria-expanded="true"
        aria-controls={listId} aria-autocomplete="list" aria-activedescendant={insertions.length ? `${listId}-${selectedItem}` : undefined}
        placeholder="搜索标题、表格、图片…" value={query} onChange={event => { setQuery(event.target.value); setActiveItem(0); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) event.preventDefault();
          if (event.key === 'ArrowDown') setActiveItem((selectedItem + 1) % Math.max(1, insertions.length));
          if (event.key === 'ArrowUp') setActiveItem((selectedItem + insertions.length - 1) % Math.max(1, insertions.length));
          if (event.key === 'Home') setActiveItem(0);
          if (event.key === 'End') setActiveItem(Math.max(0, insertions.length - 1));
          if (event.key === 'Enter') chooseInsertion(selectedItem);
        }} />
      <div id={listId} className="md-editor-insertions" role="listbox" aria-label="内容类型">
        {insertions.map((item, index) => <button key={item.name} id={`${listId}-${index}`} type="button" role="option"
          aria-label={item.name} aria-selected={index === selectedItem} aria-disabled={item.disabled || undefined} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onPointerMove={() => setActiveItem(index)} onClick={() => chooseInsertion(index)}>
          <span className="md-editor-block-icon" aria-hidden="true">{item.icon}</span><span><strong>{item.name}</strong><small>{item.description}</small></span>
        </button>)}
      </div>
      {!insertions.length && <p className="md-editor-empty-results">没有匹配内容，试试“标题”或“图片”。</p>}
      <div className="md-editor-palette-hint">↑ ↓ 选择<span>Enter 插入 · Esc 关闭</span></div>
    </> : showFormat ? <>
      <div className="md-editor-format-row" role="group" aria-label="选区格式">
        <select aria-label="段落格式" value={format} onChange={event => {
          if (event.target.value === 'paragraph') editor.chain().focus().setParagraph().run();
          else block(chain => chain.setHeading({ level: Number(event.target.value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }), '标题');
        }}><option value="paragraph">正文</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`h${level}`}>标题 {level}</option>)}</select>
        <span className="md-editor-separator" aria-hidden="true" />
        {button('粗体', 'B', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
        {button('斜体', 'I', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
        {button('删除线', 'S', () => editor.chain().focus().toggleStrike().run(), editor.isActive('strike'))}
        {button('行内代码', '</>', () => editor.chain().focus().toggleCode().run(), editor.isActive('code'))}
        {button('链接', '链接', openLink, editor.isActive('link'))}
        <button type="button" aria-label="关闭格式面板" onClick={() => closePopup()}>×</button>
      </div>
      {editor.isActive('table') && <div className="md-editor-table-tools" role="group" aria-label="表格编辑">
        {button('下方插入行', '+ 行', () => editor.chain().focus().addRowAfter().run())}
        {button('右侧插入列', '+ 列', () => editor.chain().focus().addColumnAfter().run())}
        {button('删除当前行', '删除行', () => editor.chain().focus().deleteRow().run())}
        {button('删除当前列', '删除列', () => editor.chain().focus().deleteColumn().run())}
        {button('删除表格', '删除表格', () => run(() => editor.chain().focus().deleteTable().run()))}
      </div>}
    </> : panel === 'link' ? <form onSubmit={event => {
      event.preventDefault(); if (!safeLink(link)) { setError('请输入有效的网页地址或相对路径。'); return; }
      run(() => editor.chain().focus().extendMarkRange('link').setLink({ href: link.trim() }).run());
    }}>
      <div className="md-editor-popup-heading"><span>编辑链接</span><button type="button" aria-label="关闭链接面板" onClick={() => closePopup()}>×</button></div>
      <label htmlFor={linkId}>链接地址</label><input id={linkId} autoFocus value={link} placeholder="https:// 或相对路径" onChange={event => setLink(event.target.value)} />
      <div className="md-editor-form-actions"><button type="button" onClick={() => run(() => editor.chain().focus().extendMarkRange('link').unsetLink().run())}>移除链接</button><button type="submit" className="md-editor-primary">应用链接</button></div>
      {error && <p className="md-editor-popup-error" role="alert">{error}</p>}
    </form> : <form onSubmit={event => {
      event.preventDefault(); if (!safeImageSource(imageURL)) { setError('请输入 http(s) 图片地址或相对路径，不支持上传或 data URL。'); return; }
      run(() => editor.chain().focus().setImage({ src: imageURL.trim(), alt: imageAlt }).run());
    }}>
      <div className="md-editor-popup-heading"><span>插入图片</span><button type="button" aria-label="关闭图片面板" onClick={() => closePopup()}>×</button></div>
      <label htmlFor={imageURLId}>图片地址</label><input id={imageURLId} autoFocus value={imageURL} placeholder="https:// 或相对路径" onChange={event => setImageURL(event.target.value)} />
      <label htmlFor={imageAltId}>替代文字</label><input id={imageAltId} value={imageAlt} placeholder="描述图片内容" onChange={event => setImageAlt(event.target.value)} />
      <p className="md-editor-form-note">仅添加图片引用，不上传文件。</p>
      <div className="md-editor-form-actions"><button type="button" onClick={() => closePopup()}>取消</button><button type="submit" className="md-editor-primary">插入图片</button></div>
      {error && <p className="md-editor-popup-error" role="alert">{error}</p>}
    </form>}
  </div>, window.document.body);

  return <div ref={rootRef} className="md-editor" data-empty={editor.isEmpty || undefined}>
    {lineTop !== null && <button type="button" className="md-editor-line-plus" style={{ top: lineTop }} aria-label="在空行插入内容"
      aria-haspopup="dialog" onMouseDown={event => event.preventDefault()} onClick={() => openInsert()}>＋</button>}
    <EditorContent editor={editor} />
    <p className="sr-only" id={hintId}>选中文字设置格式，空行输入 / 插入内容。也可按 Alt+Shift+I 插入，Alt+Shift+F 设置格式。</p>
    <p id={errorId} className="md-editor-status" role="status">{error}</p>
    {popup}
  </div>;

}

/** Unsupported Markdown stays editable without a lossy conversion. */
export default function MarkdownEditor({ value, onChange }: Props) {
  const lastValue = useRef(value);
  const [session, setSession] = useState(() => ({ source: value, generation: 0,
    assessment: inspectMarkdown(value) as Assessment }));
  // Parent echoes preserve cursor/undo. An external document replacement gets a
  // fresh editor so undo can never resurrect the preceding document's content.
  if (value !== lastValue.current) {
    lastValue.current = value;
    setSession({ source: value, generation: session.generation + 1, assessment: inspectMarkdown(value) });
  }
  const change = (next: string) => { lastValue.current = next; onChange(next); };
  const fallbackId = useId();
  if (!session.assessment.supported) return <div className="md-editor md-editor-source">
    <p id={fallbackId} className="md-editor-status" role="status">{session.assessment.reason}</p>
    <textarea aria-label="Markdown 源码（兼容模式）" aria-describedby={fallbackId} spellCheck={false}
      value={value} onChange={event => change(event.target.value)} />
  </div>;
  return <VisualEditor key={session.generation} source={session.source} document={session.assessment.document!} onChange={change} />;
}
