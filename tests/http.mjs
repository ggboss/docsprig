import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../server/http.mjs';

test('HTTP boundary: no drafts in public content, static origins, immutable reads', async t => {
  let tip = null, writes = 0, privateReads=0, key = '';
  const origin = 'https://docs.example.invalid';
  const server = createServer(handler({origin, store:{
    current:async()=>tip, hasRelease:async id => id === tip?.id, read:async()=>{privateReads++; return {revision:0,nodes:[]};},
    saveNode:async(revision,node,actor)=>{assert.equal(node.id,"a"); assert.equal(actor,"test:admin");writes++;return {revision:1};}, publishNode:async(revision,id,draftVersion)=>{assert.equal(id,'a');assert.equal(draftVersion,1);tip={id:'r1'};return {published:tip};}},
    authenticate:async req=>{if(req.headers.cookie !== 'JSESSIONID=synthetic') throw Object.assign(Error('Unauthorized'),{status:401});return 'test:admin';},
    content:{read:async k=>{key=k;return {body:Buffer.from('published'), contentType:'text/plain'};}}}));
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok)); t.after(()=>new Promise(ok=>server.close(ok)));
  const req=(p,o)=>fetch(`http://127.0.0.1:${server.address().port}${p}`,o);
  const write=(method,headers={},data=method==='PUT'?{node:{id:'a'}}:{id:'a',draftVersion:1})=>({method,headers:{cookie:'JSESSIONID=synthetic','content-type':'application/json',...headers},body:JSON.stringify({revision:0,...data})});
  assert.equal((await req('/manage/session')).status,401);
  assert.equal((await req('/manage/workspace')).status,401);
  assert.equal((await req('/content/dev/current/tree.json')).status,404);
  assert.equal((await req('/content/dev/releases/guessed/index.json')).status,404);
  assert.equal(privateReads,0);
  for (const h of [{},{origin:'null'},{origin:'https://other.invalid'},{origin,'sec-fetch-site':'cross-site'}])
    assert.equal((await req('/manage/node',write('PUT',h))).status,403);
  assert.equal((await req('/manage/node',write('PUT',{origin,'content-type':'text/plain'}))).status,415);
  assert.equal((await req('/manage/workspace',write('PUT',{origin}))).status,405);
  assert.equal((await req('/manage/node',write('PUT',{origin},{nodes:[]}))).status,400);
  assert.equal((await req('/manage/publish',write('POST',{origin},{}))).status,400);
  assert.equal(writes,0);
  assert.equal((await req('/manage/node',write('PUT',{origin}))).status,200);
  assert.equal((await req('/manage/publish',write('POST',{origin}))).status,200);
  const cur=await req('/content/dev/current/api.yaml'); assert.equal(await cur.text(),'published'); assert.equal(key,'releases/r1/api.yaml');assert.equal(cur.headers.get('cache-control'),'no-store');
  const rel=await req('/content/dev/releases/r1/api.yaml',{method:'HEAD'});assert.match(rel.headers.get('cache-control'),/immutable/); assert.equal(await rel.text(),'');
  assert.equal((await req('/content/dev/current/draft.json')).status,404);
  assert.equal(privateReads,0);
});

