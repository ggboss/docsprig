import { parseDocument, isAlias, visit } from 'yaml';

export const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function document(source) {
  const doc = parseDocument(source, { uniqueKeys: true, stringKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('YAML/JSON 无法安全解析，请切换源码检查格式。');
  visit(doc, { Node(_, node) { if (isAlias(node)) throw new Error('含 YAML 别名，请使用源码编辑。'); } });
  const data = doc.toJS({ maxAliasCount: 0 });
  if (!isRecord(data)) throw new Error('接口定义必须是对象，请使用源码编辑。');
  return { doc, data };
}

/** Inspection never rewrites the input, including unsupported contracts. */
export function inspectApi(source) {
  try {
    const { data } = document(source);
    if (own(data, 'openapi')) {
      if (typeof data.openapi !== 'string' || !/^3\.[01]\.\d+$/.test(data.openapi) || !isRecord(data.paths))
        throw new Error('当前结构化编辑支持 OpenAPI 3.0/3.1 paths；其他格式请使用源码。');
      const operations = [];
      for (const [path, item] of Object.entries(data.paths)) {
        if (path.startsWith('x-')) continue;
        if (!path.startsWith('/') || !isRecord(item) || own(item, '$ref'))
          throw new Error('含引用或不支持的路径项，请使用源码编辑。');
        for (const method of methods) if (own(item, method)) {
          if (!isRecord(item[method]) || own(item[method], '$ref')) throw new Error('操作格式不支持结构化编辑，请使用源码。');
          operations.push({ path, method, operation: item[method], key: JSON.stringify([path, method]) });
        }
      }
      if (!operations.length) throw new Error('未找到可编辑操作，请在源码中添加 paths 和 HTTP 方法。');
      return { supported: true, kind: 'document', data, operations, version: data.openapi };
    }
    if (own(data, 'swagger') || typeof data.path !== 'string' || !data.path.startsWith('/') ||
        typeof data.method !== 'string' || !methods.includes(data.method.toLowerCase()) || !isRecord(data.operation) || own(data.operation, '$ref'))
      throw new Error('需要 path、method、operation 操作片段或完整 OpenAPI 文档，请使用源码。');
    return { supported: true, kind: 'fragment', data, operations: [{ path: data.path, method: data.method.toLowerCase(), operation: data.operation, key: 'fragment' }] };
  } catch (error) { return { supported: false, reason: error.message }; }
}

function context(source, key) {
  const info = inspectApi(source);
  if (!info.supported) throw new Error(info.reason);
  const selected = info.operations.find(op => op.key === key);
  if (!selected) throw new Error('选中的操作已变化，请重新选择。');
  return { ...document(source), info, selected,
    prefix: info.kind === 'fragment' ? ['operation'] : ['paths', selected.path, selected.method] };
}

/** Patch only the requested AST path; unknown keys and untouched YAML comments survive. */
export function updateOperation(source, key, path, value, remove = false) {
  const { doc, selected, prefix } = context(source, key);
  if (!path.length) throw new Error('不能替换整个操作。');
  let parent = selected.operation;
  for (let i = 0; i < path.length - 1; i++) {
    if (parent === undefined) break;
    if ((!isRecord(parent) && !Array.isArray(parent)) || own(parent, '$ref')) throw new Error('此字段包含引用或复杂结构，请使用源码。');
    parent = own(parent, path[i]) ? parent[path[i]] : undefined;
  }
  if (parent !== undefined && ((!isRecord(parent) && !Array.isArray(parent)) || own(parent, '$ref')))
    throw new Error('此字段包含引用或复杂结构，请使用源码。');
  const target = [...prefix, ...path];
  if (remove) doc.deleteIn(target); else doc.setIn(target, value);
  return doc.toString();
}

export function changeAddress(source, key, path, method) {
  const { doc, data, info, selected } = context(source, key);
  if (path === selected.path && method === selected.method) return source;
  routeVariables(path);
  if (!/^\/[^\s?#]*$/.test(path)) throw new Error('路径须以 / 开头，且不能含空白、查询参数或锚点。');
  if (!methods.includes(method)) throw new Error('不支持的 HTTP 方法。');
  if (info.kind === 'document') {
    const moved = path !== selected.path ? ['paths', selected.path] : ['paths', selected.path, selected.method];
    const pending = [data];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      for (const [name, child] of Object.entries(value)) {
        if (['$ref','operationRef'].includes(name) && typeof child === 'string' && child.startsWith('#/')) {
          let pointer;
          try { pointer = decodeURIComponent(child.slice(2)).split('/').map(part => part.replace(/~1/g,'/').replace(/~0/g,'~')); }
          catch { continue; }
          if (moved.every((part, index) => pointer[index] === part))
            throw new Error('路由或方法被本地引用使用，请在源码中同步修改引用；未修改原内容。');
        }
        pending.push(child);
      }
    }
  }
  if (info.kind === 'fragment') {
    doc.set('path', path); doc.set('method', method);
  } else if (path !== selected.path) {
    const item = data.paths[selected.path];
    if (methods.filter(m => own(item, m)).length !== 1)
      throw new Error('此路径包含多个操作；为保留共享参数，请在源码中移动路径。');
    if (own(data.paths, path)) throw new Error('目标路径已存在，请在源码中合并，避免覆盖。');
    // Move the entire path item, retaining path-level parameters, servers and extensions.
    const pathNode = doc.getIn(['paths', selected.path], true);
    doc.deleteIn(['paths', selected.path]); doc.setIn(['paths', path], pathNode);
    if (method !== selected.method) {
      const operation = doc.getIn(['paths', path, selected.method], true);
      doc.deleteIn(['paths', path, selected.method]); doc.setIn(['paths', path, method], operation);
    }
  } else if (method !== selected.method) {
    if (own(data.paths[path], method)) throw new Error('目标 HTTP 方法已存在，不能覆盖。');
    const operation = doc.getIn(['paths', path, selected.method], true);
    doc.deleteIn(['paths', path, selected.method]); doc.setIn(['paths', path, method], operation);
  }
  const nextKey = info.kind === 'fragment' ? 'fragment' : JSON.stringify([path,method]);
  // Committing an edited address (including on blur) reconciles once; opening is read-only.
  return reconcilePathParameters(doc.toString(),nextKey);
}

export function parseJsonField(text, kind = 'example', version = '3.1.0') {
  if (!text.trim()) return { remove: true };
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('JSON 尚未完成或格式错误；请修正后保存。'); }
  if (kind === 'schema' && !(isRecord(value) || (version.startsWith('3.1.') && typeof value === 'boolean')))
    throw new Error(version.startsWith('3.0.') ? 'OpenAPI 3.0 schema 必须是对象，不会自动转换为 3.1。' : 'schema 必须是对象或布尔值。');
  if (kind === 'examples' && !isRecord(value)) throw new Error('命名示例必须是 JSON 对象。');
  return { value, remove: false };
}

export function simpleObjectSchema(schema) {
  return isRecord(schema) && !['$ref','allOf','anyOf','oneOf','not','if','then','else','patternProperties','dependentSchemas'].some(key => own(schema,key)) &&
    (schema.type === 'object' || (schema.type === undefined && isRecord(schema.properties))) &&
    (schema.properties === undefined || isRecord(schema.properties)) &&
    (schema.required === undefined || (Array.isArray(schema.required) && schema.required.every(name => typeof name === 'string')));
}

/** Rename in one update, including required names, without dropping schema extensions. */
export function renameSchemaProperty(source, key, schemaPath, from, to) {
  const {doc, prefix, selected} = context(source,key);
  let schema = selected.operation;
  for (const part of schemaPath) schema = schema?.[part];
  if (!simpleObjectSchema(schema) || !own(schema.properties ?? {},from)) throw new Error('请使用高级 schema 编辑此字段。');
  if (!to.trim()) throw new Error('字段名称不能为空。');
  if (from === to) return source;
  if (own(schema.properties,to)) throw new Error('字段名称已存在，不能覆盖。');
  // Dependencies and local JSON pointers may mention the old property name.
  // Preserve correctness by requiring explicit source edits rather than guessing.
  if (JSON.stringify(schema).includes('"$ref"') || own(schema,'dependentRequired') || own(schema,'dependencies'))
    throw new Error('此结构含引用或字段依赖，请在源码中同步重命名。');
  const at=[...prefix,...schemaPath];
  const field=doc.getIn([...at,'properties',from],true);
  doc.deleteIn([...at,'properties',from]);doc.setIn([...at,'properties',to],field);
  if (schema.required) doc.setIn([...at,'required'],schema.required.map(name=>name===from?to:name));
  return doc.toString();
}

export function routeVariables(path) {
  const variables = [...path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
  if (/[{}]/.test(path.replace(/\{[^{}]+\}/g,'')) || variables.some(name => /[\s/]/.test(name)))
    throw new Error('路径变量须使用 {name}，名称不能包含空白或斜杠。');
  return [...new Set(variables)];
}

function resolveParameter(data, value, visited = new Set()) {
  if (!isRecord(value)) return null;
  if (!own(value,'$ref')) return value;
  const ref=value.$ref;
  if (typeof ref!=='string' || !ref.startsWith('#/') || visited.has(ref)) return null;
  visited.add(ref);
  let target=data;
  for (const part of ref.slice(2).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))) {
    if (!isRecord(target) || !own(target,part)) return null;
    target=target[part];
  }
  return resolveParameter(data,target,visited);
}

/** Read-only inventory: inferred rows never change source or mark a draft dirty. */
export function parameterInventory(source,key) {
  const {data,info,selected}=context(source,key);
  const inherited=info.kind==='document' ? data.paths[selected.path].parameters : undefined;
  const entries=[]; let unresolved=false;
  for (const [scope,list] of [['path',inherited],['operation',selected.operation.parameters]]) {
    if (list===undefined) continue;
    if (!Array.isArray(list)) {unresolved=true;continue;}
    list.forEach((raw,index)=>{
      const parameter=resolveParameter(data,raw);
      if (!parameter || typeof parameter.name!=='string' || !['path','query','header','cookie'].includes(parameter.in)) unresolved=true;
      entries.push({scope,index,raw,parameter,editable:scope==='operation' && isRecord(raw) && !own(raw,'$ref')});
    });
  }
  const effective=entries.filter(entry=>entry.scope==='operation' || !entries.some(other=>other.scope==='operation' && other.parameter && entry.parameter && other.parameter.name===entry.parameter.name && other.parameter.in===entry.parameter.in));
  const variables=routeVariables(selected.path);
  return {variables,entries,effective,unresolved,
    missing:variables.filter(name=>!effective.some(entry=>entry.parameter?.in==='path' && entry.parameter.name===name)),
    obsolete:effective.filter(entry=>entry.parameter?.in==='path' && !variables.includes(entry.parameter.name))};
}

export function reconcilePathParameters(source,key) {
  const inventory=parameterInventory(source,key);
  if (inventory.unresolved) throw new Error('参数含未解析引用或复杂结构，请在源码中核对 Path 参数；未修改原内容。');
  const identities = new Set();
  for (const entry of inventory.entries.filter(entry => entry.parameter?.in === 'path')) {
    const identity = JSON.stringify([entry.scope, entry.parameter.name]);
    if (identities.has(identity)) throw new Error(`同一层级存在重复的 Path 参数 ${entry.parameter.name}，请在源码中处理冲突；未修改原内容。`);
    identities.add(identity);
  }
  if (inventory.obsolete.length) throw new Error(`路由已不包含 Path 参数 ${inventory.obsolete.map(e=>e.parameter.name).join('、')}；请先显式删除或在源码中同步修改，不会自动丢弃。`);
  const {doc,prefix,selected}=context(source,key);
  let changed=false;
  for(const entry of inventory.effective.filter(e=>e.parameter?.in==='path')) {
    if (entry.parameter.required===true) continue;
    if (!entry.editable) throw new Error('继承或引用的 Path 参数不是必填，请在源码中修改其定义。');
    doc.setIn([...prefix,'parameters',entry.index,'required'],true); changed=true;
  }
  let index=selected.operation.parameters?.length ?? 0;
  for(const name of inventory.missing) doc.setIn([...prefix,'parameters',index++],{name,in:'path',required:true,schema:{type:'string'}});
  return changed || inventory.missing.length ? doc.toString() : source;
}

export function inferSchemaFromExample(example,version='3.1.0',depth=0) {
  if(depth>12) throw new Error('示例嵌套过深，请使用高级 schema。');
  if(example===null) return version.startsWith('3.0.') ? {nullable:true} : {type:'null'};
  if(Array.isArray(example)) {
    const variants=[...new Map(example.map(value=>{const schema=inferSchemaFromExample(value,version,depth+1);return [JSON.stringify(schema),schema];})).values()];
    return {type:'array',items:variants.length===1?variants[0]:variants.length?{anyOf:variants}:{}};
  }
  if(isRecord(example)) return {type:'object',properties:Object.fromEntries(Object.entries(example).map(([name,value])=>[name,inferSchemaFromExample(value,version,depth+1)]))};
  return {type:typeof example==='number' ? Number.isInteger(example)?'integer':'number' : typeof example};
}

/** Add missing inferred structure only; never replace existing constraints or extensions. */
export function schemaFromExample(existing,example,version='3.1.0') {
  const inferred=inferSchemaFromExample(example,version);
  function merge(old,next) {
    if(old===undefined) return next;
    if(!isRecord(old) || ['$ref','allOf','anyOf','oneOf','not','if','then','else'].some(key=>own(old,key)))
      throw new Error('已有复杂 schema 或引用，请在高级编辑中处理；未覆盖原结构。');
    if(old.type!==undefined && next.type!==undefined && old.type!==next.type && !(old.type==='number' && next.type==='integer'))
      throw new Error('示例与已有字段类型不同；请先核对类型，未覆盖原结构。');
    const result={...next,...old};
    if(next.properties) {
      if(old.properties!==undefined && !isRecord(old.properties)) throw new Error('已有 properties 格式不支持，未覆盖原结构。');
      result.properties={...old.properties};
      for(const [name,property] of Object.entries(next.properties)) Object.defineProperty(result.properties,name,{value:merge(old.properties && own(old.properties,name)?old.properties[name]:undefined,property),enumerable:true,writable:true,configurable:true});
    }
    if(next.items && old.items===undefined) result.items=next.items;
    return result;
  }
  return merge(existing,inferred);
}

/** Resolve visible connection settings without materializing inherited values. */
export function connectionSettings(source, key) {
  const {info, data, selected} = context(source,key);
  const pathItem=info.kind==='document'?data.paths[selected.path]:{};
  return {servers:selected.operation.servers ?? pathItem.servers ?? data.servers ?? [{url:'/'}],
    serverInherited:!own(selected.operation,'servers'),
    security:selected.operation.security ?? data.security ?? [],
    securityInherited:!own(selected.operation,'security'),
    schemes:data.components?.securitySchemes ?? {}, full:info.kind==='document'};
}

export function setOperationServers(source,key,servers) {
  if(servers===undefined)return updateOperation(source,key,['servers'],undefined,true);
  if(!Array.isArray(servers)||!servers.length)throw Error('至少保留一个服务地址');
  for(const server of servers){
    if(!isRecord(server)||typeof server.url!=='string'||!server.url.trim()||/\s/.test(server.url))throw Error('请输入有效服务地址');
    const resolved=server.url.replace(/\{[^{}]+\}/g,'variable');
    if(/[{}]/.test(resolved))throw Error('地址变量的大括号不完整');
    const url=new URL(resolved,'https://docs.example');
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw Error('服务地址须为 HTTP(S) 或相对路径');
  }
  return updateOperation(source,key,['servers'],servers);
}

/** Edit a scheme locally; clone shared definitions rather than changing other operations. */
export function setOperationAuth(source,key,mode,scheme) {
  const {doc, data, info, selected, prefix}=context(source,key);
  if(mode==='inherit'){doc.deleteIn([...prefix,'security']);return doc.toString();}
  if(mode==='none'){doc.setIn([...prefix,'security'],[]);return doc.toString();}
  if(info.kind!=='document')throw Error('鉴权定义需要完整 OpenAPI 文档');
  const schemes=data.components?.securitySchemes ?? {};
  if(!isRecord(schemes)||own(schemes,'$ref')||(data.components!==undefined&&(!isRecord(data.components)||own(data.components,'$ref'))))throw Error('鉴权定义包含引用，无法直接修改');
  if(mode.startsWith('existing:')){
    const name=mode.slice(9);if(!own(schemes,name))throw Error('鉴权方案不存在');
    const target=schemes[name];
    if(!isRecord(target)||['oauth2','openIdConnect'].includes(target.type)||own(target,'$ref'))throw Error('此鉴权方案需要保留原有授权范围');
    doc.setIn([...prefix,'security'],[{[name]:[]}]);return doc.toString();
  }
  if(!isRecord(scheme)||!['apiKey','bearer','basic'].includes(mode))throw Error('不支持的鉴权类型');
  if(mode==='apiKey'&&(!['header','query','cookie'].includes(scheme.in)||typeof scheme.name!=='string'||!scheme.name.trim()||/[\s\x00-\x1f\x7f]/.test(scheme.name)))throw Error('请输入有效的鉴权参数名和位置');
  const effective=selected.operation.security??data.security??[];
  const current=Array.isArray(effective)&&effective.length===1&&isRecord(effective[0])&&Object.keys(effective[0]).length===1?Object.keys(effective[0])[0]:undefined;
  const old=current&&isRecord(schemes[current])&&!own(schemes[current],'$ref')?schemes[current]:{};
  const wanted=mode==='apiKey'?{type:'apiKey',in:scheme.in,name:scheme.name}:{type:'http',scheme:mode,...(mode==='bearer'&&scheme.bearerFormat?{bearerFormat:scheme.bearerFormat}:{})};
  const same=old.type===wanted.type&&(wanted.type!=='http'||old.scheme===wanted.scheme);
  const next={...(same?old:Object.fromEntries(Object.entries(old).filter(([k])=>k.startsWith('x-')))),...wanted};
  if(scheme.description)next.description=scheme.description;else delete next.description;
  if(mode==='bearer'&&!scheme.bearerFormat)delete next.bearerFormat;
  const usedElsewhere=(value)=>{
    if(value===selected.operation)return false;
    if(!value||typeof value!=='object')return false;
    return Object.entries(value).some(([k,v])=>k==='$ref'&&typeof v==='string'&&v===`#/components/securitySchemes/${String(current).replace(/~/g,'~0').replace(/\//g,'~1')}`||k==='security'&&Array.isArray(v)&&v.some(item=>isRecord(item)&&own(item,current))||usedElsewhere(v));
  };
  let name=current;
  if(!name||usedElsewhere(info.data)||(current&&isRecord(schemes[current])&&own(schemes[current],'$ref'))){let index=1;while(own(schemes,`docs_auth_${index}`))index++;name=`docs_auth_${index}`;}
  // Preserve comments on unrelated root/component fields.
  if(same&&name===current){
    for(const field of ['type','in','name','scheme','bearerFormat','description']){
      if(own(next,field))doc.setIn(['components','securitySchemes',name,field],next[field]);
      else if(own(old,field))doc.deleteIn(['components','securitySchemes',name,field]);
    }
  }else doc.setIn(['components','securitySchemes',name],next);
  doc.setIn([...prefix,'security'],[{[name]:[]}]);return doc.toString();
}
