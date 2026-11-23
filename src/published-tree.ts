import { useEffect, useState } from 'react';
import { publishedURL } from './published-url';

export type Item = { id: string; parentId: string | null; sort: number; title: string; type: 'group' | 'markdown' | 'api'; url?: string; children: Item[]; rootId: string };
export type Tree = { roots: Item[]; byId: Map<string, Item> };
const treePath = '/content/dev/current/tree.json';

export function parsePublishedTree(data: unknown, base: string): Tree {
  const nodes = (data as { nodes?: unknown[] })?.nodes;
  if (!Array.isArray(nodes)) throw Error('发布目录格式无效');
  const byId = new Map<string, Item>(), roots: Item[] = [];
  for (const raw of nodes) {
    const n = raw as Item;
    if (!n || typeof n.id !== 'string' || !n.id || byId.has(n.id) || typeof n.title !== 'string' ||
        !Number.isFinite(n.sort) || !['group', 'markdown', 'api'].includes(n.type) ||
        !(n.parentId === null || typeof n.parentId === 'string') || (n.parentId === null && n.type !== 'group') ||
        (n.url !== undefined && typeof n.url !== 'string')) throw Error('发布目录节点格式无效');
    byId.set(n.id, { id:n.id, parentId:n.parentId, sort:n.sort, title:n.title, type:n.type,
      url:n.url ? publishedURL(n.url, base) : undefined, children:[], rootId:'' });
  }
  for (const n of byId.values()) {
    if (n.parentId === null) roots.push(n);
    else {
      const parent = byId.get(n.parentId);
      if (!parent || parent.type !== 'group') throw Error('发布目录的父分组无效');
      parent.children.push(n);
    }
  }
  const order = (a: Item, b: Item) => a.sort - b.sort || a.id.localeCompare(b.id);
  roots.sort(order);
  const pending = roots.map(n => ({ n, root:n.id }));
  let count = 0;
  while (pending.length) {
    const {n, root} = pending.pop()!;
    n.rootId = root;
    count++;
    n.children.sort(order).forEach(child => pending.push({ n:child, root }));
  }
  if (count !== byId.size) throw Error('发布目录包含循环分组');
  return { roots, byId };
}

const decodeTree = async (response: Response, base: string) => parsePublishedTree(await response.json(), base);

type Result<T> = { path: string; attempt: number; value?: T; error?: string; missing?: boolean };
export function usePublished<T>(path: string | undefined, decode: (response: Response, base: string) => Promise<T>) {
  const [attempt, retry] = useState(0), [result, setResult] = useState<Result<T>>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (path !== treePath) return;
    const revalidate = () => setRefresh(n => n + 1);
    const visible = () => { if (document.visibilityState === 'visible') revalidate(); };
    const released = (e: StorageEvent) => { if (e.key === 'open-docs:release') revalidate(); };
    window.addEventListener('focus', revalidate); document.addEventListener('visibilitychange', visible);
    window.addEventListener('storage', released);
    return () => { window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', visible); window.removeEventListener('storage', released); };
  }, [path]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let disposed = false;
    void (async () => {
      try {
        const url = publishedURL(path, window.location.href);
        const response = await fetch(url, { signal:controller.signal, mode:'same-origin', redirect:'error', cache:'no-cache', credentials:'omit' });
        if (response.status === 404) { if (!disposed) setResult({ path, attempt, missing:true }); return; }
        if (!response.ok) throw Error(`服务器暂时无法提供内容（HTTP ${response.status}）`);
        if (response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw Error('服务器返回了无效的发布内容');
        const value = await decode(response, url);
        if (!disposed) setResult({ path, attempt, value });
      } catch (error) {
        if (!disposed) setResult({ path, attempt, error:controller.signal.aborted ? '读取超时，请重试' : error instanceof Error ? error.message : '内容加载失败' });
      } finally { clearTimeout(timer); }
    })();
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [path, decode, attempt, refresh]);
  return { result:result && result.path === path && result.attempt === attempt ? result : undefined, retry:() => retry(n => n + 1) };
}

export function href(root: string, doc?: string) {
  const params = new URLSearchParams({ tab:root });
  if (doc) params.set('doc', doc);
  return `/doc?${params}`;
}
export function firstDocument(root: Item): Item | undefined {
  const pending = [...root.children].reverse();
  while (pending.length) {
    const n = pending.pop()!;
    if (n.type !== 'group') return n;
    pending.push(...[...n.children].reverse());
  }
}

export function usePublishedTree() { return usePublished(treePath, decodeTree); }
