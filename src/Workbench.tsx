import { flushSync } from 'react-dom';
import { DirectoryToggle } from './DirectoryControls';
import './markdown.css';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownBody, { draftMarkdownBase } from './MarkdownBody';
import ApiPreview from './ApiPreview';
import AdminTabs, {type TabMetadata} from './AdminTabs';
import { useBlocker } from 'zudoku/router';
import { Slot } from 'zudoku';
import { branch, canMoveNode, children, labels, readWorkspace, Tree, type NodeMove, type DocNode, type Workspace } from './workbench-tree';
import { operationError, operationTemplate } from './workbench-operation';
import './workbench.css';

const MarkdownEditor = lazy(() => import('./MarkdownEditor'));
const OpenApiEditor = lazy(() => import('./OpenApiEditor'));

const leave = '尚有未保存的修改，确定放弃并离开吗？';
const authHint = '请确认文档管理服务已启动，然后重新读取。';
const errors: Record<number,string> = {
  401: `无法访问文档管理服务。${authHint}`, 403: '管理服务拒绝了请求，请检查服务配置后重新读取。',
  409: '服务器版本已改变。请先复制需要保留的修改，再重新读取并合并；不会覆盖他人的版本。',
};
function rememberNode(id: string) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('doc') === id) return;
  url.searchParams.set('doc', id);
  window.history.replaceState(window.history.state, '', url);
}
function UnsavedGuard() {
  const blocker = useBlocker(true);
  useEffect(() => {
    if (blocker.state === 'blocked') { if (window.confirm(leave)) blocker.proceed(); else blocker.reset(); }
  },[blocker]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload',warn); return () => window.removeEventListener('beforeunload',warn);
  },[]);
  return null;
}

