import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { contentURL, manifest } from './content';

type Entry = { title: string; markdown: URL };
async function read(url: URL, signal: AbortSignal) {
  const response = await fetch(url, { signal, mode: 'same-origin', redirect: 'error', cache: 'no-cache' });
  if (!response.ok || response.headers.get('content-type')?.includes('text/html'))
    throw new Error(`无法读取 ${url.pathname}（${response.status}）`);
  return response;
}
function entries(data: unknown, base: URL): Entry[] {
  if (!data || typeof data !== 'object' || !('entries' in data) || !Array.isArray(data.entries))
    throw new Error('日志索引缺少 entries 数组');
  return data.entries.map(item => {
    if (!item || typeof item.title !== 'string' || typeof item.markdown !== 'string') throw new Error('日志条目格式错误');
    return { title: item.title, markdown: contentURL(item.markdown, base) };
  });
}
export default function Changelog() {
  const [items, setItems] = useState<Entry[]>();
  const [index, select] = useState(0);
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  const selected = items?.[index];
  useEffect(() => {
    const c = new AbortController(), url = new URL(manifest, location.origin);
    read(url, c.signal).then(r => r.json()).then(data => setItems(entries(data, url)))
      .catch(e => { if (!c.signal.aborted) setError(e.message) });
    return () => c.abort();
  }, []);
  useEffect(() => {
    if (!selected) return;
    const c = new AbortController();
    read(selected.markdown, c.signal).then(r => r.text()).then(value => { if (!c.signal.aborted) setText(value) })
      .catch(e => { if (!c.signal.aborted) setError(e.message) });
    return () => c.abort();
  }, [selected]);
  return <>
    {items?.length ? <label>选择日志：<select value={index} onChange={e => { setError(''); setText(undefined); select(Number(e.target.value)); }}>
      {items.map((entry, i) => <option key={i} value={i}>{entry.title}</option>)}
    </select></label> : null}
    {error ? <p role="alert">{error}</p> : items?.length === 0 ? <p>暂无更新日志。</p> : selected && text !== undefined ?
      <Markdown skipHtml urlTransform={value => { try { return contentURL(value, selected.markdown).href } catch { return undefined } }}>{text}</Markdown> : <p>正在加载日志…</p>}
  </>;
}
