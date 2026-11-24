import CopyPage from './CopyPage';
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReaderLayout from './ReaderLayout';
import MarkdownBody from './MarkdownBody';
import { firstDocument, href, usePublished, usePublishedTree, type Item, type Tree } from './published-tree';
import PublicTabs from './PublicTabs';
import { ChevronRightIcon, FileTextIcon } from 'zudoku/icons';
import { useDirectorySearch } from './useDirectorySearch';
import { DirectorySearch } from './DirectoryControls';
import { Link, useLocation, useNavigate, useSearchParams } from 'zudoku/router';
import ApiReference from './ApiReference';
import './portal.css';

const decodeText = (response: Response) => response.text();

function Branch({ items, selected, visible, collapsed, toggle }: {
  items: Item[]; selected?: string; visible: Set<string> | null; collapsed: Set<string>; toggle: (id: string) => void;
}) {
  return <ul>{items.filter(n => !visible || visible.has(n.id)).map(n => {
    const open = !collapsed.has(n.id);
    return <li key={n.id}>
      {n.type === 'group' ? <>
        <button className="portal-group" type="button" aria-expanded={open} onClick={() => toggle(n.id)}>
          <span title={n.title}>{n.title}</span><ChevronRightIcon className="portal-chevron" size={16} aria-hidden="true" />
        </button>
        {open && n.children.length > 0 && <Branch items={n.children} selected={selected} visible={visible} collapsed={collapsed} toggle={toggle} />}
      </> : <Link className="portal-tree-link" to={href(n.rootId, n.id)} aria-current={selected === n.id ? 'page' : undefined}>
        {n.type === 'api' ? <small className="portal-api-mark" aria-hidden="true">API</small> : <FileTextIcon size={15} aria-hidden="true" />}<span title={n.title}>{n.title}</span>
      </Link>}
    </li>;
  })}</ul>;
}

function Directory({ root, selected, tree }: { root: Item; selected?: string; tree: Tree }) {
  const { query, term, collapsed, dispatch } = useDirectorySearch();
  useEffect(() => {
    const ids: string[] = [];
    let item = selected ? tree.byId.get(selected) : undefined;
    while (item?.parentId) { ids.push(item.parentId); item = tree.byId.get(item.parentId); }
    dispatch({ type: 'expand', ids });
  }, [selected, tree, dispatch]);
  const visible = useMemo(() => {
    if (!term) return null;
    const matches = new Set<string>();
    for (const n of tree.byId.values()) {
      if (n.rootId !== root.id || !n.title.toLocaleLowerCase().includes(term)) continue;
      // A matching group reveals its complete subtree, while ancestors retain context.
      const pending = [n];
      while (pending.length) { const item = pending.pop()!; matches.add(item.id); pending.push(...item.children); }
      let parent: string | null | undefined = n.parentId;
      while (parent) { matches.add(parent); parent = tree.byId.get(parent)?.parentId; }
    }
    return matches;
  }, [term, root, tree]);
  return <aside className="portal-sidebar not-prose" aria-label={`${root.title}目录`}>
    <DirectorySearch value={query} change={value => dispatch({ type: 'query', value })}/>
    <nav aria-label="当前栏目文档目录"><Branch items={root.children} selected={selected} visible={visible} collapsed={collapsed}
      toggle={id => dispatch({ type: 'toggle', id })} /></nav>
    {!root.children.length && <p className="portal-muted">此栏目暂无已发布文档。</p>}
    {visible && !root.children.some(n => visible.has(n.id)) && <p className="portal-muted" role="status">没有匹配的目录或文档。</p>}
  </aside>;
}

