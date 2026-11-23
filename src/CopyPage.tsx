import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {CheckIcon,CopyIcon} from 'zudoku/icons';
import './copy-page.css';

const glyph=(path:string)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path}/></svg>;
export default function CopyPage({text}:{text:()=>string}) {
  const [status,setStatus]=useState(''),[open,setOpen]=useState(false),[markdown,setMarkdown]=useState('');
  const root=useRef<HTMLDivElement>(null),toggle=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const id=useId();
  const url=new URL('/mcp/docs',window.location.origin).href,name='docsprig-public';
  const config={url};
  const cursor=`cursor://anysphere.cursor-deeplink/mcp/install?${new URLSearchParams({name,config:btoa(JSON.stringify(config))})}`;
  const vscode=`vscode:mcp/install?${encodeURIComponent(JSON.stringify({name,type:'http',url}))}`;
  useEffect(()=>{if(!status)return;const timer=setTimeout(()=>setStatus(''),2400);return ()=>clearTimeout(timer);},[status]);
  useEffect(()=>{
    if(!open)return;
    const blob=URL.createObjectURL(new Blob([text()],{type:'text/plain;charset=utf-8'}));setMarkdown(blob);
    const position=()=>{if(root.current&&menu.current){const right=root.current.getBoundingClientRect().right;menu.current.style.right=`${Math.min(0,right-menu.current.offsetWidth-12)}px`;}};
    position();window.addEventListener('resize',position);
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
    const focus=(e:FocusEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
    document.addEventListener('pointerdown',outside);document.addEventListener('focusin',focus);
    return ()=>{URL.revokeObjectURL(blob);window.removeEventListener('resize',position);document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',focus);};
  },[open]);
  async function copy(value:string){
    try{await navigator.clipboard.writeText(value);setStatus('已复制');}catch{setStatus('复制失败');}
    setOpen(false);toggle.current?.focus();
  }
  function keys(e:KeyboardEvent){
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);toggle.current?.focus();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    e.preventDefault();const items=Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')??[]);
    const current=items.indexOf(document.activeElement as HTMLElement);
    const index=e.key==='Home'?0:e.key==='End'?items.length-1:(current+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[index]?.focus();
  }
  const entry=(label:string,description:string,icon:React.ReactNode,action:()=>void)=><button role="menuitem" type="button" className="reader-menu-item" aria-label={label} onClick={action}><span className="reader-menu-icon">{icon}</span><span><strong>{label}</strong><span>{description}</span></span></button>;
  return <div className="reader-copy-group" ref={root} onKeyDown={keys}>
    <div className="reader-copy-split"><button type="button" className="reader-copy-page" aria-label="复制页面" onClick={()=>void copy(text())}>{status==='已复制'?<CheckIcon size={15}/>:<CopyIcon size={15}/>}<span aria-live="polite">{status||'复制页面'}</span></button><button ref={toggle} type="button" className="reader-copy-toggle" aria-label="更多页面操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>setOpen(v=>!v)} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();setOpen(true);}}}>{glyph(open?'m7 14 5-5 5 5':'m7 10 5 5 5-5')}</button></div>
    {open&&<div ref={menu} id={id} role="menu" aria-label="页面操作" className="reader-page-menu">
      {entry('复制页面','将页面以 Markdown 格式复制给 LLMs',<CopyIcon size={18}/>,()=>void copy(text()))}
      <a role="menuitem" className="reader-menu-item" aria-label="以 Markdown 格式查看" href={markdown||undefined} target="_blank" rel="noreferrer"><span className="reader-menu-icon">{glyph('M5 3h10l4 4v14H5z M14 3v5h5 M8 17v-5l2 3 2-3v5 M15 12v5m-1-1 1 1 1-1')}</span><span><strong>以 Markdown 格式查看 <span aria-hidden="true">↗</span></strong><span>以纯文本查看此页面</span></span></a>
      {entry('复制 MCP Server','复制 MCP Server URL 到剪贴板',glyph('m9 17 7-7a3 3 0 0 0-4-4l-8 8a5 5 0 0 0 7 7l9-9a6 6 0 0 0-9-9L3 11'),()=>void copy(url))}
      {entry('复制 MCP 配置','复制可直接粘贴的 JSON 配置',glyph('m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18'),()=>void copy(JSON.stringify({mcpServers:{[name]:config}},null,2)))}
      <a role="menuitem" className="reader-menu-item" aria-label="连接到 Cursor" href={cursor}><span className="reader-menu-icon">{glyph('m12 2 9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10')}</span><span><strong>连接到 Cursor <span aria-hidden="true">↗</span></strong><span>在 Cursor 中安装 MCP Server</span></span></a>
      <a role="menuitem" className="reader-menu-item" aria-label="连接到 VS Code" href={vscode}><span className="reader-menu-icon">{glyph('m16 3 5 2v14l-5 2-9-8-4 3V8l4 3 9-8z M16 3v18 M7 11l9 6 M7 13l9-6')}</span><span><strong>连接到 VS Code <span aria-hidden="true">↗</span></strong><span>在 VS Code 中安装 MCP Server</span></span></a>
    </div>}
  </div>;
}
