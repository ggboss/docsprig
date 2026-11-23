import { useEffect, useId, useLayoutEffect, useState } from 'react';
import type { NavigationItem, NavigationPlugin } from 'zudoku';
import { useZudoku } from 'zudoku/hooks';
import { Link, useLocation, useNavigate, type RouteObject } from 'zudoku/router';

type Entry = { path: string; label: string };

// Never mount native NonTagPagesOperationList at the frame root: its implicit
// Navigate pushes history and can discard the outer page's forward history.
// PreviewNavigation resolves the index using replace; native tagged pages and
// the explicit ~endpoints / ~schemas routes remain unchanged.
export function previewRoutes(routes: RouteObject[], basePath: string): RouteObject[] {
  return routes.map(route => {
    if (!route.children) return route;
    const hasDefaultTagRoute = route.children.some(child => child.path === `${basePath}/:tag?`);
    if (!hasDefaultTagRoute) return { ...route, children: previewRoutes(route.children, basePath) };
    return {
      ...route,
      children: [
        { index: true, element: null },
        ...route.children.map(child => child.path === `${basePath}/:tag?`
          ? { ...child, path: `${basePath}/:tag` }
          : child),
      ],
    };
  });
}

// Consume native navigation rather than reimplementing tag slug counters,
// x-tagGroups, refs, or YAML/JSON parsing. Operation links stay in native pages.
export function previewEntries(items: NavigationItem[]): Entry[] {
  const entries = new Map<string, Entry>();
  const visit = (items: NavigationItem[]) => {
    for (const item of items) {
      if (item.type === 'category') {
        const link = item.link;
        const path = link?.type === 'doc' ? link.path : link?.type === 'link' ? link.to : undefined;
        if (path) entries.set(path, { path, label: item.label });
        visit(item.items.filter(child => child.type === 'category'));
      } else if (item.type === 'link' && !item.to.includes('#')) {
        entries.set(item.to, { path: item.to, label: item.label });
      }
    }
  };
  visit(items);
  return [...entries.values()];
}

export default function PreviewNavigation({ basePath, search, getNavigation }: {
  basePath: string;
  search: string;
  getNavigation: NonNullable<NavigationPlugin['getNavigation']>;
}) {
  const context = useZudoku();
  const location = useLocation();
  const navigate = useNavigate();
  const selectId = useId();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setEntries(null);
    setError(false);
    getNavigation(basePath, context).then(items => {
      if (active) setEntries(previewEntries(items));
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [basePath, context, getNavigation]);

  // Native previous/next links omit search. Restore the frame's spec identity
  // without losing any additional query keys, so reloads keep the same document.
  const params = new URLSearchParams(location.search);
  for (const [key, value] of new URLSearchParams(search)) params.set(key, value);
  const preservedSearch = params.size ? `?${params}` : '';
  const atRoot = location.pathname.replace(/\/$/, '') === basePath;
  const firstPath = entries?.[0]?.path;
  useLayoutEffect(() => {
    if (location.search !== preservedSearch || (atRoot && firstPath)) {
      navigate({
        pathname: atRoot && firstPath ? firstPath : location.pathname,
        search: preservedSearch,
        hash: location.hash,
      }, { replace: true });
    }
  }, [atRoot, firstPath, location.pathname, location.search, location.hash, preservedSearch, navigate]);

  if (error) return <p role="alert">接口分组导航加载失败，请刷新重试。</p>;
  if (entries === null) return <p role="status">正在加载接口分组…</p>;
  if (!entries.length) return <p role="status">未找到可显示的接口分组，请检查接口定义。</p>;
  const currentPath = location.pathname.replace(/\/$/, '');
  const selected = entries.find(entry => new URL(entry.path,window.location.origin).pathname === new URL(currentPath,window.location.origin).pathname)?.path ?? '';
  if (entries.length === 1 && selected) return null;
  return <nav className="preview-navigation" aria-label="接口分组">
    <style>{`
      .preview-navigation { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:0 0 16px; padding:8px 0; font:500 .8125rem/1.5 system-ui,sans-serif; }
      .preview-navigation a { max-width:100%; padding:5px 10px; border:1px solid var(--color-border,#d5dde4); border-radius:6px; color:var(--color-muted-foreground,#505f69); text-decoration:none; overflow-wrap:anywhere; }
      .preview-navigation a:hover { background:var(--color-muted,#f3f6f7); }
      .preview-navigation a[aria-current=page] { color:var(--color-foreground,CanvasText); background:var(--accent); border-color:var(--primary); }
      .preview-navigation :is(a,select):focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
      .preview-navigation label,.preview-navigation select { display:none; }
      @media(max-width:760px) {
        .preview-navigation a { display:none; }
        .preview-navigation label { display:block; }
        .preview-navigation select { display:block; flex:1; width:100%; min-width:0; padding:8px; border:1px solid var(--color-border,#d5dde4); border-radius:6px; background:var(--color-background,Canvas); color:var(--color-foreground,CanvasText); font:inherit; }
      }
    `}</style>
    <label htmlFor={selectId}>接口分组</label>
    <select id={selectId} value={selected} onChange={event => navigate({ pathname:event.target.value, search:preservedSearch })}>
      {!selected && <option value="" disabled>选择接口分组</option>}
      {entries.map(entry => <option key={entry.path} value={entry.path}>{entry.label}</option>)}
    </select>
    {entries.map(entry => <Link key={entry.path} to={{ pathname:entry.path, search:preservedSearch }} aria-current={selected === entry.path ? 'page' : undefined}>{entry.label}</Link>)}
  </nav>;
}
