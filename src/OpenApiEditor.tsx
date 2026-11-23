import ApiConnectionEditor from './ApiConnectionEditor';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { changeAddress, inspectApi, isRecord, methods, parameterInventory, reconcilePathParameters, updateOperation, type JsonObject } from './api-editor.mjs';
import './api-editor.css';
import CompactParameter from './CompactParameter';
import SchemaEditor from './SchemaEditor';

type Props = { value: string; onChange: (value: string) => void; onValidityChange?: (valid: boolean) => void };
type Path = (string | number)[];
type Patch = (path: Path, value: unknown, remove?: boolean) => void;
type Validity = (id: string, valid: boolean) => void;

function Address({ path, method, apply, validity, canApply }: {path: string; method: string; apply: (path: string, method: string) => void; validity: Validity; canApply: (id:string)=>boolean}) {
  const id = useId(), [nextPath, setPath] = useState(path), [nextMethod, setMethod] = useState(method), [error, setError] = useState('');
  useEffect(() => { setPath(path); setMethod(method); setError(''); validity(id, true); }, [path, method, id, validity]);
  useEffect(() => () => validity(id, true), [id, validity]);
  const dirty = path !== nextPath || method !== nextMethod;
  const commit = () => {
    if (!dirty) return;
    try {
      if (!canApply(id)) throw new Error('请先修正其他字段的未完成输入，再提交请求路径或方法。');
      apply(nextPath, nextMethod); setError(''); validity(id, true); }
    catch (e) { setError(e.message); validity(id, false); }
  };
  return <div className="api-editor-address api-editor-route" onKeyDown={event=>{
    if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();commit();}
  }}><label>HTTP 方法<select value={nextMethod} onBlur={commit}
    onChange={e => {setMethod(e.target.value); setError(''); validity(id, e.target.value === method && nextPath === path);}}>{methods.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}</select></label>
    <label>请求路径<input value={nextPath} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onBlur={commit}
      onChange={e => {setPath(e.target.value); setError(''); validity(id, e.target.value === path && nextMethod === method);}}/></label>
    {error && <p id={`${id}-error`} role="alert">{error}</p>}
  </div>;
}

function Unsupported({ children }: { children?: React.ReactNode }) {
  return <span title={typeof children==='string'?children:'此字段含引用或复杂结构，请切换源码编辑。'}>需在源码编辑</span>;
}

