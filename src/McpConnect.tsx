import {useEffect,useRef,useState} from 'react';
import {CheckIcon,CopyIcon} from 'zudoku/icons';
import './copy-page.css';
import './mcp-connect.css';

type Connection={config:{mcpServers:Record<string,{url:string;headers?:Record<string,string>}>}};
export default function McpConnect({admin=false}:{admin?:boolean}) {
  const [status,setStatus]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const active=useRef(true);
  useEffect(()=>{active.current=true;return ()=>{active.current=false;};},[]);
  useEffect(()=>{if(!status)return;const timer=setTimeout(()=>setStatus(''),2400);return ()=>clearTimeout(timer);},[status]);
  async function copy(){
    if(busy)return;setBusy(true);setError('');
    try{
      let connection:Connection;
      if(admin){
        const response=await fetch('/manage/mcp-config',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:'{}'});
        if(!response.ok)throw Error(response.status===401?'登录已失效，请重新登录。':response.status===503?'管理员 MCP 尚未启用。':'MCP 配置加载失败，请重试。');
        connection=await response.json();
      }else{
        connection={config:{mcpServers:{'docsprig-public':{url:new URL('/mcp/docs',window.location.origin).href}}}};
      }
      if(!active.current)return;
      await navigator.clipboard.writeText(JSON.stringify(connection.config,null,2));
      if(active.current)setStatus('配置已复制');
    }catch(e){
      const message=e instanceof Error&&(e.message.includes('MCP')||e.message.includes('登录'))?e.message:'复制失败，请检查浏览器剪贴板权限后重试。';
      if(active.current)setError(message);
    }
    finally{if(active.current)setBusy(false);}
  }
  return <span className="mcp-copy"><button type="button" className="reader-copy-page" aria-label={admin?'复制管理员 MCP':'复制 MCP'} title={admin?'复制管理员 MCP 配置（含凭证，请勿分享）':'复制只读文档 MCP 配置'} disabled={busy} onClick={()=>void copy()}>{status?<CheckIcon size={15}/>:<CopyIcon size={15}/>}<span aria-live="polite">{busy?'复制中…':status||'复制 MCP'}</span></button>{error&&<span role="alert" className="mcp-copy-error">{error}</span>}</span>;
}