test('injected authenticated API retains write origin checks', async t => {
  const adminActor = async () => 'test:admin';
  let writes = 0;
  const origin = 'http://127.0.0.1:4180';
  const server = createServer(handler({ origin, authenticate: adminActor, content: {}, store: {
    read: async () => ({ revision: writes, nodes: [] }),
    saveNode: async (revision, node, actor) => {
      assert.equal(actor, 'test:admin');
      writes++;
      return { revision: writes, nodes: [node] };
    },
  } }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let browser = 0; browser < 2; browser++) {
    assert.deepEqual(await (await fetch(base + '/manage/session')).json(), { admin: true });
    assert.equal((await fetch(base + '/manage/workspace')).status, 200);
    const response = await fetch(base + '/manage/node', {
      method: 'PUT', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: writes, node: { id: `browser-${browser}` } }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  for (const headers of [{}, { origin: 'null' }, { origin: 'http://untrusted.invalid' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await fetch(base + '/manage/node', {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: writes, node: { id: 'blocked' } }),
    })).status, 403);
  }
  assert.equal(writes, 2);
});

test('authenticated draft preview is read-only and isolates the selected API operation', async t => {
  const operation = { summary: 'Unpublished draft', responses: { 200: {
    description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
  } } };
  const base = { openapi: '3.0.3', info: { title: 'Base contract', version: '1' },
    servers: [{ url: 'https://example.invalid' }], security: [{ token: [] }],
    components: { schemas: { Item: { type: 'object' } }, securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
    paths: { '/items': { summary: 'Items', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      post: { responses: { 201: { description: 'Other operation' } } } },
    '/other': { get: { responses: { 200: { description: 'Other path' } } } } },
  };
  let nodes = [
    { id: 'base', type: 'api', body: JSON.stringify(base) },
    { id: 'draft', type: 'api', title: 'Draft', publishedVersion: null,
      body: JSON.stringify({ path: '/items', method: 'GET', operation }) },
    { id: 'unrelated', type: 'api', body: 'unfinished: [' },
    { id: 'notes', type: 'markdown', body: '# Markdown' },
  ];
  let reads = 0;
  const original = structuredClone(nodes);
  const server = createServer(handler({ origin: 'http://127.0.0.1:4180',
    authenticate: async req => {
      if (req.headers.authorization !== 'test-admin') throw Object.assign(Error('Unauthorized'), { status: 401 });
      return 'test:admin';
    }, store: {
      read: async () => { reads++; return { nodes }; },
      saveNode: () => assert.fail('Preview must not save'),
      publishNode: () => assert.fail('Preview must not publish'),
      current: () => assert.fail('Preview must read drafts, not the published release'),
    }, content: { stage: () => assert.fail('Preview must not stage content') },
  }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const url = `http://127.0.0.1:${server.address().port}/manage/preview`;
  const get = (query, options = {}) => fetch(url + query, { headers: { authorization: 'test-admin' }, ...options });
  assert.equal((await get('?doc=draft', { headers: {} })).status, 401);
  assert.equal(reads, 0);
  for (const query of ['', '?doc=', '?doc=../base', '?doc=draft&doc=base', '?doc=draft&extra=1', '?doc=%ZZ'])
    assert.equal((await get(query)).status, 400, query);
  for (const version of ['', '-1', '1.5', 'NaN', 'Infinity', '1e2', '%2B1', '%201', '01', '9007199254740992', '1&v=2'])
    assert.equal((await get(`?doc=draft&v=${version}`)).status, 400, `Invalid v=${version}`);
  assert.equal(reads, 0);
  assert.equal((await get('?doc=draft', { method: 'POST' })).status, 405);
  assert.equal((await get('?doc=missing')).status, 404);
  assert.equal((await get('?doc=notes')).status, 400);
  assert.equal((await get('?doc=unrelated')).status, 422);
  const response = await get('?doc=draft');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const preview = await response.json();
  assert.equal(preview.openapi, '3.0.3', 'Legacy preview preserves the base schema dialect');
  for (const field of ['info', 'servers', 'security', 'components']) assert.deepEqual(preview[field], base[field]);
  assert.deepEqual(preview.paths, { '/items': { summary: 'Items', parameters: base.paths['/items'].parameters, get: operation } });
  assert.deepEqual(await (await get('?doc=base')).json(), base, 'Full contract returns its original document');
  for (const version of ['0', '1', '42', '9007199254740991']) {
    const keyed = await get(`?doc=draft&v=${version}`);
    assert.equal(keyed.status, 200);
    assert.equal(keyed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await keyed.json(), preview, 'v does not select a historical version');
  }
  assert.deepEqual(nodes, original, 'Preview must not mutate stored drafts');
  nodes = [original[1]];
  assert.equal((await get('?doc=draft')).status, 200, 'An operation can preview without a base contract');
  for (const body of ['[1,2]', 'path: /items\nmethod: nope\noperation: {}',
    JSON.stringify({ path: '/items', method: 'get', operation: [] }),
    JSON.stringify({ openapi: '2.0', paths: {} }), 'openapi: 3.1.0\npaths: {}',
    'a: &shared {x: 1}\nb: *shared', 'path: /one\npath: /two']) {
    nodes = [{ id: 'bad', type: 'api', body }];
    assert.equal((await get('?doc=bad')).status, 422, body);
  }
});

test('tab routes require auth, validate writes and dispatch atomic metadata operations', async t => {
  const origin = 'https://docs.example.invalid';
  const calls = [];
  const tabs = [{id:'custom',title:'Custom',sort:0}];
  const state = {revision:3,nodes:[],published:null};
  const server = createServer(handler({origin, authenticate: async req => {
    if (req.headers.authorization !== 'test-admin') throw Object.assign(Error('Unauthorized'), {status:401});
    return 'test:admin';
  }, store: {
    saveTabs: async (revision, value, actor) => {calls.push(['save',revision,value,actor]); return state;},
    publishTabs: async (revision, actor, stage) => {calls.push(['publish',revision,actor]); await stage({nodes:[],revision}); return state;},
  }, content: {stage: async snapshot => {calls.push(['stage',snapshot]); return {id:'release'};}}}));
  await new Promise(ok => server.listen(0,'127.0.0.1',ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (path, method='PUT', data={revision:2,tabs}, headers={}) => fetch(base+path, {
    method, headers:{authorization:'test-admin',origin,'content-type':'application/json',...headers},
    ...(method !== 'GET' && {body:JSON.stringify(data)}),
  });
  for (const [path, method] of [['/manage/tabs','PUT'], ['/manage/tabs/publish','POST'],
    ['/manage/workspace','GET'], ['/manage/session','GET'], ['/manage/preview?doc=api','GET'],
    ['/manage/node','PUT'], ['/manage/publish','POST'], ['/manage/unknown','GET']])
    assert.equal((await send(path,method,{}, {authorization:''})).status,401,path);
  for (const [path,method,data] of [['/manage/tabs','PUT',{revision:2,tabs}], ['/manage/tabs/publish','POST',{revision:2}]]) {
    for (const headers of [{origin:''},{origin:'null'},{origin:'https://other.invalid'},{'sec-fetch-site':'cross-site'}])
      assert.equal((await send(path,method,data,headers)).status,403);
    assert.equal((await send(path,method,{revision:-1})).status,400);
    assert.equal((await send(path,method,{...data,extra:1})).status,400);
  }
  assert.equal((await send('/manage/tabs','GET')).status,405);
  assert.equal((await send('/manage/tabs/publish','PUT')).status,405);
  assert.deepEqual(calls,[]);
  assert.deepEqual(await (await send('/manage/tabs')).json(),state);
  assert.deepEqual(await (await send('/manage/tabs/publish','POST',{revision:2})).json(),state);
  assert.deepEqual(calls,[['save',2,tabs,'test:admin'],['publish',2,'test:admin'],['stage',{nodes:[],revision:2}]]);
});

test('node deletion requires admin credentials, matching origin and a single versioned ID', async t => {
  const origin = 'https://admin.example';
  const next = { revision: 4, nodes: [], published: null };
  let calls = 0;
  const server = createServer(handler({ origin, authenticate: async req => {
    if (req.headers.cookie !== 'admin=test') throw Object.assign(Error('Unauthorized'), { status: 401 });
    return 'admin';
  }, store: { deleteNode: async (revision, id, actor, stage) => {
    assert.deepEqual([revision, id, actor], [3, 'doc', 'admin']);
    assert.equal(typeof stage, 'function'); calls++; return next;
  } }, content: {} }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const body = { revision: 3, id: 'doc' };
  const send = (data, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/manage/node`, {
    method: 'DELETE', headers: { origin, cookie: 'admin=test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  assert.equal((await send(body, { cookie: '' })).status, 401);
  for (const h of [{origin: ''}, {origin: 'https://other.example'}, {'sec-fetch-site': 'cross-site'}])
    assert.equal((await send(body, h)).status, 403);
  assert.equal((await send(body, {'content-type':'text/plain'})).status, 415);
  for (const data of [{id:'doc'}, {revision:3}, {...body,id:'a/b'}, {...body,node:{}}, {...body,recursive:true}])
    assert.equal((await send(data)).status, 400);
  assert.equal(calls, 0);
  const response = await send(body);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), next); assert.equal(calls, 1);
});

test('move accepts only authenticated same-origin versioned placement requests', async t => {
  const origin = 'https://admin.example', state = {revision:4,nodes:[],published:null}, calls = [];
  const server = createServer(handler({origin, authenticate: async req => {
    if (req.headers.cookie !== 'admin=test') throw Object.assign(Error('Unauthorized'), {status:401});
    return 'admin';
  }, store:{moveNode:async (...args) => { calls.push(args); return state; }}, content:{}}));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  const send = (body, headers={}, method='POST') => fetch(`http://127.0.0.1:${server.address().port}/manage/node/move`, {
    method, headers:{origin,cookie:'admin=test','content-type':'application/json',...headers}, body:JSON.stringify(body),
  });
  const body = {revision:3,id:'doc',parentId:'group',beforeId:'next'};
  assert.equal((await send(body,{cookie:''})).status,401);
  for (const h of [{origin:''},{origin:'https://other.example'},{'sec-fetch-site':'cross-site'}])
    assert.equal((await send(body,h)).status,403);
  assert.equal((await send(body,{},'PUT')).status,405);
  assert.equal((await send(body,{'content-type':'text/plain'})).status,415);
  for (const patch of [{revision:undefined},{id:null},{parentId:undefined},{parentId:null},{beforeId:undefined},{beforeId:'a/b'},{parentId:1},{sort:0}])
    assert.equal((await send({...body,...patch})).status,400);
  assert.deepEqual(calls,[]);
  for (const pair of [['group','next'],['group',null]]) {
    const response = await send({...body,parentId:pair[0],beforeId:pair[1]});
    assert.equal(response.status,200); assert.deepEqual(await response.json(),state);
    assert.deepEqual(calls.at(-1),[3,'doc',...pair,'admin']);
  }
});

test('tab DELETE authenticates real sessions, validates origin/payload, and forwards actor and stager', async t => {
  const {adminActor}=await import('../server/auth.mjs');
  const keys=['DOCS_ADMIN_USERNAME','DOCS_ADMIN_PASSWORD'];
  const previous=keys.map(key=>process.env[key]);
  for(const key of keys)delete process.env[key];
  t.after(()=>keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];}));
  const origin='http://127.0.0.1:4180', calls=[];
  const state={revision:4,nodes:[],published:null};
  const server=createServer(handler({origin,authenticate:adminActor,store:{deleteTab:async(revision,id,actor,stage)=>{
    calls.push({revision,id,actor});
    assert.deepEqual(await stage({nodes:[],revision}),{id:'test-release'});
    return state;
  }},content:{stage:async()=>({id:'test-release'})}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=(headers={},body={revision:3,id:'empty'},method='DELETE')=>fetch(base+'/manage/tabs',{method,headers:{origin,'content-type':'application/json',...headers},body:method==='GET'?undefined:JSON.stringify(body)});
  assert.equal((await send()).status,401);
  const login=await fetch(base+'/manage/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const headers of [{origin:''},{origin:'null'},{origin:'https://evil.invalid'},{'sec-fetch-site':'cross-site'}])
    assert.equal((await send({cookie,...headers})).status,403);
  for(const body of [{revision:3},{revision:-1,id:'empty'},{revision:3,id:1},{revision:3,id:'a/b'},{revision:3,id:'empty',tabs:[]},{revision:3,id:'empty',cascade:true}])
    assert.equal((await send({cookie},body)).status,400);
  assert.equal((await send({cookie,'content-type':'text/plain'})).status,415);
  assert.equal((await send({cookie},undefined,'POST')).status,405);
  assert.deepEqual(calls,[]);
  const response=await send({cookie});assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),state);
  assert.equal(calls.length,1);assert.equal(calls[0].revision,3);assert.equal(calls[0].id,'empty');assert.ok(calls[0].actor);
  await fetch(base+'/manage/logout',{method:'POST',headers:{origin,cookie}});
  assert.equal((await send({cookie})).status,401);assert.equal(calls.length,1);
});

test('site name is public read-only JSON; updates require authenticated same-origin JSON without a workspace revision', async t => {
  const origin = 'https://docs.example.invalid';
  let name = '文档平台', writes = 0;
  const server = createServer(handler({origin, content:{}, store:{
    siteName:async () => ({name}), setSiteName:async value => { writes++; name = value; return {name}; },
  }, authenticate:async req => {
    if (req.headers.cookie !== 'admin=test') throw Object.assign(Error('Unauthorized'),{status:401});
    return 'admin';
  }}));
  await new Promise(ok => server.listen(0,'127.0.0.1',ok)); t.after(() => new Promise(ok => server.close(ok)));
  const base = `http://127.0.0.1:${server.address().port}`, read = () => fetch(base+'/content/site-name.json');
  const send = (body,headers={},method='PUT') => fetch(base+'/manage/site-name',{method,body,
    headers:{origin,cookie:'admin=test','content-type':'application/json',...headers}});
  assert.deepEqual(await (await read()).json(),{name:'文档平台'});
  const body = JSON.stringify({name:'开发文档'});
  assert.equal((await send(body,{cookie:''})).status,401);
  for (const headers of [{origin:''},{origin:'https://other.invalid'},{'sec-fetch-site':'cross-site'}])
    assert.equal((await send(body,headers)).status,403);
  assert.equal((await send(body,{},'POST')).status,405);
  assert.equal((await send(body,{'content-type':'text/plain'})).status,415);
  for (const payload of ['{}','null','[]','{"name":42}','{"name":"文档","revision":1}','{'])
    assert.equal((await send(payload)).status,400);
  assert.equal((await send(JSON.stringify({name:'x'.repeat(4096)}))).status,413);
  assert.equal((await fetch(base+'/content/site-name.json',{method:'PUT',body})).status,405);
  assert.equal(writes,0);
  const saved = await send(body); assert.equal(saved.status,200); assert.deepEqual(await saved.json(),{name:'开发文档'});
  const current = await read(); assert.equal(current.headers.get('cache-control'),'no-store');
  assert.deepEqual(await current.json(),{name:'开发文档'}); assert.equal(writes,1);
});


test('marked operation preview preserves its full 3.1 document and ignores unrelated base contracts', async t => {
  const document = { openapi: '3.1.0', 'x-open-docs-document-kind': 'operation',
    info: { title: 'Standalone', version: '1', summary: 'Own metadata' },
    components: { schemas: { Value: { type: ['string', 'null'], const: 'value' } } },
    servers: [{ url: 'https://standalone.invalid' }], 'x-owner': 'team',
    paths: { '/one': { get: { responses: { 200: { description: 'OK', content: {
      'application/json': { schema: { $ref: '#/components/schemas/Value' } },
    } } } } } },
  };
  let body = JSON.stringify(document);
  const server = createServer(handler({ origin: 'https://admin.invalid', authenticate: async () => 'admin',
    store: { read: async () => ({ nodes: [
      { id: 'one', type: 'api', body },
      { id: 'other', type: 'api', body: JSON.stringify({ ...document, paths: { '/other': document.paths['/one'] } }) },
      { id: 'base', type: 'api', body: 'openapi: 3.0.3\ninfo: {title: Base, version: "1"}\npaths: {}' },
      { id: 'unfinished', type: 'api', body: '[' },
    ] }) }, content: {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const preview = () => fetch(`http://127.0.0.1:${server.address().port}/manage/preview?doc=one`);
  const response = await preview();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), document);
  for (const patch of [{ openapi: '3.0.3' }, { 'x-open-docs-document-kind': 'unknown' },
    { paths: { ...document.paths, '/two': document.paths['/one'] } }, { components: {} }]) {
    body = JSON.stringify({ ...document, ...patch });
    assert.equal((await preview()).status, 422);
  }
});


test('publication reports incompatible 3.0 bases as actionable Chinese HTTP 422 errors', async t => {
  const { createContent } = await import('../server/content.mjs');
  const origin = 'https://admin.invalid';
  const root = { id: 'root', parentId: null, type: 'group', sort: 0, title: 'API', body: '' };
  const operation = { responses: { 200: { description: 'OK' } } };
  const base = { openapi: '3.0.3', info: { title: 'Base', version: '1' }, paths: {} };
  const standalone = { openapi: '3.1.0', 'x-open-docs-document-kind': 'operation',
    info: { title: 'One', version: '1' }, paths: { '/one': { get: operation } } };
  const snapshot = { revision: 0, nodes: [root, ...[base, standalone].map((document, i) => ({
    id: `api-${i}`, parentId: root.id, type: 'api', title: `API ${i}`, sort: i, body: JSON.stringify(document),
  }))] };
  const server = createServer(handler({ origin, authenticate: async () => 'admin', content: createContent(),
    store: { publishNode: async (revision, id, version, actor, stage) => stage(snapshot) } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/manage/publish`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 0, id: 'api-1', draftVersion: 1 }),
  });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /OpenAPI 3\.0 基础契约.*完整迁移.*不要只修改版本号/);
});

test('standalone preview reads only the selected draft; fragments retain consistent base resolution', async t => {
  let single=0, whole=0;
  const api={openapi:'3.1.0','x-open-docs-document-kind':'operation',info:{title:'Fast',version:'1'},paths:{'/fast':{get:{responses:{200:{description:'OK'}}}}}};
  let node={id:'one',type:'api',title:'Fast',body:JSON.stringify(api)};
  const store={readNode:async id=>{single++;return id==='one'?node:null;},read:async()=>{whole++;return {nodes:[node]};}};
  const server=createServer(handler({origin:'http://localhost',store,content:{},authenticate:async req=>{if(!req.headers.cookie)throw Object.assign(Error('Unauthorized'),{status:401});return 'admin';}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const get=(id='one',auth=true)=>fetch(`http://127.0.0.1:${server.address().port}/manage/preview?doc=${id}&v=1`,{headers:auth?{cookie:'test'}:{}});
  assert.equal((await get('one',false)).status,401);assert.equal(single,0);
  assert.deepEqual(await (await get()).json(),api);assert.equal(single,1);assert.equal(whole,0);
  api.info.title='New draft';node={...node,body:JSON.stringify(api)};
  assert.equal((await (await get()).json()).info.title,'New draft','old v must not return stale data');
  assert.equal((await get('missing')).status,404);
  node={...node,body:JSON.stringify({path:'/fragment',method:'get',operation:{responses:{200:{description:'OK'}}}})};
  assert.equal((await get()).status,200);assert.equal(whole,1);
  node={...node,body:'invalid: ['};assert.equal((await get()).status,422);
  node={...node,type:'markdown'};assert.equal((await get()).status,400);
});
