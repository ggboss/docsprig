import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './parameter-schema-tree.css';

import { composition, nullableType, editable, kind, parameterTypes, record, schemaSummary, typeLabel } from './parameter-types';
export { schemaSummary } from './parameter-types';

export type ParameterSchemaTreeProps = { schema: unknown; onChange: (schema: any) => void; disabled?: boolean; rootDisclosure?: boolean; onValidityChange?: (valid: boolean) => void };
type Dict = Record<string, unknown>;
type Change = (schema: Dict) => void;
const types = Object.keys(parameterTypes);
function Opaque({ value }: { value: unknown }) {
  return <span className="pst-opaque" title={record(value) && typeof value.$ref === 'string' ? value.$ref : composition(value) ? schemaSummary(value) : '此结构暂不支持可视化编辑'}>{record(value) && typeof value.$ref === 'string' ? '引用' : composition(value) ? schemaSummary(value) : '复杂结构'}</span>;
}
function Icon({ label, glyph, click, disabled }: { label: string; glyph: string; click: () => void; disabled?: boolean }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={click}><span aria-hidden="true">{glyph}</span></button>;
}
// Group related keywords so one confirmation describes exactly what will be lost.
const typeRules: [string, string, string[]][] = [
  ['object', '对象子字段', ['properties']],
  ['object', '必填字段设置', ['required']],
  ['object', '字段依赖规则', ['dependencies', 'dependentSchemas', 'dependentRequired']],
  ['object', '字段名称和额外字段规则', ['additionalProperties', 'patternProperties', 'propertyNames', 'unevaluatedProperties']],
  ['object', '字段数量范围', ['minProperties', 'maxProperties']],
  ['array', '数组元素定义', ['items', 'prefixItems', 'additionalItems', 'unevaluatedItems']],
  ['array', '数组长度范围约束', ['minItems', 'maxItems']],
  ['array', '数组元素匹配规则', ['contains', 'minContains', 'maxContains']],
  ['array', '数组元素唯一性要求', ['uniqueItems']],
  ['string', '文本长度范围约束', ['minLength', 'maxLength']],
  ['string', '文本匹配规则', ['pattern']],
  ['number', '数值范围约束', ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']],
  ['number', '数值倍数约束', ['multipleOf']],
];
function matchesType(value: unknown, type: string, nullable: boolean): boolean {
  if (value === null) return nullable || type === 'null';
  switch (type) {
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'object': return record(value);
    case 'array': return Array.isArray(value);
    default: return typeof value === type;
  }
}
function changeType(schema: Dict, type: string, change: Change) {
  if (type === kind(schema)) return;
  const family = type === 'integer' ? 'number' : type;
  const removed = typeRules.filter(([group, , keys]) => group !== family && keys.some(key => Object.hasOwn(schema, key)));
  const incompatible = ['enum', 'const', 'default'].filter(key => {
    if (!Object.hasOwn(schema, key)) return false;
    const values = key === 'enum' && Array.isArray(schema[key]) ? schema[key] as unknown[] : [schema[key]];
    return values.some(value => !matchesType(value, type, schema.nullable === true || nullableType(schema.type)));
  });
  const losses = [...removed.map(([, label]) => label), ...incompatible];
  if (losses.length && !window.confirm(`切换为「${typeLabel(type)}」将移除${losses.join('、')}。是否继续？`)) return;
  const next: Dict = { ...schema, type: nullableType(schema.type) && type !== 'null' ? [type, 'null'] : type };
  for (const [, , keys] of removed) for (const key of keys) delete next[key];
  for (const key of incompatible) delete next[key];
  if (type === 'array' && !Object.hasOwn(next, 'items')) next.items = { type: 'string' };
  change(next);
}
export type SchemaTypeSelectProps = Pick<ParameterSchemaTreeProps, 'schema' | 'onChange' | 'disabled'> & { label: string };
export function SchemaTypeSelect({ schema: value, onChange, label, disabled }: SchemaTypeSelectProps) {
  if (value !== undefined && !editable(value)) return <Opaque value={value}/>;
  const schema = (value ?? {}) as Dict;
  return <select disabled={disabled} aria-label={label} value={String(kind(schema))} onChange={e => changeType(schema, e.target.value, onChange)}>
    <option value="" disabled>选择类型</option>{types.map(t => <option key={t} value={t}>{typeLabel(t)}{nullableType(schema.type) && t !== 'null' ? '（可为空）' : ''}</option>)}
  </select>;
}
// A pointer elsewhere in the parameter may target any descendant's old path.
const ContainsReference = createContext(false);
function containsReference(value: unknown): boolean {
  if (!record(value)) return false;
  if (['$ref', '$dynamicRef', '$recursiveRef'].some(k => Object.hasOwn(value, k))) return true;
  // Traverse schema positions, not examples/defaults or arbitrary extension payloads.
  // A literal "$ref" property in example JSON is data, not a schema reference.
  const maps = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];
  const singles = ['additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'contentSchema'];
  const lists = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
  return maps.some(key => record(value[key]) && Object.values(value[key]).some(containsReference)) ||
    singles.some(key => containsReference(value[key])) ||
    lists.some(key => Array.isArray(value[key]) && value[key].some(containsReference)) ||
    (Array.isArray(value.items) ? value.items.some(containsReference) : containsReference(value.items));
}

const Validity = createContext<(id: string, valid: boolean) => void>(() => {});
function NameControl({ name, taken, rename }: { name: string; taken: (key: string) => boolean; rename: (key: string) => void }) {
  const [draft, setDraft] = useState(name), id = useId();
  useLayoutEffect(() => setDraft(name), [name]);
  const dirty = draft !== name;
  const error = dirty && (!draft.trim() ? '名称不能为空' : taken(draft) ? '字段名称已存在' : '');
  const report = useContext(Validity);
  const valid = !error;
  useLayoutEffect(() => { report(id, valid); }, [report, id, valid]);
  useLayoutEffect(() => () => report(id, true), [report, id]);
  const apply = () => { if (dirty && !error) rename(draft); };
  return <><input className="pst-name" aria-label={`字段名称：${name}`} value={draft} aria-invalid={!!error} aria-describedby={error ? id : undefined}
    onBlur={apply} onChange={e => setDraft(e.target.value)} onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      if (e.key === 'Escape') setDraft(name);
    }}/>
    {error && <small role="alert" id={id}>{error}</small>}</>;
}
function Description({value, label, placeholder, change}: {value:unknown; label:string; placeholder:string; change:Change}) {
  if ((value !== undefined && !editable(value) && !composition(value)) || (record(value) && value.description !== undefined && typeof value.description !== 'string')) return <span className="pst-description"/>;
  const schema=(value ?? {}) as Dict;
  return <input className="pst-description" aria-label={label} placeholder={placeholder} value={String(schema.description ?? '')}
    onChange={e=>{const next={...schema}; if(e.target.value) next.description=e.target.value; else delete next.description; change(next);}}/>;
}
function branch(depth:number) { return {'--pst-indent':`${Math.min(depth,4)*12}px`} as React.CSSProperties; }
function withRequired(schema: Dict, names: string[]): Dict {
  if (names.length) return { ...schema, required: names };
  const { required: _, ...rest } = schema;
  return rest;
}
function Fields({ schema, change, depth }: { schema: Dict; change: Change; depth:number }) {
  // Keep DOM identity across renames: blur commits before the adjacent control receives its click.
  const rowIds = useRef(new Map<string, number>());
  const nextRowId = useRef(0);
  const rowKey = (name: string) => {
    if (!rowIds.current.has(name)) rowIds.current.set(name, nextRowId.current++);
    return rowIds.current.get(name)!;
  };
  const hasReference = useContext(ContainsReference);
  const guarded = hasReference || ['dependentRequired', 'dependencies', 'dependentSchemas'].some(k => Object.hasOwn(schema, k));
  const guardMessage = '含引用或字段依赖，重命名或删除请在源码中同步修改。';
  const properties = schema.properties === undefined ? {} : schema.properties;
  const required = schema.required === undefined ? [] : schema.required;
  if (!record(properties) || !Array.isArray(required) || !required.every(n => typeof n === 'string')) return <Opaque value={schema}/>;
  const taken = (key: string) => Object.hasOwn(properties, key) || required.includes(key);
  const put = (key: string, value: Dict) => change({ ...schema, properties: { ...properties, [key]: value } });
  return <><ul>{Object.entries(properties).map(([name, value]) => {
    const checked = required.includes(name);
    return <li key={rowKey(name)}><div className="pst-row" style={branch(depth)}><div className="pst-key">
      {guarded ? <input className="pst-name" aria-label={`字段名称：${name}`} title={guardMessage} value={name} readOnly/> : <NameControl name={name} taken={taken} rename={key => {
        rowIds.current.set(key, rowKey(name));
        rowIds.current.delete(name);
        const next = { ...schema, properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k === name ? key : k, v])) };
        change(checked ? withRequired(next, required.map(n => n === name ? key : n)) : next);
      }}/>}</div>
      <SchemaTypeSelect label={`字段类型：${name}`} schema={value} onChange={v => put(name, v)}/>
      <Description label={`字段说明：${name}`} placeholder="字段说明（选填）" value={value} change={v=>put(name,v)}/>
      <input title="字段必填" aria-label={`必填：${name}`} type="checkbox" checked={checked} onChange={e => change(withRequired(schema,
        e.target.checked ? [...required, name] : required.filter(n => n !== name)))}/>
      <Icon disabled={guarded} label={`删除字段：${name}`} glyph="×" click={() => {
        rowIds.current.delete(name);
        const { [name]: _, ...remaining } = properties;
        const next = { ...schema, properties: remaining };
        change(checked ? withRequired(next, required.filter(n => n !== name)) : next);
      }}/>
    </div><Children depth={depth+1} label={name} schema={value} change={v => put(name, v)}/></li>;
  })}</ul><div className="pst-add" style={branch(depth)}><Icon label="添加字段" glyph="+" click={() => {
    let key = 'field', i = 1;
    while (taken(key)) key = `field${i++}`;
    put(key, { type: 'string' });
  }}/></div></>;
}
function Children({ schema, change, depth=1, label="根结构", disclosure=true }: { schema: unknown; change: Change; depth?:number; label?:string; disclosure?:boolean }) {
  const combined = composition(schema);
  if (combined && record(schema)) return <Combined schema={schema} mode={combined} change={change} depth={depth} label={label}/>;
  if (!editable(schema)) return null;
  let children: React.ReactNode;
  switch (kind(schema)) {
    case 'object': children = <Fields depth={depth} schema={schema} change={change}/>; break;
    case 'array': {
      const setItem = (items: Dict) => change({ ...schema, items });
      children = <ul><li><div className="pst-row pst-item" style={branch(depth)}><span className="pst-key" title="定义数组中每一项的结构，不是填写数组值"><b aria-hidden="true">[]</b> 每一项</span><SchemaTypeSelect label="数组元素类型" schema={schema.items} onChange={setItem}/><Description label="数组元素说明" placeholder="每一项的说明（选填）" value={schema.items} change={setItem}/></div>
        <Children depth={depth+1} label="每一项" schema={schema.items} change={setItem}/></li></ul>;
      break;
    }
    default: return null;
  }
  // Native disclosure hides descendants without unmounting their draft or validity state.
  if (!disclosure) return <>{children}</>;
  return <details open className="pst-branch" style={branch(depth)}>
    <summary>{label}：{schemaSummary(schema)}</summary>{children}
  </details>;
}