export default function Workbench() {
  const [base,setBase] = useState<Workspace|null>(null), [node,setNode] = useState<DocNode|null>(null);
  const [treeClosed,setTreeClosed] = useState(false);
  const [editing,setEditing] = useState(false);
  const [mode,setMode] = useState<'visual'|'source'>('visual');
  const [formValid,setFormValid] = useState(true);
  function resetEditor() {setMode('visual');setFormValid(true);}
  const [busy,setBusy] = useState(true), [locked,lock] = useState(false), [message,report] = useState('正在读取工作区…');
  const pending = useRef<AbortController|null>(null), title = useRef<HTMLInputElement>(null);
  const saved = base?.nodes.find(n => n.id === node?.id);
  const dirty = !!node && (!formValid || !saved || saved.title !== node.title || saved.body !== node.body || saved.parentId !== node.parentId || saved.sort !== node.sort);
  const disabled = busy || locked;
  const error = useMemo(() => node?.type === 'api' ? operationError(node.body) : '', [node?.type,node?.body]);
  const canLeave = () => !dirty || window.confirm(leave);
  async function request(method: 'GET'|'PUT'|'POST'|'DELETE', payload?: object, endpoint?:string, focusId?:string): Promise<boolean> {
    if (pending.current) return false;
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    report(endpoint === '/manage/node/move' ? '正在移动…' : method === 'GET' ? '正在读取…' : method === 'DELETE' ? '正在删除…' : method === 'PUT' ? '正在保存…' : '正在发布…');
    try {
      const res = await fetch(endpoint ?? ({GET:'/manage/workspace',PUT:'/manage/node',DELETE:'/manage/node',POST:'/manage/publish'})[method], {
        method, credentials:'same-origin', mode:'same-origin', redirect:'error', cache:'no-store', signal:controller.signal,
        headers: payload ? {'Content-Type':'application/json',Accept:'application/json'} : {Accept:'application/json'}, body: payload && JSON.stringify(payload),
      });
      if (res.status === 400 || res.status === 422) {
        const detail = await res.json().catch(() => null);
        if (!controller.signal.aborted) report(`服务器未接受此节点：${typeof detail?.error === 'string' ? detail.error.slice(0,400) : '请检查名称和接口定义。'}`);
        return false;
      }
      if (res.status === 401) { window.location.assign(`/login?${new URLSearchParams({next:window.location.pathname+window.location.search})}`); return false; }
      if (!res.ok) throw res.status;
      const next = readWorkspace(await res.json()); if (controller.signal.aborted) return false;
      if (base && JSON.stringify(base.published) !== JSON.stringify(next.published)) {
        try { localStorage.setItem('open-docs:release', String(next.revision)); } catch { /* reader also checks when refocused */ }
      }
      const params = new URLSearchParams(window.location.search);
      const target = next.nodes.find(n => n.id === (focusId ?? node?.id ?? params.get('doc')))
        ?? (!base && params.get('section') === 'api' ? next.nodes.find(n => n.type === 'api') : undefined)
        ?? children(next.nodes,null)[0];
      if (!target) {setBase(next);setNode(null);return true;}
      rememberNode(target.id); setNode(target); setBase(next); lock(false); resetEditor();
      report(endpoint === '/manage/node/move' ? '目录位置已保存为草稿；点击「发布此节点」后浏览端才会更新。' : method === 'GET' ? '已读取工作区。' : method === 'DELETE' ? '节点已删除。' : method === 'PUT' ? `草稿已保存：「${target.title}」。` : `发布成功：「${target.title}」。`);
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      if (typeof err === 'number' && errors[err]) { lock(true); report(errors[err]); }
      else { lock(true); report(`无法确认服务器状态${typeof err === 'number' ? `（HTTP ${err}）` : ''}。请重新读取。${method === 'GET' ? authHint : '当前编辑仍保留在页面中。'}`); }
      return false;
    } finally { if (pending.current === controller) {pending.current = null; setBusy(false);} }
  }
  useEffect(() => { void request('GET'); return () => {pending.current?.abort(); pending.current = null;}; },[]);
  function focusEditor() { requestAnimationFrame(() => title.current?.focus()); }
  function choose(next: DocNode, focus: boolean) {
    if (next.id !== node?.id) { if (!canLeave()) return; setNode(next); resetEditor(); setEditing(focus); report(''); }
    if (base?.nodes.some(n => n.id === next.id)) rememberNode(next.id);
    if (focus) { setEditing(true); resetEditor(); focusEditor(); }
  }
  function add(parent: DocNode, type: DocNode['type']) {
    if (!base || !canLeave()) return;
    const id = crypto.randomUUID();
    setNode({id, parentId:parent.id, sort:Math.max(-1,...children(base.nodes,parent.id).map(n => n.sort))+1, type,
      title:`新${labels[type]}`, body:type === 'api' ? operationTemplate(id) : '', draftVersion:0, publishedVersion:null});
    setEditing(true); resetEditor(); report('新节点仅在本页；保存后才会写入草稿。'); focusEditor();
  }
  const nodes = base && node ? (saved ? base.nodes.map(n => n.id === node.id ? node : n) : [...base.nodes,node]) : [];
  const rootNodes = children(nodes,null);
  const activeRoot = rootNodes.find(root => node && branch(nodes,root.id).has(node.id))?.id ?? rootNodes[0]?.id ?? '';
  async function saveTabs(tabs:TabMetadata[],focus?:string) {
    if (!base || !canLeave()) return false;
    const ok = await request('PUT',{revision:base.revision,tabs},'/manage/tabs',focus);
    if(ok)setEditing(false);return ok;
  }
  async function moveNode(value: NodeMove): Promise<boolean> {
    if (!base || disabled || dirty || pending.current || !canMoveNode(base.nodes, value)) return false;
    const currentBranch = branch(base.nodes, activeRoot);
    if (!currentBranch.has(value.id) || !currentBranch.has(value.parentId)) return false;
    return request('POST', { revision: base.revision, ...value }, '/manage/node/move', value.id);
  }
  const visibleBranch = branch(nodes,activeRoot);
  const visibleNodes = nodes.filter(n => visibleBranch.has(n.id));
  const needsParent = node?.parentId && base?.nodes.find(n => n.id === node.parentId)?.publishedVersion === null;
  const published = !!saved && saved.publishedVersion === saved.draftVersion;
  const canSave = !!(editing && base && node && !disabled && dirty && formValid && node.title.trim() && !error);
  const saveCurrent = useRef<() => void>(() => {});
  saveCurrent.current = () => { if (canSave && base && node) void request('PUT',{revision:base.revision,node}); };
  const saveDraft = () => {
    // Field names and routes commit on blur. A keyboard save must include that last input,
    // and must re-check validity against the updated render rather than this event's closure.
    if (node?.type === 'api' && document.activeElement instanceof HTMLElement && document.activeElement.closest('.api-editor')) {
      flushSync(() => (document.activeElement as HTMLElement)?.blur());
    }
    saveCurrent.current();
  };
  return <section className="wb not-prose" aria-label="文档管理工作区" onKeyDown={event=>{
    if (editing && !event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase()==='s') {
      event.preventDefault();
      if (!event.repeat && !(event.target instanceof Element && event.target.closest('[role="dialog"]'))) saveDraft();
    }
  }}>
    <Slot.Source name="top-navigation-before"><AdminTabs tabs={rootNodes} active={activeRoot} disabled={disabled || !base} select={next=>choose(next,false)} save={saveTabs} nonempty={rootNodes.filter(tab=>nodes.some(child=>child.parentId===tab.id)).map(tab=>tab.id)} remove={async tab=>{
      if(!base||!canLeave())return false;
      const fallback=rootNodes.find(root=>root.id!==tab.id);
      const ok=await request('DELETE',{revision:base.revision,id:tab.id},'/manage/tabs',activeRoot===tab.id?fallback?.id:node?.id);
      if(ok){setEditing(false);report(tab.publishedVersion===null?'栏目草稿已删除，发布内容未改变。':'空栏目已删除并下线，其他草稿未发布。');}
      return ok;
    }} logout={async()=>{if(!canLeave())return;try{const res=await fetch('/manage/logout',{method:'POST',credentials:'same-origin'});if(res.ok||res.status===401)window.location.assign('/login');else report('退出登录失败，请重试。');}catch{report('无法连接管理服务，请重试。');}}} publish={()=>{if(base&&canLeave()&&confirm('发布所有栏目的名称和顺序？未发布的子文档不会一并发布。'))void request('POST',{revision:base.revision},'/manage/tabs/publish');}} /></Slot.Source>
    {dirty && <UnsavedGuard />}
    {!base && <div className="wb-status" role="status">{message}<button disabled={busy} onClick={() => request('GET')}>重新读取</button></div>}
    {base && node && <div id="wb-section" role="tabpanel" aria-labelledby={`wb-tab-${activeRoot}`} className={'wb-layout'+(treeClosed?' wb-tree-closed':'')}><div className="wb-rail"><DirectoryToggle className="wb-rail-toggle" controls="wb-directory" closed={treeClosed} toggle={()=>setTreeClosed(!treeClosed)}/><div hidden={treeClosed} id="wb-directory"><Tree key={activeRoot} nodes={visibleNodes} selected={node.id} unsavedId={saved ? undefined : node.id} select={choose} add={add} move={moveNode} moveDisabled={dirty} disabled={disabled} remove={async n=>{
        if(!n.parentId || !canLeave() || !confirm(`删除「${n.title}」？${n.publishedVersion===null?'该节点尚未发布。':'该节点也会从当前发布目录下线。'}不会删除其他节点。`))return;
        if(await request('DELETE',{revision:base.revision,id:n.id},'/manage/node',n.id===node.id?n.parentId:node.id))setEditing(false);
      }}/></div></div>
      <section className="wb-editor" data-editing={editing || undefined} data-document-canvas={editing && node.type==='markdown' || undefined} aria-label="节点编辑器"><header className="wb-document-head"><div><div className="wb-breadcrumb">{node.parentId ? base.nodes.find(n => n.id === node.parentId)?.title : '内容目录'}<span> / {labels[node.type]}</span></div>{editing ? <input id="wb-title" className="wb-inline-title" aria-label="名称" ref={title} maxLength={200} placeholder={node.type==='api'?'接口目录名称':'未命名文档'} value={node.title} readOnly={disabled} onChange={e=>setNode({...node,title:e.target.value})}/> : node.type !== 'api' ? <h1>{node.title || '未命名'}</h1> : null}<small>{dirty ? '● 未保存' : published ? '已发布' : '草稿 · 尚有未发布内容'}</small></div><div className="wb-actions"><button disabled={busy} onClick={() => canLeave() && request('GET')}>刷新</button><button disabled={disabled} onClick={() => {if (editing && !canLeave()) return; if (editing) { const restored = saved ?? base.nodes.find(n => n.id === node.parentId) ?? base.nodes[0]; setNode(restored); rememberNode(restored.id); } setEditing(!editing); resetEditor();}}>{editing ? '返回阅读' : '编辑'}</button>{editing && <button className={canSave ? "wb-primary" : undefined} title="保存草稿（⌘S / Ctrl+S），不会发布" disabled={!canSave} onClick={saveDraft}>保存草稿</button>}{!published && <button className="wb-primary" title={needsParent ? "请先发布上级目录" : "发布当前节点"} disabled={disabled || dirty || !saved || published || !!needsParent || !!error} onClick={() => saved && confirm(`确定对外发布「${saved.title}」的草稿 v${saved.draftVersion} 吗？其他节点不会发布。`) && request('POST',{revision:base.revision,id:saved.id,draftVersion:saved.draftVersion})}>发布此节点</button>}</div></header>
        <div className={message==='已读取工作区。' ? 'wb-status sr-only' : 'wb-status'} role="status">{message}</div>
        {!editing ? <div className="wb-reading">{node.type === 'group' ? <><p>选择左侧文档查看内容，或点击目录旁的 ＋ 新增文档、接口或子目录。</p><div className="wb-child-links">{children(nodes,node.id).map(child => <button key={child.id} onClick={() => choose(child,false)}>{child.title}<span>→</span></button>)}</div></> : node.type === 'markdown' ? <article className="portal-markdown prose dark:prose-invert"><MarkdownBody draft base={draftMarkdownBase(base.published)}>{node.body || '暂无正文，点击编辑开始编写。'}</MarkdownBody></article> : <ApiPreview key={`${node.id}:${base.revision}`} id={node.id} version={base.revision} />}</div> : <div className="wb-fields">
        {!node.title.trim() && <small>请填写名称后保存。</small>}
        {node.type === 'group' ? <div className="wb-guide"><strong>目录节点</strong><p>使用目录行右侧的 ＋ 添加内容。目录与子节点分别保存、分别发布。</p></div> : <>
          {node.type === 'api' && <div className="wb-tools"><strong>接口定义</strong>
            <div role="group" aria-label="编辑方式" className="wb-mode-switch">{(['visual','source'] as const).map(m=><button key={m} type="button" disabled={disabled} aria-pressed={mode===m} onClick={()=>{
              if (mode===m) return;
              if (!formValid && !confirm('表单中还有无效输入。放弃该输入并切换编辑方式？')) return;
              setFormValid(true);setMode(m);
            }}>{m==='source'?'源码':'表单编辑'}</button>)}</div>
          </div>}
          {node.type === 'api' && mode === 'source' ?
            <textarea id="wb-body" aria-label="YAML 正文" aria-invalid={!!error} aria-describedby={error ? 'wb-error' : undefined} spellCheck={false} readOnly={disabled} value={node.body} onChange={e => setNode({...node,body:e.target.value})}/> :
            <div className="wb-edit-surface" key={node.id} inert={disabled}><Suspense fallback={<p role="status">正在加载编辑器…</p>}>{node.type==='api' ? <OpenApiEditor value={node.body} onValidityChange={setFormValid} onChange={body=>setNode(n=>n?.id===node.id?{...n,body}:n)}/> : <MarkdownEditor value={node.body} onChange={body=>setNode(n=>n?.id===node.id?{...n,body}:n)}/>}</Suspense></div>}
          {error && <p id="wb-error" className="wb-error">{error}</p>}
        </>}
        </div>}

      </section></div>}
  </section>;
}
