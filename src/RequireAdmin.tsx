import { useEffect, useState, type ReactNode } from 'react';
import './auth.css';

export default function RequireAdmin({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false), [message, setMessage] = useState('正在检查登录状态…');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function check() {
      try {
        const response = await fetch('/manage/session', { credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
          cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
        if (response.status === 401) {
          setMessage('尚未登录或登录已失效，正在前往登录页…');
          window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`);
          return;
        }
        if (!response.ok || (await response.json()).admin !== true) throw Error('Session unavailable');
        if (!controller.signal.aborted) setReady(true);
      } catch { if (!controller.signal.aborted) setMessage('无法检查登录状态，请确认管理服务可用后重试。'); }
    }
    void check(); return () => controller.abort();
  }, [attempt]);
  if (ready) return <>{children}</>;
  return <section className="docs-auth not-prose" aria-label="管理员身份验证"><p role="status">{message}</p>
    <button onClick={() => { setMessage('正在检查登录状态…'); setAttempt(n => n + 1); }}>重新检查</button></section>;
}
