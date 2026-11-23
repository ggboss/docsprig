import { composition, kind } from './parameter-types';
import {useCallback,useEffect,useId,useState} from 'react';
import ParameterSchemaTree, {SchemaTypeSelect} from './ParameterSchemaTree';
import {isRecord,type JsonObject} from './api-editor.mjs';

type Props = {contentType?:string; schema:unknown; change:(schema:JsonObject)=>void; disabled?:boolean; validity:(id:string,valid:boolean)=>void};

/** The same schema controls are used for both request and response media. */
export default function SchemaEditor({contentType,schema,change,disabled,validity}:Props) {
  const id=useId();
  const [open,setOpen]=useState(true),[valid,setValid]=useState(true),[error,setError]=useState('');
  const report=useCallback((next:boolean)=>{setValid(next);validity(id,next);},[id,validity]);
  useEffect(()=>()=>validity(id,true),[id,validity]);
  const apply=(next:JsonObject)=>{try{change(next);setError('');}catch(e){setError(e.message);}};
  const expandable=isRecord(schema)&&(kind(schema)==='object'||kind(schema)==='array'||composition(schema)!==undefined);
  return <div className="schema-editor">
    <div className="schema-editor-toolbar">
      {expandable&&<button type="button" className="cp-icon" aria-label={open?'收起结构':'展开结构'} aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'▾':'▸'}</button>}
      {contentType&&<span className="api-editor-content-type">{contentType}</span>}<SchemaTypeSelect label="结构类型" schema={schema} disabled={disabled||!valid} onChange={next=>{apply(next);if(next.type==='object'||next.type==='array')setOpen(true);}}/>

    </div>
    <div hidden={!open}>
      {expandable&&<div className="cp-head" aria-hidden="true"><span>名称</span><span>类型</span><span>说明</span><span>必填</span></div>}
      <ParameterSchemaTree rootDisclosure={false} schema={schema} onChange={apply} disabled={disabled} onValidityChange={report}/>
    </div>
    {!open&&!valid&&<small role="alert">结构中有未完成的输入，请展开修正。</small>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
