import { useState, type FormEvent } from 'react';
import './auth.css';
import { LoginTabs } from './PublicTabs';

export function adminDestination(value: string | null) {
  if (!value || !/^\/admin(?:[/?#]|$)/.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) return '/admin';
  const url = new URL(value, 'http://local.invalid');
  return url.origin === 'http://local.invalid' && (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
    ? `${url.pathname}${url.search}${url.hash}` : '/admin';
}
export default function Login() {
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/manage/login', { method: 'POST', credentials: 'same-origin', mode: 'same-origin',
        redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }) });
      if (!response.ok) {
        setError(response.status === 401 ? '账号或密码错误，请重新输入。' : response.status === 403 ? '请求来源校验失败，请从本站重新打开登录页。' : '暂时无法登录，请稍后重试。');
        return;
      }
      const data = await response.json();
      if (data.admin !== true) throw Error('Invalid session response');
      window.location.replace(adminDestination(new URLSearchParams(window.location.search).get('next')));
    } catch { setError('无法连接文档管理服务，请稍后重试。'); }
    finally { setBusy(false); }
  }
  return <section className="docs-auth not-prose" aria-labelledby="login-title">
    <LoginTabs />
    <h1 id="login-title">登录文档管理</h1><p>请输入本站管理员账号和密码。</p>
    <form onSubmit={submit}>
      <label htmlFor="admin-username">账号</label>
      <input id="admin-username" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} disabled={busy} />
      <label htmlFor="admin-password">密码</label>
      <input id="admin-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} disabled={busy} />
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
    </form>
  </section>;
}