function Combined({schema, mode, change, depth, label}: {schema:Dict; mode:'anyOf'|'oneOf'|'allOf'; change:Change; depth:number; label:string}) {
  const variants = schema[mode] as unknown[];
  const ids = useRef<number[]>([]), nextId = useRef(0);
  while (ids.current.length < variants.length) ids.current.push(nextId.current++);
  const update = (index:number, value:Dict) => change({...schema, [mode]:variants.map((old,i)=>i===index?value:old)});
  return <details open className="pst-branch" style={branch(depth)}>
    <summary>{label}：{schemaSummary(schema)}</summary>
    <ul>{variants.map((value,index)=><li key={ids.current[index]}>
      <div className="pst-row" style={branch(depth)}>
        <span className="pst-key">结构 {index+1}</span>
        <SchemaTypeSelect label={`${label}结构 ${index+1} 类型`} schema={value} onChange={next=>update(index,next)}/>
        <Description label={`${label}结构 ${index+1} 说明`} placeholder="结构说明（选填）" value={value} change={next=>update(index,next)}/>
        <span/>
        <Icon label={`删除${label}结构 ${index+1}`} glyph="×" disabled={variants.length===1} click={()=>{
          if (!window.confirm(`删除「${label}」的结构 ${index+1}？`)) return;
          ids.current.splice(index,1);
          change({...schema,[mode]:variants.filter((_,i)=>i!==index)});
        }}/>
      </div>
      <Children schema={value} change={next=>update(index,next)} depth={depth+1} label={`结构 ${index+1}`}/>
    </li>)}</ul>
    <div className="pst-add" style={branch(depth)}><Icon label={`添加${label}结构`} glyph="+" click={()=>change({...schema,[mode]:[...variants,{type:'string'}]})}/></div>
  </details>;
}

export function ParameterSchemaTree({ schema, onChange, disabled, onValidityChange, rootDisclosure = true }: ParameterSchemaTreeProps) {
  const hasReference = useMemo(() => containsReference(schema), [schema]);
  const [invalid, setInvalid] = useState<Set<string>>(() => new Set());
  const report = useCallback((id: string, valid: boolean) => setInvalid(previous => {
    if (previous.has(id) === !valid) return previous;
    const next = new Set(previous);
    if (valid) next.delete(id); else next.add(id);
    return next;
  }), []);
  const valid = invalid.size === 0;
  useLayoutEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  if (schema === undefined || (editable(schema) && !['object', 'array'].includes(String(kind(schema))))) return null;
  return <ContainsReference.Provider value={hasReference}><Validity.Provider value={report}><fieldset className="parameter-schema-tree" aria-label="参数结构" disabled={disabled}>
    {editable(schema) || composition(schema) ? <Children schema={schema} change={onChange} disclosure={rootDisclosure}/> : <Opaque value={schema}/>}
  </fieldset></Validity.Provider></ContainsReference.Provider>;
}
export default ParameterSchemaTree;
