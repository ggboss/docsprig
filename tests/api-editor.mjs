import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import { connectionSettings, setOperationServers, setOperationAuth, inspectApi, updateOperation, changeAddress, parseJsonField, renameSchemaProperty, simpleObjectSchema, parameterInventory, reconcilePathParameters, routeVariables, schemaFromExample, inferSchemaFromExample } from '../src/api-editor.mjs';

const operation = {summary:'Fetch', operationId:'fetch', responses:{'200':{description:'OK', headers:{'X-Trace':{schema:{type:'string'}}}}}, security:[{token:[]}], 'x-retained':{nested:[1,2]}};
const full = (version='3.1.0') => ({openapi:version, 'x-open-docs-document-kind':'operation', info:{title:'Test',version:'1'}, components:{securitySchemes:{token:{type:'http',scheme:'bearer'}}}, paths:{'/users':{parameters:[{name:'shared',in:'query',schema:{type:'string'}}], 'x-path':'retained',get:operation,post:{summary:'Create',responses:{'201':{description:'Created'}}}}}});
const selected=JSON.stringify(['/users','get']);

test('fragment edits preserve unknown root/operation fields and comments',()=>{
  const source='# top comment\n'+stringify({path:'/users',method:'GET',operation,'x-future':{a:1}});
  const next=updateOperation(source,'fragment',['summary'],'Changed');
  assert.match(next,/# top comment/);
  assert.deepEqual(parse(next),{path:'/users',method:'GET',operation:{...operation,summary:'Changed'},'x-future':{a:1}});
});

test('full operation documents and imported multi-operation contracts retain version and siblings',()=>{
  for(const version of ['3.0.3','3.1.0']){
    const doc=full(version), source=stringify(doc), info=inspectApi(source);
    assert.equal(info.supported,true);assert.equal(info.operations.length,2);
    const next=parse(updateOperation(source,selected,['responses','200','content','application/json'],{schema:{type:'object'},example:{id:1}}));
    assert.equal(next.openapi,version);assert.equal(next['x-open-docs-document-kind'],'operation');
    assert.deepEqual(next.components,doc.components);assert.deepEqual(next.paths['/users'].post,doc.paths['/users'].post);
    assert.deepEqual(next.paths['/users'].parameters,doc.paths['/users'].parameters);
    assert.deepEqual(next.paths['/users'].get.responses['200'].headers,operation.responses['200'].headers);
    assert.deepEqual(next.paths['/users'].get.security,operation.security);
  }
});

test('parameter operations create a sequence and retain schema extensions and refs',()=>{
  let source=stringify({path:'/users',method:'get',operation});
  source=updateOperation(source,'fragment',['parameters',0],{name:'q',in:'query',schema:{type:'string','x-schema':true},'x-param':7});
  source=updateOperation(source,'fragment',['parameters',1],{$ref:'#/components/parameters/common'});
  source=updateOperation(source,'fragment',['parameters',0,'description'],'Search');
  const p=parse(source).operation.parameters;
  assert.ok(Array.isArray(p));assert.equal(p[0]['x-param'],7);assert.equal(p[0].schema['x-schema'],true);
  assert.throws(()=>updateOperation(source,'fragment',['parameters',1,'name'],'overwrite'),/引用/);
  source=updateOperation(source,'fragment',['parameters',0],undefined,true);
  assert.deepEqual(parse(source).operation.parameters,[{$ref:'#/components/parameters/common'}]);
});

test('request body, media examples and response changes preserve untouched fields',()=>{
  const doc=full();doc.paths['/users'].get.requestBody={required:true,'x-body':true,content:{'application/json':{schema:{$ref:'#/components/schemas/Request'},example:{old:1},encoding:{file:{contentType:'image/png'}}},'text/plain':{example:'text'}}};
  let source=updateOperation(stringify(doc),selected,['requestBody','content','application/json','example'],{new:2});
  source=updateOperation(source,selected,['responses','default'],{description:'Error',content:{'application/json':{examples:{failure:{value:{error:'bad'}}}}}});
  const op=parse(source).paths['/users'].get;
  assert.equal(op.requestBody['x-body'],true);assert.equal(op.requestBody.content['text/plain'].example,'text');
  assert.deepEqual(op.requestBody.content['application/json'].schema,{$ref:'#/components/schemas/Request'});
  assert.deepEqual(op.requestBody.content['application/json'].encoding,{file:{contentType:'image/png'}});
  assert.deepEqual(op.responses['200'],operation.responses['200']);
});

test('safe address moves retain path metadata and reject overwrites/shared-path movement',()=>{
  const doc=full();
  assert.throws(()=>changeAddress(stringify(doc),selected,'/moved','get'),/多个操作/);
  assert.throws(()=>changeAddress(stringify(doc),selected,'/users','post'),/已存在/);
  delete doc.paths['/users'].post;
  const next=parse(changeAddress(stringify(doc),selected,'/moved','patch'));
  assert.equal(next.paths['/users'],undefined);assert.deepEqual(next.paths['/moved'].patch,operation);
  assert.equal(next.paths['/moved']['x-path'],'retained');assert.deepEqual(next.paths['/moved'].parameters,doc.paths['/users'].parameters);
  doc.paths['/target']={get:structuredClone(operation)};
  assert.throws(()=>changeAddress(stringify(doc),selected,'/target','patch'),/已存在/);
  assert.throws(()=>changeAddress(stringify(doc),selected,'/bad?query=1','get'),/路径/);
});

test('fallback rejects aliases, duplicate keys, refs, malformed input and unsupported versions without mutation',()=>{
  for(const source of ['[broken','path: /a\npath: /b','a: &a {x: 1}\nb: *a', stringify({...full(),openapi:'2.0'}),stringify({...full(),paths:{'/a':{$ref:'#/components/pathItems/a'}}}),stringify({swagger:'2.0',paths:{}})]){
    assert.equal(inspectApi(source).supported,false,source);
    assert.throws(()=>updateOperation(source,selected,['summary'],'no'));
  }
});

test('JSON examples preserve null/false/scalars, reject incomplete JSON; schemas preserve dialect',()=>{
  assert.throws(()=>parseJsonField('{"id":'),/JSON/);
  for(const value of [null,false,0,'string',[],{example:1}]) assert.deepEqual(parseJsonField(JSON.stringify(value)),{value,remove:false});
  assert.deepEqual(parseJsonField('  '),{remove:true});
  assert.throws(()=>parseJsonField('false','schema','3.0.3'),/3.0/);
  assert.deepEqual(parseJsonField('false','schema','3.1.0'),{value:false,remove:false});
  assert.throws(()=>parseJsonField('[]','schema'),/schema/);
  assert.throws(()=>parseJsonField('null','examples'),/对象/);
});

test('referenced request/response objects and scalar parents cannot be silently replaced',()=>{
  const doc=full();doc.paths['/users'].get={requestBody:{$ref:'#/components/requestBodies/R'},responses:{'200':{$ref:'#/components/responses/R'}}};
  const source=stringify(doc);
  assert.throws(()=>updateOperation(source,selected,['requestBody','description'],'lost'),/引用/);
  assert.throws(()=>updateOperation(source,selected,['responses','200','description'],'lost'),/引用/);
  doc.paths['/users'].get.responses='invalid';
  assert.throws(()=>updateOperation(stringify(doc),selected,['responses','200'],{description:'lost'}),/结构/);
});


test('object field rename, type, description and required edits preserve unknown schema/property keys',()=>{
  const schema={type:'object','x-schema':'keep',additionalProperties:false,required:['id'],properties:{id:{type:'string',description:'ID',minLength:1,'x-field':42},other:{type:'number'}}};
  const doc=full();doc.paths['/users'].get.requestBody={content:{'application/json':{schema}}};
  const path=['requestBody','content','application/json','schema'];
  let source=renameSchemaProperty(stringify(doc),selected,path,'id','userId');
  source=updateOperation(source,selected,[...path,'properties','userId','description'],'User ID');
  source=updateOperation(source,selected,[...path,'properties','other','type'],'integer');
  source=updateOperation(source,selected,[...path,'required'],['userId','other']);
  const result=parse(source).paths['/users'].get.requestBody.content['application/json'].schema;
  assert.equal(result.properties.id,undefined);assert.equal(result.properties.userId['x-field'],42);
  assert.equal(result.properties.userId.minLength,1);assert.equal(result.properties.userId.description,'User ID');
  assert.equal(result.additionalProperties,false);assert.equal(result['x-schema'],'keep');
  assert.equal(result.properties.other.type,'integer');assert.deepEqual(result.required,['userId','other']);
  assert.throws(()=>renameSchemaProperty(source,selected,path,'userId','other'),/已存在/);
  assert.equal(simpleObjectSchema({type:'object',allOf:[{properties:{}}]}),false);
  assert.equal(simpleObjectSchema({type:'object',required:'bad'}),false);
});


test('opening route variables is read-only; explicit reconciliation creates required Path rows once',()=>{
  const source=stringify({path:'/users/{id}/files/{file}',method:'get',operation:structuredClone(operation)});
  assert.deepEqual(parameterInventory(source,'fragment').missing,['id','file']);
  assert.equal(parse(source).operation.parameters,undefined);
  const next=reconcilePathParameters(source,'fragment');
  assert.deepEqual(parse(next).operation.parameters,[
    {name:'id',in:'path',required:true,schema:{type:'string'}},
    {name:'file',in:'path',required:true,schema:{type:'string'}}
  ]);
  assert.deepEqual(parse(reconcilePathParameters(next,'fragment')),parse(next));
  assert.deepEqual(routeVariables('/{id}/{id}'),['id']);
  assert.throws(()=>routeVariables('/{broken'),/路径变量/);
});

test('explicit route changes add missing variables and refuse silent loss of existing Path metadata',()=>{
  const source=stringify({path:'/users/{id}',method:'get',operation:{...structuredClone(operation),parameters:[{name:'id',in:'path',required:false,schema:{type:'integer'},'x-keep':1}]}});
  const next=parse(changeAddress(source,'fragment','/users/{id}/files/{file}','post'));
  assert.equal(next.operation.parameters[0]['x-keep'],1);assert.equal(next.operation.parameters[0].required,true);
  assert.equal(next.operation.parameters[0].schema.type,'integer');assert.equal(next.operation.parameters[1].name,'file');
  assert.throws(()=>changeAddress(source,'fragment','/users/{userId}','get'),/不会自动丢弃/);
});

test('inherited and referenced Path parameters are neither duplicated nor overwritten',()=>{
  const doc={openapi:'3.1.0',info:{title:'References',version:'1'},components:{parameters:{id:{name:'id',in:'path',required:true,schema:{type:'integer'}}}},paths:{'/users/{id}':{parameters:[{$ref:'#/components/parameters/id'}],get:structuredClone(operation)}}};
  const key=JSON.stringify(['/users/{id}','get']),source=stringify(doc);
  assert.deepEqual(parameterInventory(source,key).missing,[]);
  assert.deepEqual(parse(reconcilePathParameters(source,key)),doc);
  assert.throws(()=>changeAddress(source,key,'/users/{other}','get'),/不会自动丢弃/);
  doc.components.parameters.id.required=false;
  assert.throws(()=>reconcilePathParameters(stringify(doc),key),/继承或引用/);
  doc.paths['/users/{id}'].get.parameters=[{name:'id',in:'path',required:false,schema:{type:'string'},'x-local':true}];
  const next=parse(reconcilePathParameters(stringify(doc),key));
  assert.equal(next.paths['/users/{id}'].get.parameters[0].required,true);
  assert.equal(next.components.parameters.id.required,false);
  assert.deepEqual(next.paths['/users/{id}'].parameters,[{$ref:'#/components/parameters/id'}]);
});

test('unresolved or circular parameter refs prevent guessed additions',()=>{
  for(const ref of ['https://example.invalid/parameters/id','#/components/parameters/missing']){
    const source=stringify({path:'/users/{id}',method:'get',operation:{parameters:[{$ref:ref}],responses:{'200':{description:'OK'}}}});
    assert.equal(parameterInventory(source,'fragment').unresolved,true);
    assert.throws(()=>reconcilePathParameters(source,'fragment'),/未解析引用/);
  }
});

test('circular local parameter references remain read-only',()=>{
  const source=stringify({openapi:'3.1.0',info:{title:'Cycle',version:'1'},components:{parameters:{loop:{$ref:'#/components/parameters/loop'}}},paths:{'/users/{id}':{get:{parameters:[{$ref:'#/components/parameters/loop'}],responses:{'200':{description:'OK'}}}}}});
  const key=JSON.stringify(['/users/{id}','get']);
  assert.equal(parameterInventory(source,key).unresolved,true);
  assert.throws(()=>reconcilePathParameters(source,key),/未解析引用/);
});

test('derive schema from a pasted sample adds fields without losing constraints or inventing required',()=>{
  const old={type:'object','x-keep':true,required:['id'],additionalProperties:false,properties:{id:{type:'integer',description:'Original',minimum:1},legacy:{type:'string'}}};
  const next=schemaFromExample(old,{id:2,name:'Ada',active:true,nested:{value:2},items:[{name:'x'}]});
  assert.deepEqual(next.properties.id,old.properties.id);assert.deepEqual(next.properties.legacy,old.properties.legacy);
  assert.deepEqual(next.required,['id']);assert.equal(next.additionalProperties,false);assert.equal(next['x-keep'],true);
  assert.deepEqual(next.properties.name,{type:'string'});assert.equal(next.properties.items.items.properties.name.type,'string');
  assert.throws(()=>schemaFromExample(old,{id:'wrong'}),/类型不同/);
  assert.throws(()=>schemaFromExample({$ref:'#/components/schemas/A'},{id:1}),/复杂 schema/);
  assert.deepEqual(inferSchemaFromExample(null,'3.0.3'),{nullable:true});
  assert.deepEqual(inferSchemaFromExample(null,'3.1.0'),{type:'null'});
  assert.deepEqual(schemaFromExample(undefined,JSON.parse('{"__proto__":{"x":1}}')).properties.__proto__,{type:'object',properties:{x:{type:'integer'}}});
});


test('unchanged address and already reconciled routes preserve source bytes exactly',()=>{
  const source=JSON.stringify({path:'/users/{id}',method:'get',operation:structuredClone(operation)});
  assert.equal(changeAddress(source,'fragment','/users/{id}','get'),source);
  assert.equal(parse(source).operation.parameters,undefined);
  const reconciled=reconcilePathParameters(source,'fragment');
  assert.equal(reconcilePathParameters(reconciled,'fragment'),reconciled);
  for(const path of ['/users/{','/users/{}','/users/{id/name}','/users/{id}}'])
    assert.throws(()=>changeAddress(source,'fragment',path,'get'),/路径变量/);
});

test('address commits reject duplicate Path identities and references to relocated paths',()=>{
  const parameter={name:'id',in:'path',required:true,schema:{type:'string'}};
  const source=stringify({path:'/users/{id}',method:'get',operation:{...operation,parameters:[parameter,{...structuredClone(parameter),description:'duplicate'}]}});
  assert.throws(()=>changeAddress(source,'fragment','/users/{id}/files/{file}','get'),/重复的 Path 参数/);
  for(const ref of ['#/paths/~1users/get','#/paths/%7E1users/get']) {
    const doc={openapi:'3.1.0',info:{title:'Refs',version:'1'},paths:{'/users':{get:{responses:{'200':{description:'OK',links:{next:{operationRef:ref}}}}}}}};
    const body=stringify(doc), key=JSON.stringify(['/users','get']);
    assert.throws(()=>changeAddress(body,key,'/users/{id}','get'),/本地引用/);
    assert.throws(()=>changeAddress(body,key,'/users','post'),/本地引用/);
    assert.deepEqual(parse(body),doc);
  }
});

test('connection settings respect inheritance and edits remain scoped to the selected operation',()=>{
  const data=full();data.servers=[{url:'https://global.example','x-preserve':true}];
  data.paths['/users'].servers=[{url:'https://{stage}.example',variables:{stage:{default:'test',enum:['test','prod']}},description:'Shared'}];
  data.security=[{token:[]}];data.paths['/users'].post.security=[{token:[]}];
  const source=stringify(data);
  assert.deepEqual(connectionSettings(source,selected).servers,data.paths['/users'].servers);
  const servers=[{...data.paths['/users'].servers[0],url:'https://{stage}.example/v2'}];
  const changed=setOperationServers(source,selected,servers),actual=parse(changed);
  assert.deepEqual(actual.paths['/users'].get.servers,servers);
  assert.deepEqual(actual.paths['/users'].servers,data.paths['/users'].servers);
  assert.deepEqual(parse(setOperationServers(changed,selected,undefined)),data);
  for(const url of ['','javascript:alert(1)','https://user:pass@example.com','https://example.com/#token','https://{broken'])
    assert.throws(()=>setOperationServers(source,selected,[{url}]));
  const auth=parse(setOperationAuth(changed,selected,'apiKey',{in:'header',name:'X-Partner-Key',description:'Partner authentication'}));
  assert.deepEqual(auth.components.securitySchemes.token,data.components.securitySchemes.token);
  assert.deepEqual(auth.paths['/users'].post,data.paths['/users'].post);
  const key=Object.keys(auth.paths['/users'].get.security[0])[0];assert.notEqual(key,'token');
  assert.deepEqual(auth.components.securitySchemes[key],{type:'apiKey',in:'header',name:'X-Partner-Key',description:'Partner authentication'});
  const next=parse(setOperationAuth(stringify(auth),selected,'apiKey',{in:'query',name:'partner',description:'Changed'}));
  assert.equal(Object.keys(next.components.securitySchemes).length,2);
  assert.equal(next.components.securitySchemes[key].in,'query');
  assert.deepEqual(parse(setOperationAuth(source,selected,'none')).paths['/users'].get.security,[]);
  assert.equal(Object.hasOwn(parse(setOperationAuth(source,selected,'inherit')).paths['/users'].get,'security'),false);
  assert.equal(next.openapi,'3.1.0');assert.deepEqual(next.paths['/users'].get.responses,data.paths['/users'].get.responses);
});

test('auth editing preserves referenced and complex schemes until explicitly replaced',()=>{
  const data=full('3.0.3');data.components.securitySchemes.token={$ref:'#/components/securitySchemes/shared'};
  data.components.securitySchemes.shared={type:'http',scheme:'basic'};
  const changed=parse(setOperationAuth(stringify(data),selected,'bearer',{bearerFormat:'JWT'}));
  assert.deepEqual(changed.components.securitySchemes.token,data.components.securitySchemes.token);
  assert.deepEqual(changed.components.securitySchemes.shared,data.components.securitySchemes.shared);
  assert.equal(changed.openapi,'3.0.3');
  const key=Object.keys(changed.paths['/users'].get.security[0])[0];
  assert.deepEqual(changed.components.securitySchemes[key],{type:'http',scheme:'bearer',bearerFormat:'JWT'});
});

test('auth editing clones a scheme shared through a local reference',()=>{
  const data=structuredClone(full());
  data.components.securitySchemes.alias={$ref:'#/components/securitySchemes/token'};
  data.paths['/users'].post.security=[{alias:[]}];
  const changed=parse(setOperationAuth(stringify(data),selected,'apiKey',{in:'header',name:'X-Local-Key'}));
  assert.deepEqual(changed.components.securitySchemes.token,data.components.securitySchemes.token);
  assert.deepEqual(changed.components.securitySchemes.alias,data.components.securitySchemes.alias);
  assert.deepEqual(changed.paths['/users'].post,data.paths['/users'].post);
  assert.notEqual(Object.keys(changed.paths['/users'].get.security[0])[0],'token');
});
