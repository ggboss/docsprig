import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useSearchParams } from 'zudoku/router';
import { contentURL, current } from './content';

type Item = { id: string; title: string; sort: number; type: 'group' | 'api' | 'markdown'; url?: URL; detailRoutes?: string[]; children: Item[] };
type Tree = { roots: Item[]; byId: Map<string, Item> };
const treePath = `${current}/tree.json`;

async function loadTree(response: Response, base: URL): Promise<Tree> {
  const data = await response.json();
  if (!Array.isArray(data?.nodes)) throw new Error('目录缺少 nodes 数组');
  const roots: Item[] = [], byId = new Map<string, Item>();
  for (const node of data.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || byId.has(node.id) ||
        typeof node.title !== 'string' || !Number.isFinite(node.sort) || !['group', 'api', 'markdown'].includes(node.type))
      throw new Error('目录节点格式错误或 ID 重复');
    if (node.detailRoutes !== undefined && (!Array.isArray(node.detailRoutes) ||
        !node.detailRoutes.every((route: unknown) => typeof route === 'string' && /^\/api\/(?:~endpoints|[\p{L}\p{N}-]+)#[\p{L}\p{N}-]+$/u.test(route))))
      throw new Error('API 详情地址无效');
    byId.set(node.id, { id: node.id, title: node.title, sort: node.sort, type: node.type, children: [], detailRoutes: node.detailRoutes,
      url: node.type === 'markdown' && typeof node.url === 'string' ? contentURL(node.url, base) : undefined });
  }
  for (const { id, parentId } of data.nodes) {
    const item = byId.get(id)!;
    if (parentId == null || parentId === '') roots.push(item);
    else {
      const parent = byId.get(parentId);
      if (parent?.type !== 'group') throw new Error('目录节点的父分组无效');
      parent.children.push(item);
    }
  }
  const order = (a: Item, b: Item) => a.sort - b.sort;
  roots.sort(order);
  const pending = [...roots];
  let reachable = 0;
  while (pending.length) {
    const item = pending.pop()!;
    reachable++;
    for (const child of item.children.sort(order)) pending.push(child);
  }
  if (reachable !== byId.size) throw new Error('目录包含循环分组');
  return { roots, byId };
}

const loadText = (response: Response) => response.text();
function useContent<T>(path: string | undefined, decode: (response: Response, base: URL) => Promise<T>) {
  const [result, setResult] = useState<{ path: string; value?: T; error?: string }>();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    async function run(key: string) {
      try {
        const url = contentURL(key, new URL(location.origin));
        const response = await fetch(url, { signal: controller.signal, mode: 'same-origin', redirect: 'error', cache: 'no-cache' });
        if (!response.ok || response.headers.get('content-type')?.toLowerCase().includes('text/html'))
          throw new Error(`无法读取 ${url.pathname}（${response.status}）`);
        const value = await decode(response, url);
        if (!controller.signal.aborted) setResult({ path: key, value });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ path: key, error: error instanceof Error ? error.message : '内容加载失败' });
      }
    }
    setResult(undefined);
    void run(path);
    return () => controller.abort();
  }, [path, decode]);
  return result?.path === path ? result : undefined;
}

export function usePublishedTree() {
  return useContent(treePath, loadTree);
}

function Branch({ items, active }: { items: Item[]; active: string | null }) {
  return <ul>{items.map(item => <li key={item.id}>
    {item.type === 'group' ? <>{item.title}{item.children.length > 0 && <Branch items={item.children} active={active} />}</> :
      <Link to={item.type === 'api' ? (item.detailRoutes?.[0] ?? '/api') : `/guides?${new URLSearchParams({ doc: item.id })}`}
        aria-current={item.type === 'markdown' && active === item.id ? 'page' : undefined}>{item.title}</Link>}
  </li>)}</ul>;
}

function Document({ item }: { item: Item }) {
  const result = useContent(item.url?.href, loadText);
  if (!item.url) return <p role="alert">此文档缺少正文地址。</p>;
  if (result?.error) return <p role="alert">{result.error}</p>;
  if (result?.value === undefined) return <p role="status">正在加载正文…</p>;
  return <article><h2>{item.title}</h2><Markdown skipHtml urlTransform={value => {
    try { return contentURL(value, item.url!).href; } catch { return undefined; }
  }}>{result.value}</Markdown></article>;
}

export default function PublishedTree({ navigationOnly = false }: { navigationOnly?: boolean }) {
  const [params] = useSearchParams();
  const id = navigationOnly ? null : params.get('doc');
  const tree = usePublishedTree();
  if (tree?.error) return <p role="alert">{tree.error}</p>;
  if (!tree?.value) return <p role="status">正在加载文档目录…</p>;
  const { roots, byId } = tree.value;
  const selected = id === null ? undefined : byId.get(id);
  return <>
    {roots.length ? <nav aria-label="发布文档目录"><Branch items={roots} active={id} /></nav> : <p>暂无已发布文档。</p>}
    {id !== null && (selected?.type === 'markdown' ? <Document key={id} item={selected} /> : <p role="alert">找不到指定的指南文档。</p>)}
  </>;
}
