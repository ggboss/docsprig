import { useDirectorySearch } from './useDirectorySearch';
import { DirectorySearch } from './DirectoryControls';
import { useId, useRef, useState, type DragEvent } from 'react';
export type DocNode = { id: string; parentId: string | null; sort: number; title: string; type: 'group' | 'api' | 'markdown'; body: string; draftVersion: number; publishedVersion: number | null };
export type Workspace = { revision: string | number; nodes: DocNode[]; published: unknown };

const nodeOrder = (a: DocNode, b: DocNode) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const children = (nodes: DocNode[], id: string | null) => nodes.filter(n => n.parentId === id).sort(nodeOrder);
export function branch(nodes: DocNode[], id: string) {
  const ids = new Set([id]);
  for (const parent of ids) for (const child of children(nodes, parent)) ids.add(child.id);
  return ids;
}
export function readWorkspace(value: Workspace): Workspace {
  if (!value || !['string','number'].includes(typeof value.revision) || !('published' in value) || !Array.isArray(value.nodes)) throw Error();
  const nodes = value.nodes;
  if (nodes.some(n => !n || typeof n.id !== 'string' || !n.id || typeof n.title !== 'string' || typeof n.body !== 'string' || !(Number.isSafeInteger(n.draftVersion) && n.draftVersion >= 0) || !(n.publishedVersion === null || (Number.isSafeInteger(n.publishedVersion) && n.publishedVersion >= 0)) || !Number.isFinite(n.sort) || !['group','markdown','api'].includes(n.type))) throw Error();
  const byId = new Map(nodes.map(n => [n.id,n]));
  const roots = nodes.filter(n => n.parentId === null).map(n => n.id);
  if (byId.size !== nodes.length || roots.some(id => byId.get(id)?.type !== 'group')) throw Error();
  const reached = new Set(roots);
  for (const id of reached) if (byId.get(id)?.type === 'group') for (const child of children(nodes,id)) reached.add(child.id);
  if (reached.size !== nodes.length) throw Error();
  return value;
}
export type NodeMove = { id: string; parentId: string; beforeId: string | null };
// Recheck against the complete saved tree before sending a move to the server.
export function canMoveNode(nodes: DocNode[], move: NodeMove): boolean {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const source = byId.get(move.id), parent = byId.get(move.parentId);
  if (!source?.parentId || !parent || parent.type !== 'group' || move.id === move.beforeId) return false;
  const root = (node: DocNode) => {
    const visited = new Set<string>();
    while (node.parentId !== null) {
      if (visited.has(node.id)) return null;
      visited.add(node.id);
      const next = byId.get(node.parentId);
      if (!next) return null;
      node = next;
    }
    return node.id;
  };
  const sourceRoot = root(source);
  if (!sourceRoot || sourceRoot !== root(parent) || branch(nodes, source.id).has(parent.id)) return false;
  const existing = children(nodes, parent.id);
  const siblings = existing.filter(n => n.id !== source.id);
  if (move.beforeId !== null && !siblings.some(n => n.id === move.beforeId)) return false;
  const index = move.beforeId === null ? siblings.length : siblings.findIndex(n => n.id === move.beforeId);
  const order = siblings.map(n => n.id); order.splice(index, 0, source.id);
  return source.parentId !== parent.id || order.some((id, i) => existing[i]?.id !== id);
}
export const labels = { group:'子目录', markdown:'文档', api:'接口' };
type TreeIconName = DocNode['type'] | 'plus' | 'edit' | 'delete' | 'chevron' | 'search';
function TreeIcon({ name }: { name: TreeIconName }) {
  return <svg className="wb-tree-svg" style={{ flexShrink: 0, verticalAlign: 'middle' }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'group' && <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />}
    {name === 'markdown' && <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></>}
    {name === 'api' && <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" /></>}
    {name === 'plus' && <path d="M12 5v14M5 12h14" />}
    {name === 'delete' && <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />}
    {name === 'edit' && <><path d="m16 3 5 5M4 15 16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L9 20l-6 1Z" /></>}
    {name === 'chevron' && <path d="m9 5 7 7-7 7" />}
    {name === 'search' && <><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></>}
  </svg>;
}

export function Tree({nodes,selected,select,add,remove,move,moveDisabled,disabled,unsavedId}: {
  nodes: DocNode[]; selected: string; unsavedId?: string; select: (node: DocNode, focus: boolean) => void;
  move: (value: NodeMove) => Promise<boolean>; moveDisabled: boolean;
  remove: (n: DocNode) => void; add: (parent: DocNode, type: DocNode['type']) => void; disabled: boolean;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const { query: filter, term: query, collapsed, dispatch } = useDirectorySearch();
  const treeId = useId();
  const dragging = useRef<string | null>(null);
  const moving = useRef(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ target: string; position: 'before' | 'after' | 'inside'; value: NodeMove } | null>(null);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const byParent = new Map<string | null, DocNode[]>();
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort(nodeOrder);
  const matches = new Set(nodes.filter(node => (node.title || '未命名').toLocaleLowerCase().includes(query)).map(node => node.id));
  const visible = new Set(matches);
  if (query) {
    for (const id of matches) {
      let parentId = byId.get(id)?.parentId;
      while (parentId != null && !visible.has(parentId)) {
        visible.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
    }
  }
  const dragBlocked = disabled || moveDisabled || Boolean(query) || !!unsavedId;
  function clearDrag() { dragging.current = null; setDragId(null); setDrop(null); }
  function destination(event: DragEvent<HTMLDivElement>, target: DocNode) {
    const id = dragging.current;
    if (!id || dragBlocked || moving.current || id === target.id) return null;
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - box.top) / box.height;
    const position = target.parentId === null ? 'inside'
      : target.type === 'group' && fraction >= .25 && fraction <= .75 ? 'inside'
      : fraction < .5 ? 'before' : 'after';
    let parentId = target.parentId, beforeId: string | null = target.id;
    if (position === 'inside') { parentId = target.id; beforeId = null; }
    else if (position === 'after') {
      const siblings = children(nodes, parentId).filter(n => n.id !== id);
      beforeId = siblings[siblings.findIndex(n => n.id === target.id) + 1]?.id ?? null;
    }
    if (parentId === null || parentId === unsavedId) return null;
    const value = { id, parentId, beforeId };
    return canMoveNode(nodes, value) ? { target: target.id, position, value } as const : null;
  }
  async function finishDrop(value: NodeMove) {
    moving.current = true;
    try {
      if (await move(value)) {
        const ids: string[] = [];
        let parent = byId.get(value.parentId);
        while (parent) { ids.push(parent.id); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
        dispatch({ type: 'expand', ids });
      }
    } finally { moving.current = false; }
  }
  const list = (parent: string | null, hidden = false) => <ul
    className={parent === null ? 'wb-tree-list' : 'wb-tree-children'}
    id={parent === null ? `${treeId}-list` : `${treeId}-children-${parent}`}
    hidden={hidden}
  >{(byParent.get(parent) ?? []).filter(node => !query || visible.has(node.id)).map(n => {
    const isGroup = n.type === 'group';
    const expanded = !collapsed.has(n.id);
    const title = n.title || '未命名';
    return <li key={n.id} className="wb-tree-item" data-type={n.type}>
      <div className="wb-row" data-node-id={n.id} data-active={selected === n.id}
        data-dragging={dragId === n.id || undefined} data-drop={drop?.target === n.id ? drop.position : undefined}
        draggable={!dragBlocked && n.parentId !== null}
        onDragStart={event => {
          if (dragBlocked || moving.current || n.parentId === null) { event.preventDefault(); return; }
          event.stopPropagation(); dragging.current = n.id; setDragId(n.id); setMenu(null);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/x-open-doc-node', n.id);
        }}
        onDragEnd={clearDrag}
        onDragOver={event => {
          event.stopPropagation(); const next = destination(event, n);
          event.dataTransfer.dropEffect = next ? 'move' : 'none';
          if (next) event.preventDefault();
          setDrop(next);
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null); }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation(); const next = destination(event, n); clearDrag();
          if (next) void finishDrop(next.value);
        }}>
        {isGroup ? <button
          type="button" className="wb-icon wb-tree-toggle"
          aria-label={`${expanded ? '折叠' : '展开'}「${title}」`}
          aria-expanded={expanded} aria-controls={`${treeId}-children-${n.id}`}
          title={`${expanded ? '折叠' : '展开'}目录`}
          disabled={disabled}
          onClick={() => {
            setMenu(null);
            dispatch({ type: 'toggle', id: n.id });
          }}
        ><span className="wb-tree-chevron" style={{ display: 'inline-flex', transform: expanded ? 'rotate(90deg)' : undefined }}><TreeIcon name="chevron" /></span></button>
          : <span className="wb-tree-spacer" aria-hidden="true" style={{ width: '1.85rem', flexShrink: 0 }} />}
        <button type="button" className="wb-link" aria-current={selected === n.id ? 'page' : undefined} disabled={disabled} onClick={() => {setMenu(null); select(n,false);}}>
          <TreeIcon name={n.type} /><span className="wb-tree-label">{title}</span>
        </button>
        {isGroup && <button type="button" className="wb-icon wb-tree-add" aria-label={`在「${n.title}」中新增`} title={unsavedId === n.id ? '请先保存目录' : `在「${n.title}」中新增`} aria-expanded={menu === n.id} aria-controls={`${treeId}-options-${n.id}`} disabled={disabled || unsavedId === n.id} onClick={() => setMenu(menu === n.id ? null : n.id)}><TreeIcon name="plus" /></button>}
        <button type="button" className="wb-icon wb-tree-edit" aria-label={`编辑「${n.title}」`} title="编辑节点" disabled={disabled} onClick={() => {setMenu(null); select(n,true);}}><TreeIcon name="edit" /></button>
        {n.parentId !== null && !byParent.has(n.id) && <button type="button" className="wb-icon wb-tree-delete" aria-label={`删除「${title}」`} title="删除节点" disabled={disabled || unsavedId === n.id} onClick={() => {setMenu(null); remove(n);}}><TreeIcon name="delete" /></button>}
      </div>
      {isGroup && <div id={`${treeId}-options-${n.id}`} hidden={menu !== n.id}>
        {menu === n.id && <div className="wb-options" role="group" aria-label="新增类型" onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setMenu(null);
            event.currentTarget.closest('li')?.querySelector<HTMLButtonElement>('.wb-tree-add')?.focus();
          }
        }}>{(['group','markdown','api'] as const).map(t => <button type="button" key={t} disabled={disabled || unsavedId === n.id} onClick={() => {
          setMenu(null);
          dispatch({ type: 'expand', ids: [n.id] });
          add(n,t);
        }}><TreeIcon name={t} />新增{labels[t]}</button>)}</div>}
      </div>}
      {isGroup && list(n.id, !expanded)}
    </li>;
  })}</ul>;
  return <nav className="wb-tree" aria-label="工作区目录">
    <DirectorySearch controls={`${treeId}-list`} value={filter} change={value=>{dispatch({ type: 'query', value });setMenu(null);}}/>
    <div className="wb-tree-filter-status" role="status">{query ? matches.size ? `找到 ${matches.size} 个匹配节点` : '没有匹配的目录或文档' : ''}</div>
    <p className="wb-tree-drag-hint" role="status">{drop ? drop.position === 'inside'
      ? `移入「${byId.get(drop.target)?.title}」末尾`
      : `移到「${byId.get(drop.target)?.title}」${drop.position === 'before' ? '之前' : '之后'}`
      : moveDisabled ? '请先保存或放弃修改，再拖动目录。'
      : query ? '清除筛选后可拖动目录。' : '拖动行排序，拖到目录中间移入。'}</p>
    {list(null)}
  </nav>;
}
