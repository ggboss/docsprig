import {useEffect,useId,useState} from 'react';
import {connectionSettings,setOperationServers,setOperationAuth,isRecord,type JsonObject} from './api-editor.mjs';

type Props={value:string;operationKey:string;onChange:(value:string)=>void;validity:(id:string,valid:boolean)=>void};
function Text({label,value,commit,validity}: {label:string;value:string;commit:(value:string)=>void;validity:Props['validity']}) {
  const [draft,setDraft]=useState(value),[error,setError]=useState('');const id=useId();
  useEffect(()=>{setDraft(value);setError('');validity(id,true);},[value,id,validity]);
  useEffect(()=>()=>validity(id,true),[id,validity]);
  const apply=()=>{if(draft===value)return;try{commit(draft);setError('');validity(id,true);}catch(e){setError(e.message);validity(id,false);}};
  return <label>{label}<input aria-label={label} value={draft} aria-invalid={!!error} onChange={e=>{setDraft(e.target.value);setError('');validity(id,e.target.value===value);}} onBlur={apply} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();apply();}if(e.key==='Escape'){setDraft(value);setError('');validity(id,true);}}}/>{error&&<span role="alert">{error}</span>}</label>;
}
export default function ApiConnectionEditor({value,operationKey,onChange,validity}:Props){
  const config=connectionSettings(value,operationKey),[error,setError]=useState('');
  const run=(fn:()=>string)=>{try{onChange(fn());setError('');}catch(e){setError(e.message);}};
  const sec=config.security;
  const name=Array.isArray(sec)&&sec.length===1&&isRecord(sec[0])&&Object.keys(sec[0]).length===1?Object.keys(sec[0])[0]:undefined;
  const scheme=name?config.schemes[name]:undefined;
  const simple=isRecord(scheme)&&!scheme.$ref&&(scheme.type==='apiKey'||scheme.type==='http'&&['bearer','basic'].includes(scheme.scheme))&&Array.isArray(sec[0][name!])&&sec[0][name!].length===0;
  const mode=config.securityInherited?'inherit':Array.isArray(sec)&&sec.length===0?'none':simple?(scheme.type==='apiKey'?'apiKey':scheme.scheme):'complex';
  const edit=(field:string,next:string)=>onChange(setOperationAuth(value,operationKey,scheme.type==='apiKey'?'apiKey':scheme.scheme,{...scheme,[field]:next}));
  return <div className="api-connection-editor">
    <div className="api-connection-heading"><strong>服务地址</strong>{!config.serverInherited&&<button type="button" onClick={()=>run(()=>setOperationServers(value,operationKey,undefined))}>恢复继承</button>}<button type="button" className="cp-icon" aria-label="添加服务地址" onClick={()=>run(()=>setOperationServers(value,operationKey,[...config.servers,{url:'/'}]))}>＋</button></div>
    {Array.isArray(config.servers)&&config.servers.every(s=>isRecord(s)&&typeof s.url==='string')?config.servers.map((server,index)=><div className="api-connection-server" key={index}>
      <Text label={`服务地址 ${index+1}`} value={server.url} validity={validity} commit={url=>onChange(setOperationServers(value,operationKey,config.servers.map((s,i)=>i===index?{...s,url}:s)))}/>
      <Text label={`地址说明 ${index+1}`} value={typeof server.description==='string'?server.description:''} validity={validity} commit={description=>onChange(setOperationServers(value,operationKey,config.servers.map((s,i)=>i===index?{...s,description}:s)))}/>
      <button type="button" className="cp-icon" aria-label={`删除服务地址 ${index+1}`} disabled={config.servers.length===1} onClick={()=>run(()=>setOperationServers(value,operationKey,config.servers.filter((_,i)=>i!==index)))}>×</button>
    </div>):<p>此服务地址结构需通过源码编辑。</p>}
    <label>鉴权方式<select aria-label="鉴权方式" value={mode} onChange={e=>{
      const next=e.target.value;if(mode==='complex'&&!window.confirm('替换当前组合鉴权？原方案定义会保留。'))return;
      run(()=>setOperationAuth(value,operationKey,next,next==='apiKey'?{in:'header',name:'Authorization'}:{}));
    }}>
      <option value="inherit">继承文档配置</option><option value="none">无需鉴权</option>
      <option value="apiKey" disabled={!config.full}>API Key</option><option value="bearer" disabled={!config.full}>Bearer Token</option><option value="basic" disabled={!config.full}>Basic Auth</option>
      {mode==='complex'&&<option value="complex" disabled>组合鉴权（保留原配置）</option>}
    </select></label>
    {config.securityInherited&&<p className="api-connection-inherited">当前：{name??(Array.isArray(sec)&&!sec.length?'无需鉴权':'组合鉴权')}</p>}
    {simple&&mode!=='inherit'&&<div className="api-editor-grid">
      {scheme.type==='apiKey'&&<><label>参数位置<select aria-label="鉴权参数位置" value={scheme.in} onChange={e=>run(()=>setOperationAuth(value,operationKey,'apiKey',{...scheme,in:e.target.value}))}><option value="header">Header</option><option value="query">Query</option><option value="cookie">Cookie</option></select></label><Text label="鉴权参数名" value={scheme.name} validity={validity} commit={next=>edit('name',next)}/></>}
      {scheme.scheme==='bearer'&&<Text label="Token 格式" value={scheme.bearerFormat??''} validity={validity} commit={next=>edit('bearerFormat',next)}/>}
      <Text label="鉴权说明" value={scheme.description??''} validity={validity} commit={next=>edit('description',next)}/>
    </div>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
