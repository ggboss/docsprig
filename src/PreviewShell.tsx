import CopyPage from './CopyPage';
import { createPortal } from 'react-dom';
import { useState,useEffect } from 'react';

// The iframe isolates Zudoku's router, while its content scrolls with the outer document.
export default function PreviewShell() {
  const [headingRow,setHeadingRow]=useState<Element|null>(null);
  useEffect(() => {
    if (window.parent === window) return;
    let raf = 0, last = -1;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const main = document.querySelector('main');
        if (!main) return;
        if(location.pathname.startsWith('/api-reference')) setHeadingRow(main.querySelector('.grid > h2')?.parentElement ?? null);
        const menuBottom=document.querySelector('.reader-page-menu')?.getBoundingClientRect().bottom ?? 0;
        const height = Math.ceil(Math.max(main.getBoundingClientRect().bottom,menuBottom) + window.scrollY + 16);
        if (height !== last) {last=height;window.parent.postMessage({type:'open-docs:preview-size',height},location.origin);}
      });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(document.body);
    const mutation = new MutationObserver(measure);
    mutation.observe(document.body,{childList:true,subtree:true});
    const receive = (event:MessageEvent) => {
      if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'open-docs:preview-theme') return;
      document.documentElement.classList.toggle('dark',event.data.dark === true);
      document.documentElement.classList.toggle('light',event.data.dark !== true);
    };
    window.addEventListener('message',receive);
    window.addEventListener('resize',measure);
    document.fonts.ready.then(measure);
    measure();
    return () => {cancelAnimationFrame(raf);resize.disconnect();mutation.disconnect();window.removeEventListener('message',receive);window.removeEventListener('resize',measure);};
  },[]);
  return <>{headingRow && createPortal(<div className="reader-page-actions"><CopyPage text={()=>{
    const main=document.querySelector('main')?.cloneNode(true) as HTMLElement|undefined;
    main?.querySelectorAll('.reader-page-actions').forEach(element=>element.remove());
    return (main?.innerText || main?.textContent || '').split('\n')
      .filter(line=>!['复制页面','已复制','复制失败','复制 MCP','配置已复制'].includes(line.trim())).join('\n').trim();
  }}/></div>,headingRow)}<style>{`
    :root { --top-header-height:0px; --top-nav-height:0px; --padding-content-top:0px; }
    html,body { min-height:0; height:auto; overflow-x:clip; overflow-y:visible; overscroll-behavior:auto; }
    #root { min-height:0; display:block; }
    #root > header, #root > footer { display:none !important; }
    main { padding:0 !important; }
    main * { content-visibility:visible !important; }
    main a[href="/api-preview"], main a[href="/api-reference"] { display:none; }
    /* Native tag heading is context; the operation is the main reading title. */
    main h1 { font-size:.875rem; line-height:1.45; font-weight:600; color:var(--muted-foreground); }
    main h2 { font-size:clamp(1.8rem,2.6vw,2.35rem); line-height:1.22; letter-spacing:-.025em; overflow-wrap:anywhere; word-break:normal; }
    main h3 { font-size:1.13rem; line-height:1.5; }
    main .mb-8:has(h1) { margin-bottom:1rem; }
    /* Breakpoints apply to the iframe, not the full browser width. Keep examples
       alongside parameters on typical laptops and stacked on phones. */
    @media (min-width:840px) and (max-width:1023px) {
      main .grid:has(> h2):has(> aside) { grid-template-columns:minmax(0,4fr) minmax(0,3fr); }
      main .grid:has(> h2) > aside { grid-column:2; grid-row:3; }
    }
    main aside { min-width:0; }
    main aside > div { border-radius:.75rem; }
    main .grid:has(> .reader-page-actions) {position:relative}
    main .grid:has(> .reader-page-actions) > h2 {padding-inline-end:9rem}
    main .grid > .reader-page-actions {position:absolute;inset-inline-end:0;top:2px}
    main:has(.reader-copy-page) h2 {font-size:clamp(2rem,4.6vw,2.8rem);line-height:1.18;letter-spacing:-.045em}
    main:has(.reader-copy-page) .bg-card.shadow-xs {box-shadow:none;border-radius:0;border-width:0 0 1px;padding:1rem 0}
    main:has(.reader-copy-page) .bg-card.shadow-xs::before {display:none}
    main:has(.reader-copy-page) :has(> .bg-card.shadow-xs) {background:transparent;padding-inline:0}
    @media(max-width:600px){main .grid > .reader-page-actions{position:static;grid-column:1 / -1;justify-content:flex-start;margin-bottom:12px}main .grid:has(> .reader-page-actions) > h2{padding-inline-end:0}}
    main aside code { font-variant-ligatures:none; }
  `}</style></>;
}