class RenderBoundary extends Component<{ children:ReactNode; retry:() => void }, { failed:boolean }> {
  state = { failed:false };
  static getDerivedStateFromError() { return { failed:true }; }
  render() { return this.state.failed ? <Notice title="文档暂时无法显示" retry={this.props.retry}>请重新加载此文档。</Notice> : this.props.children; }
}
function Notice({ title, children, retry }: { title:string; children?:ReactNode; retry?:() => void }) {
  return <div className="portal-notice" role={retry ? 'alert' : 'status'}><h2>{title}</h2>{children && <p>{children}</p>}{retry && <button type="button" onClick={retry}>重新加载</button>}</div>;
}
function Document({ item }: { item: Item }) {
  const {result, retry} = usePublished(item.url, decodeText);
  const [renderVersion, setRenderVersion] = useState(0);
  if (!item.url) return <Notice title="文档地址暂不可用">该文档尚未提供可读取的发布内容。</Notice>;
  if (result?.missing) return <Notice title="发布内容不存在" retry={retry}>此文档可能已更新，请重新加载或选择其他文档。</Notice>;
  if (result?.error) return <Notice title="正文加载失败" retry={retry}>{result.error}</Notice>;
  if (!result || result.value === undefined) return <Notice title="正在加载正文…" />;
  return <RenderBoundary key={renderVersion} retry={() => { setRenderVersion(v => v + 1); retry(); }}>
    {item.type === 'api' ? <ApiReference spec={item.url} title={item.title} /> : <article className="portal-markdown prose dark:prose-invert">
      <div className="reader-heading"><h1>{item.title}</h1><div className="reader-page-actions"><CopyPage text={()=>result.value ?? ''}/></div></div>
      {result.value.trim() ? <MarkdownBody base={item.url}>{result.value}</MarkdownBody> : <p className="portal-muted">此文档暂无正文。</p>}
    </article>}
  </RenderBoundary>;
}

export default function Portal() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const initialSearch = useRef({ value:params.toString(), pending:true });
  const {result, retry} = usePublishedTree();
  const tree = result?.value;
  const requestedTab = params.get('tab'), requestedDoc = params.get('doc');
  const linked = requestedDoc ? tree?.byId.get(requestedDoc) : undefined;
  const root = requestedTab !== null ? tree?.roots.find(n => n.id === requestedTab) : tree?.roots.find(n => n.id === linked?.rootId) ?? tree?.roots[0];
  const selected = requestedDoc !== null ? (linked?.rootId === root?.id ? linked : undefined) : root && firstDocument(root);
  useEffect(() => {
    if (!tree || !initialSearch.current.pending) return;
    initialSearch.current.pending = false;
    // Resolve defaults only for the initial URL. A later POP or an in-flight
    // navigation must never trigger a normalization write to browser history.
    if (!root || params.toString() !== initialSearch.current.value ||
        requestedTab !== null && requestedDoc !== null) return;
    const next = new URLSearchParams(params);
    next.set('tab', root.id);
    if (requestedDoc === null && selected) next.set('doc', selected.id);
    if (next.toString() !== params.toString()) navigate({ pathname:'/doc', search:`?${next}`, hash }, {replace:true});
  }, [tree, root, selected, requestedTab, requestedDoc, params, hash, navigate]);
  return <section className="portal not-prose" aria-label="已发布文档">
    <PublicTabs roots={tree?.roots} active={root?.id} />
    {!result ? <Notice title="正在加载文档目录…" /> : result.error ? <Notice title="目录加载失败" retry={retry}>{result.error}</Notice> : result.missing || !tree?.roots.length ?
      <Notice title="暂无已发布内容" retry={retry}>内容发布后将在此显示。</Notice> : !root ? <Notice title="找不到指定栏目"><Link to="/doc">返回文档首页</Link></Notice> :
      <ReaderLayout docKey={`${selected?.id}:${selected?.url}`} directory={<Directory key={root.id} root={root} selected={selected?.id} tree={tree} />}>
          {requestedDoc !== null && !selected ? <Notice title="找不到指定文档">请选择当前栏目中的已发布文档。</Notice> : selected?.type === 'group' ?
            <><h1 className="portal-title">{selected.title}</h1><nav className="portal-child-links" aria-label="分组文档">{selected.children.map(n => <Link key={n.id} to={href(root.id, n.id)}>{n.title}<span aria-hidden="true">→</span></Link>)}</nav>{!selected.children.length && <Notice title="此目录暂无已发布文档" />}</> : selected ?
            <Document key={`${selected.id}:${selected.url}`} item={selected} /> : <Notice title="此栏目暂无已发布文档">请选择其他栏目浏览。</Notice>}
      </ReaderLayout>}
  </section>;
}