type TabItem = {id:string;label:string;count?:number};
function Tabs({id,label,items,selected,select,disabled=false,remove,removeDisabled=false}: {id:string;label:string;items:TabItem[];selected:string;select:(id:string)=>void;disabled?:boolean;remove?:(id:string)=>void;removeDisabled?:boolean}) {
  return <div role="tablist" aria-label={label} className="api-editor-tabs">{items.map((item,index)=><div role="presentation" className="api-editor-tab-entry" key={item.id}><button type="button" role="tab"
    id={`${id}-tab-${item.id}`} aria-label={item.label} aria-selected={selected===item.id} aria-controls={`${id}-panel-${item.id}`} tabIndex={selected===item.id?0:-1}
    disabled={disabled && selected!==item.id} onClick={()=>select(item.id)} onKeyDown={event=>{
      if(disabled) return;
      const next=event.key==='ArrowRight'?(index+1)%items.length:event.key==='ArrowLeft'?(index+items.length-1)%items.length:event.key==='Home'?0:event.key==='End'?items.length-1:-1;
      if(next<0) return;event.preventDefault();select(items[next].id);document.getElementById(`${id}-tab-${items[next].id}`)?.focus();
    }}>{item.label}{item.count!==undefined && <span aria-hidden="true">{item.count}</span>}</button>{remove&&<button type="button" className="api-editor-tab-delete" aria-label={`删除响应 ${item.id}`} title={`删除响应 ${item.id}`} disabled={removeDisabled} onClick={()=>remove(item.id)}>×</button>}</div>)}</div>;
}
function Panel({id,name,selected,children}: {id:string;name:string;selected:string;children:React.ReactNode}) {
  return <div role="tabpanel" id={`${id}-panel-${name}`} aria-labelledby={`${id}-tab-${name}`} hidden={selected!==name}>{children}</div>;
}
export default function OpenApiEditor({ value, onChange, onValidityChange }: Props) {
  const info = useMemo(() => inspectApi(value), [value]);
  const [selection, setSelection] = useState(''), [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [section,setSection]=useState('parameters'),[location,setLocation]=useState('query'),[responseStatus,setResponseStatus]=useState('200');
  const [actionError,setActionError]=useState('');
  const tabsId=useId(),parameterTabs=useId(),responseTabs=useId();
  const validityCallback = useRef(onValidityChange);
  validityCallback.current = onValidityChange;
  const invalidFields = useRef<Record<string,boolean>>({});
  const parameterIds=useRef<{operation:string;ids:number[];next:number}>({operation:'',ids:[],next:0});
  const validity = useCallback<Validity>((id, fieldValid) => {
    const old = invalidFields.current;
    if (!!old[id] === !fieldValid) return;
    const next = {...old}; if (fieldValid) delete next[id]; else next[id] = true;
    invalidFields.current = next;
    validityCallback.current?.(Object.keys(next).length === 0);
    setInvalid(next);
  }, []);
  // Source-only formats are not pending local edits. Parent/backend validate source.
  const valid = Object.keys(invalid).length === 0;
  useEffect(() => {onValidityChange?.(valid);}, [valid, onValidityChange]);
  useEffect(() => () => validityCallback.current?.(true), []);
  if (!info.supported) return <div className="api-editor" role="status"><Unsupported>{info.reason} 原始内容未修改。请使用父级「源码」切换。</Unsupported></div>;
  const selected = info.operations.find(o => o.key === selection) ?? info.operations[0];
  const op = selected.operation;
  if(parameterIds.current.operation!==selected.key) parameterIds.current={operation:selected.key,ids:[],next:0};
  const parameterId=(index:number)=>parameterIds.current.ids[index]??(parameterIds.current.ids[index]=parameterIds.current.next++);
  const removeParameter=(index:number)=>{
    const next=updateOperation(value,selected.key,['parameters',index],undefined,true);
    parameterIds.current.ids.splice(index,1);
    onChange(next);
  };
  let inventory:ReturnType<typeof parameterInventory>|undefined;
  let inventoryError='';
  try{inventory=parameterInventory(value,selected.key);}catch(e){inventoryError=e.message;}
  const patch: Patch = (path, field, remove) => onChange(updateOperation(value, selected.key, path, field, remove));
  const plain = (object: unknown): object is JsonObject => isRecord(object) && !Object.hasOwn(object, '$ref');
  const stringField = (label: string, object: JsonObject, field: string, path: Path, readOnly = false) =>
    object[field] !== undefined && typeof object[field] !== 'string' ? <Unsupported/> :
    <label>{label}<input readOnly={readOnly} value={object[field] ?? ''} onChange={e => patch([...path, field], e.target.value)}/></label>;
  const media = (object: JsonObject, path: Path) => <>
    {object.content !== undefined && !plain(object.content) ? <Unsupported/> : <>
      {Object.entries(object.content ?? {}).map(([type, item]) => <fieldset key={type} className="api-editor-media"><legend className="api-editor-sr-only">{type}</legend>{!plain(item) ? <Unsupported/> : <>
        <SchemaEditor key={`${selected.key}:${JSON.stringify(path)}:${type}`} contentType={type} schema={item.schema} validity={validity}
          change={schema=>patch([...path,'content',type,'schema'],schema)}/>

      </>}</fieldset>)}
      {!Object.hasOwn(object.content ?? {}, 'application/json') && <button type="button" disabled={!valid} onClick={() => patch([...path, 'content', 'application/json'], {schema: {type: 'object'}})}>添加 JSON 内容</button>}
    </>}
  </>;
  const responseEntries=plain(op.responses)?Object.entries(op.responses).filter(([status])=>!status.startsWith('x-')):[];
  const activeResponse=responseEntries.some(([status])=>status===responseStatus)?responseStatus:responseEntries[0]?.[0]??'';
  const parameterLocations=[{id:'path',label:'Path'},{id:'query',label:'Query'},{id:'header',label:'Header'},{id:'cookie',label:'Cookie'}];
  const runAction=(action:()=>string)=>{try{onChange(action());setActionError('');}catch(e){setActionError(e.message);}};
  return <section className="api-editor" aria-label="接口结构化编辑器">
    {info.operations.length > 1 && <label>选择操作<select aria-label="选择操作" disabled={!valid} value={selected.key} onChange={e => {setSelection(e.target.value);setActionError('');}}>{info.operations.map(o => <option key={o.key} value={o.key}>{o.method.toUpperCase()} {o.path}</option>)}</select></label>}
    {!valid && <p role="alert">请完成输入或修正标出的错误后保存。</p>}
    <Address path={selected.path} method={selected.method} validity={validity} canApply={id=>Object.keys(invalidFields.current).every(key=>key===id)} apply={(path, method) => {
      const next = changeAddress(value, selected.key, path, method);
      const nextKey = info.kind === 'fragment' ? 'fragment' : JSON.stringify([path, method]);
      const addedVariables = parameterInventory(next, nextKey).variables.some(name => !inventory?.variables.includes(name) || inventory.missing.includes(name));
      setSelection(nextKey);setActionError('');onChange(next);
      if (addedVariables) { setSection('parameters'); setLocation('path'); }
    }}/>
    <div className="api-editor-grid">{stringField('接口名称（summary）', op, 'summary', [])}{stringField('操作 ID（operationId）', op, 'operationId', [])}</div>
    {op.description !== undefined && typeof op.description !== 'string' ? <Unsupported/> : <label>接口说明<textarea rows={2} value={op.description ?? ''} onChange={e => patch(['description'], e.target.value)}/></label>}
    <Tabs id={tabsId} label="接口内容" selected={section} select={setSection}
      items={[{id:'parameters',label:'参数',count:inventory?.entries.length??0},{id:'body',label:'请求体'},{id:'responses',label:'响应',count:responseEntries.length},{id:'connection',label:'服务与鉴权'}]}/>
    <Panel id={tabsId} name="connection" selected={section}><ApiConnectionEditor key={selected.key} value={value} operationKey={selected.key} onChange={onChange} validity={validity}/></Panel>
    <Panel id={tabsId} name="parameters" selected={section}>
      <Tabs id={parameterTabs} label="参数位置" items={parameterLocations.map(item=>({...item,count:(inventory?.entries.filter(e=>e.parameter?.in===item.id).length??0)+(item.id==='path'?(inventory?.missing.length??0):0)}))} selected={location} select={setLocation}/>
      {inventoryError && <Unsupported>{inventoryError}</Unsupported>}
      {inventory?.unresolved && <Unsupported>含未解析引用或复杂参数；已保留，需在源码中核对。路由补齐不会猜测或覆盖引用。</Unsupported>}
      {inventory?.entries.filter(entry=>!entry.parameter).map(entry=><div className="api-editor-readonly" key={`${entry.scope}-${entry.index}`}><code>{isRecord(entry.raw)?entry.raw.$ref??'复杂参数':'复杂参数'}</code><span>引用/复杂定义 · 原样保留</span></div>)}
      {parameterLocations.map(item=><Panel key={item.id} id={parameterTabs} name={item.id} selected={location}>
        {item.id==='path' && <>
          {inventory?.missing.map(name=><div className="api-editor-inferred" key={name}><code>{name}</code><span>文本 · 必填 · 待补齐</span></div>)}
          {!!inventory && (inventory.missing.length>0 || inventory.effective.some(e=>e.parameter?.in==='path' && e.parameter.required!==true)) && <button type="button" disabled={!valid} onClick={()=>runAction(()=>reconcilePathParameters(value,selected.key))}>补齐路径参数</button>}
          {!!inventory?.obsolete.length && <Unsupported>路由不包含这些参数：{inventory.obsolete.map(e=>e.parameter?.name).join('、')}。请显式删除操作级参数或在源码中核对继承定义。</Unsupported>}
        </>}
        <div className="cp-head"><span>名称</span><span>类型</span><span>说明</span><span>必填</span>{item.id!=='path' && Array.isArray(op.parameters??[]) && <button type="button" className="cp-icon cp-add" aria-label="添加参数" title="添加参数" disabled={!valid} onClick={()=>{
          const used=new Set((inventory?.entries??[]).filter(e=>e.parameter?.in===item.id).map(e=>e.parameter?.name));
          let name='parameter',i=1;while(used.has(name))name=`parameter${i++}`;
          patch(['parameters',(op.parameters??[]).length],{name,in:item.id,required:false,schema:{type:'string'}});
        }}>＋</button>}</div>
        {inventory?.entries.filter(entry=>entry.parameter?.in===item.id).map(entry=>{
          const parameter=entry.parameter!,index=entry.index;
          if(!entry.editable) return <div key={`${entry.scope}-${index}`} className="api-editor-readonly"><code>{parameter.name}</code><span>{entry.scope==='path'?'路径级继承':'引用参数'} · {parameter.required?'必填':'可选'} · {parameter.schema?.type??'复杂类型'}</span></div>;
          const duplicate=inventory.entries.some(other=>other.scope==='operation'&&other.index!==index&&other.parameter?.in===parameter.in&&other.parameter?.name===parameter.name);
          return <CompactParameter key={`${selected.key}:${parameterId(index)}`} p={parameter} nameError={typeof parameter.name!=='string'||!parameter.name.trim()?'参数名称不能为空':duplicate?`${item.label} 中已有 ${parameter.name}`:undefined} valid={valid} validity={validity} locked={item.id==='path' && inventory.variables.includes(parameter.name)&&!duplicate} patch={(key,v)=>patch(['parameters',index,key],v)} remove={()=>removeParameter(index)}/>;
        })}
        {item.id==='path' && !inventory?.variables.length && <p className="api-editor-empty">暂无路径参数</p>}
      </Panel>)}
      {actionError&&<p role="alert">{actionError}</p>}
    </Panel>
    <Panel id={tabsId} name="body" selected={section}>
      <fieldset className="api-editor-section"><legend className="api-editor-sr-only">请求体</legend>{op.requestBody === undefined ? <button type="button" disabled={!valid} onClick={() => patch(['requestBody'], {required:false, content:{'application/json':{schema:{type:'object'}}}})}>添加请求体</button> : !plain(op.requestBody) ? <Unsupported/> : <>
        <div className="api-editor-section-meta">{stringField('请求体说明', op.requestBody, 'description', ['requestBody'])}
        {op.requestBody.required !== undefined && typeof op.requestBody.required !== 'boolean' ? <Unsupported/> : <label className="api-editor-check"><input type="checkbox" checked={op.requestBody.required === true} onChange={e => patch(['requestBody','required'], e.target.checked)}/>请求体必填</label>}
        <button type="button" className="cp-icon" aria-label="删除请求体" title="删除请求体" disabled={!valid} onClick={()=>patch(['requestBody'],undefined,true)}>×</button></div>
        {media(op.requestBody, ['requestBody'])}
      </>}</fieldset>
    </Panel>
    <Panel id={tabsId} name="responses" selected={section}>
      {op.responses!==undefined && !plain(op.responses)?<Unsupported/>:<>
        <div className="api-editor-response-toolbar">{responseEntries.length>0 && <Tabs id={responseTabs} label="响应状态码" items={responseEntries.map(([status])=>({id:status,label:status}))} selected={activeResponse} select={setResponseStatus} removeDisabled={!valid} remove={status=>patch(['responses',status],undefined,true)}/>}<ResponseAdder responses={op.responses??{}} disabled={!valid} add={status=>{patch(['responses',status],{description:'响应说明'});setResponseStatus(status);}}/></div>
        {responseEntries.map(([status,response])=><Panel key={status} id={responseTabs} name={status} selected={activeResponse}>
          <fieldset className="api-editor-section"><legend className="api-editor-sr-only">响应 {status}</legend><div className="api-editor-section-meta">{!plain(response)?<Unsupported/>:stringField('响应说明',response,'description',['responses',status])}
</div>{plain(response)&&media(response,['responses',status])}
          </fieldset>
        </Panel>)}
      </>}
    </Panel>
  </section>;
}

function ResponseAdder({ responses, add, disabled }: {responses: JsonObject; add: (status: string) => void; disabled:boolean}) {
  const [status, setStatus] = useState('200');
  const disclosure=useRef<HTMLDetailsElement>(null);
  const valid = /^(?:[1-5][0-9]{2}|[1-5]XX|default)$/.test(status) && !Object.hasOwn(responses, status);
  return <details ref={disclosure} className="api-editor-response-add" onKeyDown={event=>{if(event.key==='Escape'&&disclosure.current){disclosure.current.open=false;disclosure.current.querySelector('summary')?.focus();}}}><summary aria-label="新增响应" title="新增响应">＋</summary><div className="api-editor-address"><label>新增响应状态码<input value={status} placeholder="201 / 400 / 4XX / default" onChange={e => setStatus(e.target.value)}/></label>
    <button type="button" disabled={!valid||disabled} onClick={() => {add(status);if(disclosure.current)disclosure.current.open=false;}}>添加响应</button></div></details>;
}
