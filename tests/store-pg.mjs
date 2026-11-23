import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { migrate } from '../migrations/migrate.mjs';
import { saveDrafts, recordDraftChanges } from '../server/repository.mjs';
import { createStore } from '../server/store.mjs';

// Supply a local PG binary directory, never a URL to an existing database.
const bin = process.env.OPEN_TEST_PG_BINDIR;
const docker = process.env.OPEN_TEST_PG_DOCKER === '1';
test('repository lifecycle on an isolated PostgreSQL cluster', { skip: !bin && !docker && 'set OPEN_TEST_PG_BINDIR or OPEN_TEST_PG_DOCKER=1 to run' }, async t => {
  const root = await mkdtemp('/tmp/open-docs-test-');
  const data = join(root, 'data');
  const run = (cmd, args) => execFileSync(join(bin, cmd), args, {
    env: { PATH: process.env.PATH, LC_ALL: 'C' }, stdio: 'pipe',
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  let connection, container;
  const dockerRun = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (docker) {
    container = `open-store-test-${randomUUID()}`;
    dockerRun('run', '--rm', '--pull=never', '-d', '--name', container,
      '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=docs_test', 'postgres:16-alpine');
    t.after(() => dockerRun('rm', '-f', container));
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { dockerRun('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'docs_test'); ready = true; break; }
      catch { await sleep(250); }
    }
    assert.ok(ready, 'Isolated PostgreSQL must start');
    const mapped = dockerRun('port', container, '5432/tcp').match(/^127\.0\.0\.1:(\d+)$/);
    assert.ok(mapped);
    connection = { host: '127.0.0.1', port: Number(mapped[1]) };
  } else {
    run('initdb', ['-D', data, '-U', 'docs_test', '-A', 'trust', '-E', 'UTF8', '--no-locale']);
    run('pg_ctl', ['-D', data, '-l', join(root, 'log'), '-o', `-h '' -k ${root} -p 5432`, '-w', 'start']);
    connection = { host: root, port: 5432 };
  }
  const pool = new Pool({ ...connection, user: 'docs_test', database: 'postgres', ssl: false,
    max: 3, connectionTimeoutMillis: 3000 });
  try {
    await assert.rejects(migrate(pool), /Unexpected migration database/);
    assert.equal((await pool.query("SELECT to_regclass('docs_workspace') AS table_name")).rows[0].table_name, null);
    await Promise.all([migrate(pool, 'postgres', { seed: 'demo' }), migrate(pool, 'postgres', { seed: 'demo' })]);
    const store = createStore(pool), seed = await store.read();
    const migrateWithoutFixtures = database => execFileSync(process.execPath,['--permission',
      `--allow-fs-read=${new URL('../migrations',import.meta.url).pathname}`,
      `--allow-fs-read=${new URL('../server',import.meta.url).pathname}`,
      `--allow-fs-read=${new URL('../node_modules',import.meta.url).pathname}`,
      `--allow-fs-read=${new URL('../package.json',import.meta.url).pathname}`,
      '--input-type=module','-e',`
        import {Pool} from 'pg';import {migrate} from './migrations/migrate.mjs';
        const pool=new Pool(JSON.parse(process.env.ISOLATED_TEST_DB));
        try {await migrate(pool,${JSON.stringify(database)});} finally {await pool.end();}
      `],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,
        ISOLATED_TEST_DB:JSON.stringify({...connection,user:'docs_test',database,ssl:false})},stdio:'pipe'});
    migrateWithoutFixtures('postgres');

    await t.test('site name survives migration reruns and does not modify drafts or releases', async () => {
      assert.deepEqual(await store.siteName(),{name:'文档平台'});
      assert.deepEqual(await store.setSiteName('  集成文档  '),{name:'集成文档'});
      for (const invalid of [null, {}, '', '  ', 'a\nb', 'a\0b', 'a\u202eb', '界'.repeat(65)])
        await assert.rejects(store.setSiteName(invalid),{status:400});
      await migrate(pool,'postgres');
      assert.deepEqual(await createStore(pool).siteName(),{name:'集成文档'});
      assert.deepEqual(await store.read(),seed);
      assert.equal((await pool.query("SELECT to_regclass('docs_history') AS name")).rows[0].name,null);
    });
    assert.equal(await store.current(), null);
    assert.equal(await store.hasRelease('demo-001'), false);
    const api = seed.nodes.find(n => n.type === 'api');
    assert.equal(api.parentId, 'server-api');
    const fullContract = await readFile(new URL('../public/content/dev/current/api.yaml', import.meta.url), 'utf8');
    const fixture = parse(fullContract), fragment = parse(api.body);
    assert.equal(api.title, '查询用户信息');
    assert.deepEqual(Object.keys(fragment).sort(), ['method','operation','path']);
    assert.equal(fragment.path, '/demo/v1/user/info'); assert.equal(fragment.method, 'get');
    const { security, description, ...details } = fixture.paths[fragment.path].get;
    const { 'x-demo-authentication': auth, description: demoDescription, ...rest } = fragment.operation;
    assert.deepEqual(rest, details); assert.ok(demoDescription.startsWith(description));
    assert.deepEqual(auth, {security, securitySchemes:fixture.components.securitySchemes});
    const stager = { stage: async ({revision}) => ({id:randomUUID(),revision}) };
    const manifest = async release => {
      const {nodes} = await store.releaseNodes(release.id);
      const visit = parent => nodes.filter(n=>n.parentId===parent).sort((a,b)=>a.sort-b.sort || a.id.localeCompare(b.id)).flatMap(n=>[n,...visit(n.id)]);
      return {roots:visit(null).filter(n=>n.parentId===null).map(n=>n.id),nodes:visit(null)};
    };
    const reset = async (nodes,revision=0) => {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE docs_state,docs_drafts,docs_draft_changes,docs_audit,docs_release_nodes,docs_releases,docs_document_versions,docs_node_identities');
        await saveDrafts(client,nodes);
        await client.query("INSERT INTO docs_state VALUES(true,$1,'文档平台',NULL)",[revision]);
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    };
    const notes = seed.nodes.find(n => n.type === 'markdown');
    assert.equal(notes.parentId, 'changelog');
    assert.equal(notes.body, await readFile(new URL('../public/content/dev/releases/demo-001/notes.md', import.meta.url), 'utf8'));
    assert.equal(store.save, undefined);
    assert.equal(store.publish, undefined);
    assert.ok(seed.nodes.every(n => n.draftVersion === 1 && n.publishedVersion === null));
    const actor = { id: 'editor-1' };
    await t.test('marked operations save intact, validate atomically and publish immutable standalone contracts', async () => {
      const { createContent } = await import('../server/content.mjs');
      const root = seed.nodes.find(n => n.id === 'server-api');
      await reset([root]);
      let state = await store.read();
      const document = { openapi: '3.1.0', 'x-open-docs-document-kind': 'operation',
        info: { title: 'Standalone', version: '1' },
        components: { schemas: { Value: { type: ['string', 'null'] } } },
        paths: { '/standalone': { get: { operationId: 'standalone', responses: { 200: { description: 'OK' } } } } },
      };
      const body = JSON.stringify(document, null, 2) + '\n';
      const node = { id: 'standalone', parentId: root.id, type: 'api', title: 'Standalone', sort: 0, body };
      const counts = async () => (await pool.query(`SELECT
        (SELECT count(*)::int FROM docs_document_versions) AS versions,
        (SELECT count(*)::int FROM docs_draft_changes) AS changes,
        (SELECT count(*)::int FROM docs_audit) AS audits`)).rows[0];
      const before = await counts();
      for (const patch of [{ openapi: '3.0.3' }, { paths: {} },
        { paths: { ...document.paths, '/second': document.paths['/standalone'] } }]) {
        await assert.rejects(store.saveNode(state.revision, { ...node, body: JSON.stringify({ ...document, ...patch }) }, actor), { status: 400 });
        assert.deepEqual(await store.read(), state);
        assert.deepEqual(await counts(), before);
      }
      state = await store.saveNode(state.revision, node, actor);
      assert.equal(state.nodes.find(n => n.id === node.id).body, body);
      const savedState = structuredClone(state), savedCounts = await counts();
      const unmarked = { ...document };
      delete unmarked['x-open-docs-document-kind'];
      for (const replacement of [unmarked, { ...document, 'x-open-docs-document-kind': 'base' },
        { path: '/standalone', method: 'get', operation: document.paths['/standalone'].get }]) {
        await assert.rejects(store.saveNode(state.revision, { ...node, body: JSON.stringify(replacement) }, actor),
          { status: 422, message: /请保留 x-open-docs-document-kind: operation 标记/ });
        assert.deepEqual(await store.read(), savedState);
        assert.deepEqual(await counts(), savedCounts);
      }

      const content = createContent({ loadRelease: id => store.releaseNodes(id) });
      state = await store.publishTabs(state.revision, actor, content.stage);
      state = await store.publishNode(state.revision, node.id, 1, actor, content.stage);
      const released = state.published;
      const tree = JSON.parse((await content.read(`releases/${released.id}/tree.json`)).body);
      const key = tree.nodes.find(n => n.id === node.id).url.slice('/content/dev/'.length);
      assert.deepEqual(JSON.parse((await content.read(key)).body), document);
      const conflict = { ...document, components: { schemas: { Value: { type: 'integer' } } },
        paths: { '/conflicting': { get: { operationId: 'conflicting', responses: { 200: { description: 'OK' } } } } } };
      state = await store.saveNode(state.revision, { ...node, id: 'conflicting', body: JSON.stringify(conflict) }, actor);
      const beforePublish = structuredClone(state), beforePublishCounts = await counts();
      await assert.rejects(store.publishNode(state.revision, 'conflicting', 1, actor, content.stage), /Conflicting component/);
      assert.deepEqual(await store.read(), beforePublish);
      assert.deepEqual(await counts(), beforePublishCounts);
      assert.deepEqual(await store.current(), released);
      const publishedState = structuredClone(state), publishedCounts = await counts();
      await assert.rejects(store.saveNode(state.revision, { ...node, body: '[' }, actor), { status: 400 });
      assert.deepEqual(await store.read(), publishedState);
      assert.deepEqual(await counts(), publishedCounts);
      state = await store.saveNode(state.revision, { ...node, body: JSON.stringify({ ...document, info: { title: 'Private edit', version: '2' } }) }, actor);
      assert.equal((await store.releaseNodes(released.id)).nodes.find(n => n.id === node.id).body, body);
      assert.deepEqual(JSON.parse((await createContent({ loadRelease: id => createStore(pool).releaseNodes(id) }).read(key)).body), document);
      await reset(seed.nodes);
    });
    for (const invalid of [null, seed.nodes, {...notes, id:'bad/id'}, {...api, parentId:null},
      {...notes, title:' '}, {...notes, parentId:api.id}, {...seed.nodes[0], sort:-1}]) {
      await assert.rejects(store.saveNode(0, invalid, actor), {status:400});
    }
    for (const [node, type] of [[notes, 'group'], [api, 'markdown']]) {
      await assert.rejects(store.saveNode(seed.revision, {...node, type}, actor),
        {status:400, message:'Cannot change the type of an existing node'});
    }
    assert.deepEqual(await store.read(), seed);
    await store.publishTabs(0, actor, () => ({id:'r0',revision:0}));
    const group = {...notes, id:'group', type:'group', title:'Section', body:''};
    const grouped = await store.saveNode(1, group, actor);
    assert.equal(grouped.nodes.at(-1).draftVersion, 1);
    const draft = await store.saveNode(2, {...notes, parentId:'group', draftVersion:999, publishedVersion:88}, actor);
    const uncalled = () => assert.fail('must not stage');
    await assert.rejects(store.publishNode(3, 'notes', 2, actor, uncalled), {status:409, message:'Publish parent group first'});
    await assert.rejects(store.publishNode(3, 'group', 2, actor, uncalled), {status:409});
    await assert.rejects(store.publishNode(2, 'group', 1, actor, uncalled), {status:409});
    await assert.rejects(store.publishNode(3, 'group', 1, actor, () => { throw Error('upload failed'); }), /upload failed/);
    assert.deepEqual(await store.read(), draft);
    const started = Promise.withResolvers(), resume = Promise.withResolvers();
    const publishing = store.publishNode(3, 'group', 1, actor, async ({ nodes, revision }) => {
      assert.equal(revision, 3);
      assert.deepEqual(nodes.map(n => n.id).sort(), ['changelog','group','server-api']);
      nodes.pop(); started.resolve(); await resume.promise;
      return {id:'r1',revision:3};
    });
    await Promise.race([started.promise, publishing]);
    const competing = assert.rejects(store.saveNode(3, api, actor), {status:409});
    try { assert.deepEqual(await store.current(), {id:'r0',revision:0}); } finally { resume.resolve(); }
    const first = await publishing; await competing;
    assert.equal(first.nodes.find(n => n.id === 'notes').publishedVersion, null);
    await store.saveNode(4, {...group, title:'Unreleased group rename'}, actor);
    const second = await store.publishNode(5, 'notes', 2, actor, ({nodes}) => {
      assert.equal(nodes.find(n => n.id === 'group').title, 'Section');
      assert.equal(nodes.find(n => n.id === 'notes').parentId, 'group');
      assert.ok(!nodes.some(n => n.type === 'api'));
      return {id:'r2',revision:5};
    });
    assert.equal(second.nodes.find(n => n.id === 'group').publishedVersion, 1);
    await store.saveNode(6, {...api, id:'api2'}, actor);
    await store.publishNode(7, 'api', 1, actor, () => ({id:'r3',revision:7}));
    const final = await store.publishNode(8, 'api2', 1, actor, ({nodes}) => {
      assert.deepEqual(nodes.filter(n => n.type === 'api').map(n => n.id), ['api','api2']);
      return {id:'r4',revision:8};
    });
    await migrate(pool, 'postgres');
    assert.deepEqual(await store.read(), final);
    assert.equal(await store.hasRelease('r1'), true);
    assert.deepEqual(await store.current(), {id:'r4',revision:8});
    const { rows: [history] } = await pool.query('SELECT actor FROM docs_audit WHERE revision=4');
    assert.deepEqual(history.actor, actor);
    assert.deepEqual((await store.releaseNodes('r1')).nodes.map(n => n.id).sort(), ['changelog','group','server-api']);

    // Dynamic tabs update atomically and publish roots without leaking drafts.
    await reset(seed.nodes);
    const unchanged = await store.read();
    const roots = unchanged.nodes.filter(n => n.parentId === null).map(({id,title,sort}) => ({id,title,sort}));
    for (const tabs of [null, roots.slice(1), [...roots, roots[0]], [...roots, {id:'api',title:'Collision',sort:2}],
      roots.map((root, i) => ({...root, title:i ? '' : 'Must roll back'})),
      [...roots, {id:'extra',title:'Extra',sort:-1}]]) {
      await assert.rejects(store.saveTabs(0, tabs, actor), {status:400});
      assert.deepEqual(await store.read(), unchanged);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM docs_audit')).rows[0].count, 0);
    const tabs = await store.saveTabs(0, [
      {...roots[0],title:'Renamed API',sort:8}, roots[1], {id:'custom',title:'Custom APIs',sort:0},
    ], actor);
    assert.equal(tabs.revision, 1);
    assert.equal(tabs.nodes.find(n => n.id === 'server-api').draftVersion, 2);
    assert.equal(tabs.nodes.find(n => n.id === 'changelog').draftVersion, 1);
    assert.equal(tabs.nodes.find(n => n.id === 'custom').draftVersion, 1);
    assert.ok(tabs.nodes.every(n => n.publishedVersion === null));
    await assert.rejects(store.saveTabs(0, roots, actor), {status:409});
    let current = await store.saveNode(1, {...api,parentId:'custom'}, actor);
    await assert.rejects(store.publishNode(current.revision, 'api', 2, actor, uncalled), {status:409});
    await assert.rejects(store.publishTabs(current.revision, actor, () => {throw Error('stage failed');}), /stage failed/);
    assert.deepEqual(await store.read(), current);
    current = await store.publishNode(current.revision, 'custom', 1, actor, snapshot => {
      assert.deepEqual(snapshot.nodes.map(n => n.id), ['custom'], 'No implicit publication of other roots');
      return stager.stage(snapshot);
    });
    current = await store.publishNode(current.revision, 'api', 2, actor, snapshot => stager.stage(snapshot));
    const liveApi = current.nodes.find(n => n.id === 'api');
    current = await store.saveNode(current.revision, {...liveApi,body:liveApi.body+'\n# private child edit'}, actor);
    current = await store.saveNode(current.revision, {...notes,id:'private',parentId:'custom',body:'PRIVATE CHILD'}, actor);
    current = await store.saveNode(current.revision, {id:'new-root',parentId:null,type:'group',sort:3,title:'New root',body:''}, actor);
    current = await store.saveNode(current.revision, {...current.nodes.find(n => n.id === 'custom'),title:'Custom renamed',sort:9}, actor);
    const beforePublish = structuredClone(current);
    current = await store.publishTabs(current.revision, actor, snapshot => {
      assert.equal(snapshot.nodes.find(n => n.id === 'api').body, liveApi.body);
      assert.ok(!snapshot.nodes.some(n => ['private','notes'].includes(n.id)));
      assert.equal(snapshot.nodes.find(n => n.id === 'custom').title, 'Custom renamed');
      return stager.stage(snapshot);
    });
    assert.deepEqual(current.nodes.filter(n => n.parentId !== null), beforePublish.nodes.filter(n => n.parentId !== null));
    assert.ok(current.nodes.filter(n => n.parentId === null).every(n => n.publishedVersion === n.draftVersion));
    const publishedTree = await manifest(current.published);
    assert.deepEqual(publishedTree.roots, ['changelog','new-root','server-api','custom']);
    assert.ok(!publishedTree.nodes.some(n => n.id === 'private'));
    assert.equal(publishedTree.nodes.find(n => n.id === 'api').type,'api');
    // Stage failure and concurrent stale edits do not partially update metadata.
    await assert.rejects(store.saveNode(current.revision, {...current.nodes.find(n => n.id === 'custom'),parentId:'new-root'}, actor), {status:400});
    const beforeConcurrent = current;
    const values = current.nodes.filter(n => n.parentId === null).map(({id,title,sort}) => ({id,title,sort}));
    const concurrent = await Promise.allSettled([
      store.saveTabs(current.revision, values.map(n => ({...n,title:n.title+' A'})), actor),
      store.saveTabs(current.revision, values.map(n => ({...n,title:n.title+' B'})), actor),
    ]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.find(result => result.status === 'rejected').reason.status, 409);
    assert.equal((await store.read()).revision, beforeConcurrent.revision+1);

    await t.test('delete changes only the selected draft and its prior live counterpart', async () => {
      let state = await store.read();
      const save = async node => { state = await store.saveNode(state.revision, node, actor); };
      const publish = async id => { state = await store.publishNode(state.revision, id,
        state.nodes.find(n => n.id === id).draftVersion, actor, snapshot => stager.stage(snapshot)); };
      const history = async id => (await store.releaseNodes(id)).nodes;
      const del = (id, stage = uncalled) => store.deleteNode(state.revision, id, actor, stage);
      await save({...group, id:'delete-group', parentId:'custom'});
      await publish('delete-group');
      await save({...notes, parentId:'delete-group'});
      await assert.rejects(del('delete-group'), {status:409}); // draft-only child
      await publish(notes.id);
      await save({...notes, parentId:'custom'});
      await assert.rejects(del('delete-group'), {status:409}); // child moved away only in draft
      await assert.rejects(del('custom'), {status:409});
      await assert.rejects(del('missing'), {status:404});
      await assert.rejects(store.deleteNode(state.revision-1, notes.id, actor, uncalled), {status:409});
      await assert.rejects(del(notes.id, () => { throw Error('stage failed'); }), /stage failed/);
      assert.deepEqual(await store.read(), state);
      const before = state;
      state = await del('private');
      assert.deepEqual(state, {...before, revision:before.revision+1, nodes:before.nodes.filter(n => n.id !== 'private')});
      for (const id of [notes.id, 'delete-group', api.id]) {
        const old = state, oldLive = await history(old.published.id);
        state = await del(id, snapshot => stager.stage(snapshot));
        assert.equal(state.revision, old.revision+1);
        assert.deepEqual(state.nodes, old.nodes.filter(n => n.id !== id));
        assert.deepEqual(await history(state.published.id), oldLive.filter(n => n.id !== id));
        assert.deepEqual(await history(old.published.id), oldLive);
        assert.equal(await store.hasRelease(old.published.id), true);
      }
    });

    await t.test('moves are atomic versioned draft edits, including nested groups and sibling ranks', async () => {
      const make = (id,parentId,sort=0,type='group') => ({id,parentId,sort,type,title:id,body:'',draftVersion:3,publishedVersion:2});
      const chain = Array.from({length:14}, (_,i) => make(`deep-${i}`, i ? `deep-${i-1}` : 'b'));
      const fixture = [make('a',null),make('b',null,1),make('m','a'),make('leaf','m',0,'markdown'),
        make('x','a',1),make('y','b',0),...chain];
      await reset(fixture,(await store.read()).revision);
      const original = await store.read();
      const history = async () => (await pool.query('SELECT revision,action,actor FROM docs_audit ORDER BY revision')).rows;
      const priorHistory = await history();
      const move = (id,parent,before=null) => store.moveNode(original.revision,id,parent,before,actor);
      for (const [id,parent,before,status] of [
        ['missing','a',null,404],['m','missing',null,404],['m','b','missing',404],['m','b','x',400],
        ['m','a','m',400],['m','m',null,400],['m','leaf',null,400],['a','b',null,400],
        ['leaf',null,null,400],['b',null,'a',400],['m',null,null,400],['m','deep-13',null,400],['deep-0','deep-2',null,400],
      ]) await assert.rejects(move(id,parent,before),{status});
      assert.deepEqual(await store.read(),original); assert.deepEqual(await history(),priorHistory);

      const race = await Promise.allSettled([move('m','b','y'),move('m','b','y')]);
      assert.equal(race.filter(r => r.status === 'fulfilled').length,1);
      assert.equal(race.find(r => r.status === 'rejected').reason.status,409);
      const state = await store.read();
      assert.equal(state.revision,original.revision+1); assert.deepEqual(state.published,original.published);
      assert.deepEqual(state.nodes,fixture.map(n => n.id === 'm' ? {...n,parentId:'b',sort:1,pendingPlacement:true,draftVersion:4}
        : n.id === 'y' ? {...n,sort:2,draftVersion:4} : n));
      assert.deepEqual(await history(),[...priorHistory,{revision:state.revision,action:'save',actor}]);
      const appended = await store.moveNode(state.revision,'m','b',null,actor);
      assert.deepEqual(appended.nodes,state.nodes.map(n => n.id === 'm' ? {...n,sort:3,pendingPlacement:true,draftVersion:5} : n));
      const unchanged = await store.moveNode(appended.revision,'m','b',null,actor);
      assert.deepEqual(unchanged.nodes,appended.nodes);
    });

    await t.test('tab deletion guards both trees, preserves last tabs, and isolates publication', async () => {
      const rootNode = id => ({id,parentId:null,type:'group',title:id,body:'',sort:0,draftVersion:1,publishedVersion:null});
      const fresh = [rootNode('keep'),rootNode('empty'),rootNode('draft')];
      await reset(fresh);
      let state = await store.read();
      const save = async node => state = await store.saveNode(state.revision,node,actor);
      const publish = async id => state = await store.publishNode(state.revision,id,state.nodes.find(n=>n.id===id).draftVersion,actor,snapshot=>stager.stage(snapshot));
      const del = (id,stage=uncalled,revision=state.revision) => store.deleteTab(revision,id,actor,stage);
      const history = async () => (await pool.query('SELECT * FROM docs_audit ORDER BY revision')).rows;
      const unchangedAfter = async action => {
        const before=await store.read(), audit=await history();
        await action();
        assert.deepEqual(await store.read(),before);assert.deepEqual(await history(),audit);
      };
      await unchangedAfter(async()=>{
        await assert.rejects(del('bad/id'),{status:400});
        await assert.rejects(del('missing'),{status:404});
        await assert.rejects(del('empty',uncalled,99),{status:409});
      });
      await save({...rootNode('child'),parentId:'empty'});
      await unchangedAfter(async()=>{
        await assert.rejects(del('child'),{status:400});
        await assert.rejects(del('empty'),{status:409});
      });
      state=await store.deleteNode(state.revision,'child',actor,uncalled);
      await publish('empty');
      // An unpublished alternative must not let the last live tab disappear.
      await unchangedAfter(()=>assert.rejects(del('empty'),{status:409}));
      await publish('keep');
      await save({...rootNode('child'),parentId:'empty'});await publish('child');
      await save({...state.nodes.find(n=>n.id==='child'),parentId:'keep'});
      // Draft is empty, but a published child still belongs to the tab.
      await unchangedAfter(()=>assert.rejects(del('empty'),{status:409}));
      await publish('child');
      await save({...state.nodes.find(n=>n.id==='keep'),title:'PRIVATE RENAME'});
      await save({...rootNode('private-child'),parentId:'keep',body:'PRIVATE BODY'});
      const liveBefore=(await store.releaseNodes(state.published.id)).nodes;
      const releaseBeforeDraftDelete=structuredClone(state.published);
      state=await del('draft');
      assert.deepEqual(state.published,releaseBeforeDraftDelete);
      assert.equal((await history()).at(-1).action,'save');
      const before=structuredClone(state);
      await unchangedAfter(()=>assert.rejects(del('empty',()=>{throw Error('tab stage failed');}),/tab stage failed/));
      await unchangedAfter(()=>assert.rejects(del('empty',()=>({})),/no release ID/));
      state=await del('empty',snapshot=>{
        assert.deepEqual(snapshot.nodes,liveBefore.filter(n=>n.id!=='empty'));
        assert.ok(!snapshot.nodes.some(n=>n.id==='private-child'));
        assert.equal(snapshot.nodes.find(n=>n.id==='keep').title,'keep');
        return stager.stage(snapshot);
      });
      assert.deepEqual(state.nodes,before.nodes.filter(n=>n.id!=='empty'));
      assert.equal((await history()).at(-1).action,'publish');
      const publishedTree=await manifest(state.published);
      assert.deepEqual(publishedTree.roots,['keep']);
      await unchangedAfter(()=>assert.rejects(del('keep'),{status:409}));
      // Concurrent deletion has exactly one winner, no double audit or cascade.
      await save(rootNode('race'));
      const revision=state.revision;
      const race=await Promise.allSettled([del('race'),del('race')]);
      assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(race.find(r=>r.status==='rejected').reason.status,409);
      assert.equal((await store.read()).revision,revision+1);
    });

    await t.test('publishing only a gapless move updates the live directory, not sibling drafts', async () => {
      const make = (id,sort) => ({id,parentId:'rank-root',type:'markdown',sort,title:id,body:`live ${id}`,draftVersion:1,publishedVersion:null});
      const fixture = [{...make('rank-root',0),parentId:null,type:'group'},make('a',0),make('b',1),make('z',2)];
      await reset(fixture,(await store.read()).revision);
      let state = await store.read();
      const node = id => state.nodes.find(n => n.id === id);
      const publish = async id => { state = await store.publishNode(state.revision,id,node(id).draftVersion,actor,s => stager.stage(s)); };
      const manifest = async release => { const {nodes}=await store.releaseNodes(release.id);return nodes.toSorted((a,b)=>a.parentId===null?-1:b.parentId===null?1:a.sort-b.sort || a.id.localeCompare(b.id)); };
      for (const n of fixture) await publish(n.id);
      const previous = state.published;
      state = await store.saveNode(state.revision,{...node('b'),title:'private title',body:'private body'},actor);
      state = await store.moveNode(state.revision,'z','rank-root','b',actor);
      state = await store.saveNode(state.revision,{...node('z'),body:'edited after moving'},actor);
      const pending = node('b');
      await publish('z');
      const nodes = await manifest(state.published), sibling = nodes.find(n => n.id === 'b');
      assert.deepEqual(nodes.map(n => n.id),['rank-root','a','z','b']);
      assert.equal(sibling.title,'b');
      assert.equal(sibling.body,'live b');
      assert.deepEqual(node('b'),pending); assert.equal(pending.publishedVersion,1);
      assert.deepEqual((await manifest(previous)).map(n => n.id),['rank-root','a','b','z']);
      const snapshot = await store.releaseNodes(state.published.id);
      assert.deepEqual(snapshot.nodes.find(n => n.id === 'b'),{...make('b',2),publishedVersion:1});

      // A draft-only sibling makes append ranks differ across trees. Republishing content must retain the live rank.
      state = await store.saveNode(state.revision,make('private-only',99),actor);
      state = await store.moveNode(state.revision,'z','rank-root',null,actor);
      assert.equal(node('z').sort,100);
      await publish('z');
      state = await store.saveNode(state.revision,{...node('z'),body:'second edit'},actor);
      await publish('z');
      const final = await manifest(state.published);
      assert.deepEqual(final.map(n => n.id),['rank-root','a','b','z']);
      assert.equal(final.at(-1).sort,3);

    });

    await reset(seed.nodes);
    const recreated = await store.read();
    await t.test('normalized releases, versions, draft history and legacy freeze are durable', async () => {
      let state = await store.read();
      const root = state.nodes.find(n=>n.parentId===null);
      state = await store.publishTabs(state.revision,actor,stager.stage);
      const first = await store.releaseNodes(state.published.id);
      const versionCount = async () => (await pool.query('SELECT count(*)::int AS n FROM docs_document_versions')).rows[0].n;
      const count = await versionCount();
      state = await store.publishTabs(state.revision,actor,stager.stage);
      assert.equal(await versionCount(),count,'Unchanged publication reuses content versions');
      assert.deepEqual(await store.releaseNodes('unknown-release'),null);
      const published = state.published;
      state = await store.saveNode(state.revision,{...root,title:'New draft title'},actor);
      assert.deepEqual(await store.releaseNodes(published.id),{...first,revision:published.revision});
      const changes = (await pool.query(`SELECT c.*,v.title,v.body FROM docs_draft_changes c
        LEFT JOIN docs_document_versions v ON v.id=c.version_id WHERE c.revision=$1`,[state.revision])).rows;
      assert.equal(changes.length,1);assert.equal(changes[0].title,'New draft title');
      assert.equal(changes[0].draft_version,2);
      assert.ok(changes[0].version_id);
      const prior = await store.read();
      const counts = async () => (await pool.query(`SELECT
        (SELECT count(*)::int FROM docs_audit) AS audits,
        (SELECT count(*)::int FROM docs_releases) AS releases,
        (SELECT count(*)::int FROM docs_document_versions) AS versions,
        (SELECT count(*)::int FROM docs_draft_changes) AS changes`)).rows[0];
      const before = await counts();
      for (const stage of [async()=>({id:'bad/id',revision:state.revision}),async()=>({id:'missing-revision'}),
        async()=>({id:published.id,revision:state.revision})]) {
        await assert.rejects(store.publishTabs(state.revision,actor,stage));
        assert.deepEqual(await store.read(),prior);assert.deepEqual(await counts(),before);
      }
      await pool.query(`CREATE FUNCTION fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$;
        CREATE TRIGGER fail_test_audit BEFORE INSERT ON docs_audit FOR EACH ROW
        WHEN (NEW.release_id='rollback-after-release') EXECUTE FUNCTION fail_test_audit()`);
      try {
        await assert.rejects(store.publishTabs(state.revision,actor,async()=>({id:'rollback-after-release',revision:state.revision})),/injected audit failure/);
        assert.deepEqual(await counts(),before);assert.deepEqual(await store.read(),prior);
        assert.equal(await store.hasRelease('rollback-after-release'),false);
      } finally { await pool.query('DROP TRIGGER fail_test_audit ON docs_audit;DROP FUNCTION fail_test_audit()'); }
      await assert.rejects(pool.query('INSERT INTO docs_draft_changes SELECT * FROM docs_draft_changes LIMIT 1'),/committed draft revision/);
      for (const table of ['docs_document_versions','docs_releases','docs_release_nodes','docs_audit','docs_draft_changes']) {
        await assert.rejects(pool.query(`DELETE FROM ${table}`),{code:'23514'});
      }
      await assert.rejects(pool.query(`INSERT INTO docs_release_nodes SELECT * FROM docs_release_nodes WHERE release_id=$1`,[published.id]),/committed release/);
      await assert.rejects(pool.query('UPDATE docs_drafts SET parent_id=node_id'),{code:'23514'});
      for (const table of ['docs_workspace','docs_history']) {
        assert.equal((await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name,null);
      }
      await migrate(pool,'postgres');assert.deepEqual(await store.read(),prior);
      // A committed release remains readable even when its draft identity is tombstoned.
      const doc = {...seed.nodes.find(n=>n.type==='markdown'),id:'tombstone',parentId:root.id};
      state = await store.saveNode(state.revision,doc,actor);
      state = await store.publishNode(state.revision,doc.id,1,actor,stager.stage);
      const historicalId = state.published.id;
      state = await store.deleteNode(state.revision,doc.id,actor,stager.stage);
      assert.ok((await pool.query('SELECT deleted_at FROM docs_node_identities WHERE id=$1',[doc.id])).rows[0].deleted_at);
      assert.equal((await store.releaseNodes(historicalId)).nodes.find(n=>n.id===doc.id).body,doc.body);
      assert.equal((await pool.query('SELECT deleted FROM docs_draft_changes WHERE revision=$1 AND node_id=$2',[state.revision,doc.id])).rows[0].deleted,true);
    });

    await t.test('all legacy releases and draft snapshots backfill without version collisions', async () => {
      await pool.query('CREATE DATABASE legacy_fixture');
      const legacyPool = new Pool({...connection,user:'docs_test',database:'legacy_fixture',ssl:false});
      try {
        await legacyPool.query(await readFile(new URL('../migrations/001-workspace.sql',import.meta.url),'utf8'));
        const plain = seed.nodes.map(({draftVersion,publishedVersion,...n})=>n);
        const older = plain.map(n=>n.id==='notes'?{...n,body:'first immutable body'}:n);
        const draft = plain.filter(n=>n.id!=='api').map(n=>n.id==='notes'?{...n,body:'unpublished draft'}:n);
        draft.push({...draft.at(-1),id:'fresh'});
        await legacyPool.query(`INSERT INTO docs_workspace VALUES(true,5,$1,'{"id":"legacy"}')`,[JSON.stringify(draft)]);
        for (const [revision,action,nodes,release] of [[1,'publish',older,{id:'old'}],[2,'save',older,null],
          [3,'publish',plain,{id:'legacy'}],[4,'save',draft,null]]) {
          await legacyPool.query('INSERT INTO docs_history(revision,action,actor,nodes,release) VALUES($1,$2,$3,$4,$5)',
            [revision,action,JSON.stringify(actor),JSON.stringify(nodes),release && JSON.stringify(release)]);
        }
        migrateWithoutFixtures('legacy_fixture');
        const legacyStore=createStore(legacyPool),upgraded=await legacyStore.read();
        assert.deepEqual(await legacyStore.current(),{id:'legacy'});
        assert.equal(upgraded.nodes.find(n=>n.id==='notes').draftVersion,2);
        assert.equal(upgraded.nodes.find(n=>n.id==='notes').publishedVersion,1);
        assert.equal(upgraded.nodes.at(-1).publishedVersion,null);
        assert.equal((await legacyStore.releaseNodes('old')).nodes.find(n=>n.id==='notes').body,'first immutable body');
        assert.equal((await legacyStore.releaseNodes('legacy')).nodes.find(n=>n.id==='notes').body,plain.find(n=>n.id==='notes').body);
        const audit=(await legacyPool.query('SELECT revision,metadata FROM docs_audit ORDER BY revision')).rows;
        assert.deepEqual(audit.filter(a=>a.metadata.draftSnapshot).map(a=>a.revision),[2,4,5]);
        assert.ok(audit.find(a=>a.revision===3).metadata.historicalDraftUnavailable);
        assert.equal((await legacyPool.query('SELECT count(*)::int AS n FROM docs_draft_changes WHERE revision=4')).rows[0].n,draft.length);
        const released=await legacyStore.publishNode(5,'fresh',1,actor,stager.stage);
        assert.equal((await legacyStore.releaseNodes(released.published.id)).nodes.find(n=>n.id==='notes').body,plain.find(n=>n.id==='notes').body);
        const recreated=await legacyStore.saveNode(6,plain.find(n=>n.id==='api'),actor);
        assert.equal(recreated.nodes.at(-1).draftVersion,2);assert.equal(recreated.nodes.at(-1).publishedVersion,1);
        await migrate(legacyPool,'legacy_fixture');await migrate(legacyPool,'legacy_fixture');
        assert.deepEqual(await legacyStore.read(),recreated);
        assert.deepEqual((await legacyPool.query('SELECT nodes FROM docs_history ORDER BY revision')).rows.map(r=>r.nodes),[older,older,plain,draft]);
        for (const table of ['docs_workspace','docs_history']) {
          await assert.rejects(legacyPool.query(`DELETE FROM ${table}`),{code:'55000'});
          await assert.rejects(legacyPool.query(`TRUNCATE ${table}`),{code:'55000'});
        }
        await legacyPool.query('DROP TABLE docs_workspace,docs_history; DROP FUNCTION docs_legacy_readonly()');
        await migrate(legacyPool,'legacy_fixture');
        assert.deepEqual(await legacyStore.read(),recreated);
        assert.equal((await legacyPool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,8);
        assert.equal((await legacyPool.query("SELECT to_regprocedure('docs_legacy_readonly()') AS name")).rows[0].name,null);
      } finally {await legacyPool.end();}
    });

    await t.test('1000-node publication validates the complete tree once and reuses versions', async () => {
      const roots=Array.from({length:1000},(_,i)=>({id:`root-${i}`,parentId:null,sort:i,title:`Root ${i}`,type:'group',body:'',draftVersion:1,publishedVersion:null}));
      await reset(roots);
      const state=await store.publishTabs(0,actor,stager.stage);
      assert.equal((await store.releaseNodes(state.published.id)).nodes.length,1000);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM docs_document_versions')).rows[0].n,1000);
      // Immediate constraint mode must also invalidate the transaction-local guard after subsequent statements.
      const client=await pool.connect();
      try {
        await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query("UPDATE docs_drafts SET parent_id='root-0' WHERE node_id='root-1'");
        await assert.rejects(client.query("UPDATE docs_drafts SET parent_id='root-1' WHERE node_id='root-0'"),{code:'23514'});
      } finally {await client.query('ROLLBACK');client.release();}
    });
    await reset(seed.nodes);
    // Each body fits on its own. The UTF-8 JSON array, including escaping and
    // other nodes, fits exactly at the limit and rejects one additional byte.
    const large = {...notes, id:'large-a', body:'界'.repeat(2 * 1024 * 1024)};
    const half = await store.saveNode(recreated.revision, large, actor);
    const last = {...notes, id:'large-b', body:'"\n'};
    const content = [...half.nodes, last].map(({id,parentId,sort,title,type,body}) => ({id,parentId,sort,title,type,body}));
    last.body += 'x'.repeat(12 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(content)));
    const full = await store.saveNode(half.revision, last, actor);
    await assert.rejects(store.saveNode(full.revision, {...last, body:last.body+'x'}, actor), {status:413});
    assert.equal((await store.read()).revision, full.revision);

  } finally {
    try { await pool.end(); } finally { if (!docker) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); }
  }
});
