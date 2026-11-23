import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'zudoku/router';
import './runtime-brand.css';

export const defaultSiteName = '文档平台';
const signalKey = 'open-docs:site-name-changed';
const validName = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && [...value.trim()].length <= 64 && !/[\p{Cc}\p{Cs}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);

export default function RuntimeBrand() {
  const { pathname } = useLocation();
  const adminPage = /^\/admin(?:\/|$)/.test(pathname);
  const [name, setName] = useState(defaultSiteName), [admin, setAdmin] = useState(false);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const channel = useRef<BroadcastChannel | null>(null);
  const refresh = useRef<() => void>(() => {});
  const generation = useRef(0), pendingSave = useRef(false);
  const knownNames = useRef(new Set([defaultSiteName]));
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    async function read() {
      if (pendingSave.current) return;
      const version = ++generation.current;
      try {
        const response = await fetch('/content/site-name.json', { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        if (alive && version === generation.current && validName(data?.name)) setName(data.name.trim());
      } catch { /* Keep the last known name when temporarily offline. */ }
    }
    async function session() {
      if (!adminPage) { setAdmin(false); setEditing(false); return; }
      try {
        const response = await fetch('/manage/session', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
        const allowed = response.ok && (await response.json()).admin === true;
        if (alive) { setAdmin(allowed); if (!allowed) setEditing(false); }
      } catch { if (alive) { setAdmin(false); setEditing(false); } }
    }
    const sync = () => { void read(); void session(); };
    refresh.current = () => { void read(); };
    const visible = () => { if (document.visibilityState === 'visible') sync(); };
    const storage = (event: StorageEvent) => { if (event.key === signalKey) void read(); };
    try {
      channel.current = new BroadcastChannel(signalKey);
      channel.current.onmessage = () => { void read(); };
    } catch { /* Storage events and focus refresh also work without BroadcastChannel. */ }
    window.addEventListener('storage', storage);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(visible, 30000);
    sync();
    return () => {
      alive = false; controller.abort(); window.clearInterval(timer);
      channel.current?.close(); channel.current = null;
      window.removeEventListener('storage', storage); window.removeEventListener('focus', sync); window.removeEventListener('pageshow', sync);
      document.removeEventListener('visibilitychange', visible);
      refresh.current = () => {};
    };
  }, [adminPage]);

  useEffect(() => {
    // Zudoku updates page titles on navigation. Preserve the page-specific prefix.
    knownNames.current.add(name);
    const apply = () => {
      const current = document.title;
      let prefix = current;
      for (const previous of [...knownNames.current].sort((a, b) => b.length - a.length)) {
        if (current === previous) { prefix = ''; break; }
        if (current.endsWith(` | ${previous}`)) { prefix = current.slice(0, -(previous.length + 3)); break; }
      }
      const next = prefix ? `${prefix} | ${name}` : name;
      if (next !== current) document.title = next;
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    apply(); return () => observer.disconnect();
  }, [name]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!adminPage || !admin || pendingSave.current) return;
    if (!validName(draft)) { setError('请输入 1–64 个字符的单行名称，不可包含控制字符或双向文本控制符。'); return; }
    pendingSave.current = true; ++generation.current; setSaving(true); setError('');
    try {
      const response = await fetch('/manage/site-name', { method: 'PUT', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: next }) });
      if (response.status === 401) { setAdmin(false); setEditing(false); setError('登录已失效，请重新登录后修改。'); return; }
      if (!response.ok) { setError(response.status === 403 ? '请求来源校验失败，请重新打开本站。' : '名称未保存，请重试。'); return; }
      const data = await response.json();
      if (!validName(data?.name)) throw Error('Invalid name response');
      setName(data.name.trim()); setEditing(false);
      try { channel.current?.postMessage('refresh'); } catch { /* Fallback below. */ }
      try { localStorage.setItem(signalKey, `${Date.now()}:${Math.random()}`); } catch { /* Focus/polling still refresh. */ }
    } catch { setError('无法确认保存结果，请检查连接后重试。'); }
    finally { pendingSave.current = false; setSaving(false); refresh.current(); }
  }
  const cancel = () => { if (!saving) { setEditing(false); setError(''); } };
  return <div className="runtime-brand">
    <a className="runtime-brand-link" href="/doc" aria-label={name} title={name}>
      <img className="runtime-brand-light" src="/logo-light.svg" alt="" aria-hidden="true" width="32" height="32" />
      <img className="runtime-brand-dark" src="/logo-dark.svg" alt="" aria-hidden="true" width="32" height="32" />
      {(!adminPage || !editing) && <span>{name}</span>}
    </a>
    {adminPage && editing ? <form className="runtime-brand-form" onSubmit={save} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }}>
      <input ref={input} aria-label="站点名称" value={draft} disabled={saving} onChange={event => setDraft(event.target.value)} />
      <button type="submit" disabled={saving || !draft.trim()}>{saving ? '保存中…' : '保存站点名称'}</button>
      <button type="button" disabled={saving} onClick={cancel}>取消</button>
    </form> : adminPage && admin && <button className="runtime-brand-edit" type="button" aria-label="编辑站点名称" title="编辑站点名称" onClick={() => { setDraft(name); setError(''); setEditing(true); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14z" /></svg>
    </button>}
    {adminPage && error && <span className="runtime-brand-error" role="alert">{error}</span>}
  </div>;
}
