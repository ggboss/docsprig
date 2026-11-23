import {useCallback,useId,useLayoutEffect,useRef,useState} from 'react';
import ParameterSchemaTree,{SchemaTypeSelect} from './ParameterSchemaTree';
import {isRecord,type JsonObject} from './api-editor.mjs';

export default function CompactParameter({p,locked,valid,patch,remove,validity,nameError}:{p:JsonObject;locked:boolean;valid:boolean;patch:(key:string,v:unknown)=>void;remove:()=>void;validity:(id:string,v:boolean)=>void;nameError?:string}) {
  const [open,setOpen]=useState(false),[opened,setOpened]=useState(false),[treeValid,setTreeValid]=useState(true),id=useId();
  const validityRef=useRef(validity);
  validityRef.current=validity;
  const nameId=`${id}:name`,treeId=`${id}:tree`,errorId=`${id}-name-error`;
  const error=nameError || (typeof p.name!=='string'||!p.name.trim()?'参数名称不能为空':'');
  // Independent registrations prevent a valid subtree from clearing a name error.
  useLayoutEffect(()=>{validityRef.current(nameId,!error);},[nameId,error]);
  useLayoutEffect(()=>()=>{validityRef.current(nameId,true);validityRef.current(treeId,true);},[nameId,treeId]);
  const report=useCallback((ok:boolean)=>{setTreeValid(ok);validityRef.current(treeId,ok);},[treeId]);
  const s=p.schema===undefined?{}:p.schema;
  const type=isRecord(s)?s.type??(s.properties!==undefined?'object':s.items!==undefined?'array':''):'';
  const tree=p.content===undefined&&(type==='object'||type==='array');
  return <div className="compact-param"><div className="api-editor-param-row"><div className="cp-name">
    {tree&&<button type="button" className="cp-icon" aria-label={open?'收起参数结构':'展开参数结构'} aria-expanded={open}
      disabled={open&&!treeValid} onClick={()=>{setOpened(true);setOpen(!open);}}>{open?'▾':'▸'}</button>}
    <input aria-label="参数名称" value={p.name??''} readOnly={locked} aria-invalid={!!error} aria-describedby={error?errorId:undefined}
      onChange={e=>patch('name',e.target.value)}/>{error&&<small role="alert" id={errorId}>{error}</small>}</div>
    {p.content===undefined?<SchemaTypeSelect schema={s} label="参数类型" disabled={!valid||!treeValid||!!error} onChange={schema=>{
      patch('schema',schema);
      const nextType=isRecord(schema)?schema.type:undefined;
      const expand=nextType==='object'||nextType==='array';
      if(expand)setOpened(true);
      setOpen(expand);
    }}/>:<span title="请在源码中编辑此参数">自定义</span>}
    <input className="cp-desc" aria-label="参数说明" placeholder="说明（选填）" value={typeof p.description==='string'?p.description:''} readOnly={p.description!==undefined&&typeof p.description!=='string'} onChange={e=>patch('description',e.target.value)}/><input aria-label="必填" title="必填" type="checkbox" checked={p.required===true} disabled={p.in==='path'||(p.required!==undefined&&typeof p.required!=='boolean')} onChange={e=>patch('required',e.target.checked)}/>
    <button className="cp-icon" type="button" aria-label={`删除参数 ${p.name}`} title={locked?'由请求路径定义':'删除参数'} disabled={!valid||locked} onClick={remove}>×</button></div>

    {/* Keep local subtree buffers and validity registered while collapsed or in a hidden tab. */}
    {tree&&opened&&<div hidden={!open}><ParameterSchemaTree schema={s} rootDisclosure={false} onValidityChange={report} onChange={(v:unknown)=>patch('schema',v)}/></div>}
  </div>;
}
