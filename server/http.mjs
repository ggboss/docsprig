import { operationDocument } from './content.mjs';
import { validId } from './store.mjs';
import { handleAuthRoute } from './auth-routes.mjs';
import { parseDocument } from 'yaml';
import { validate } from '@scalar/openapi-validator';

const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const maxBytes = 4 * 1024 * 1024;
async function jsonBody(req, limit = maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(415, '需要 application/json');
  if (Number(req.headers['content-length']) > limit) throw fail(413,'请求内容过大');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413,'请求内容过大'); chunks.push(chunk); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400,'JSON 格式错误'); }
  return data;
}
async function input(req) {
  const data = await jsonBody(req);
  if (!Number.isSafeInteger(data?.revision) || data.revision < 0) throw fail(400,'缺少有效草稿版本');
  return data;
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const methods = ['get', 'put', 'post', 'patch', 'delete', 'options', 'head', 'trace'];
function previewBody(body) {
  try {
    if (typeof body !== 'string' || Buffer.byteLength(body) > maxBytes) throw Error();
    const doc = parseDocument(body, { uniqueKeys: true, stringKeys: true });
    if (doc.errors.length || doc.warnings.length) throw Error();
    const value = doc.toJS({ maxAliasCount: 0 });
    if (!record(value)) throw Error();
    return value;
  } catch { throw fail(422, '接口草稿不是有效的 YAML/JSON 对象'); }
}
export function previewContract(node, nodes, value = previewBody(node.body)) {
  if (Object.hasOwn(value, 'x-open-docs-document-kind')) {
    try { return operationDocument(node.body); }
    catch (error) { throw fail(422, error.message); }
  }
  let api = value;
  if (!Object.hasOwn(value, 'openapi')) {
    const method = typeof value.method === 'string' && value.method.toLowerCase();
    if (!methods.includes(method) || typeof value.path !== 'string' || !value.path.startsWith('/') ||
        !record(value.operation) || Object.keys(value).some(key => !['path', 'method', 'operation'].includes(key)))
      throw fail(422, '接口草稿需要 path、method 和 operation');
    const bases = [];
    for (const other of nodes) {
      if (other.id === node.id || other.type !== 'api') continue;
      // An unrelated unfinished operation must not prevent previewing this draft.
      let candidate;
      try { candidate = previewBody(other.body); } catch { continue; }
      if (Object.hasOwn(candidate, 'openapi') && !Object.hasOwn(candidate, 'x-open-docs-document-kind')) bases.push(candidate);
    }
    if (bases.length > 1) throw fail(422, '存在多个基础接口契约');
    const base = bases[0] ?? { info: { title: node.title || '接口预览', version: 'draft' } };
    const pathItem = base.paths?.[value.path] ?? {};
    if (!record(pathItem) || Object.hasOwn(pathItem, '$ref')) throw fail(422, '预览暂不支持引用的路径项');
    const context = Object.fromEntries(Object.entries(pathItem).filter(([key]) => !methods.includes(key)));
    // Keep shared schemas, auth, servers, tags and path parameters, but expose
    // only the selected operation. Webhooks are separate operations as well.
    const { paths, webhooks, ...metadata } = base;
    api = { ...metadata, openapi: base.openapi ?? '3.1.0', paths: { [value.path]: { ...context, [method]: value.operation } } };
  }
  try {
    if (!/^3\.[01]\.\d+$/.test(api.openapi) || !record(api.paths) || !validate(api).valid) throw Error();
  } catch { throw fail(422, '接口草稿不是有效的 OpenAPI 文档'); }
  return api;
}

export function handler({ store, content, authenticate, origin, mcpToken }) {
  const allowedOrigin = new URL(origin).origin;
  return async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      if (await handleAuthRoute(req, res, allowedOrigin)) return;
      const path = (req.url ?? '').split('?')[0];
      const actor = /^\/manage(?:\/|$)/.test(path) ? await authenticate(req) : undefined;
      if (path === '/manage/mcp-config') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          throw fail(405, '只支持 POST');
        }
        if (req.headers.origin !== allowedOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '请求来源未获授权');
        const token = mcpToken === undefined ? process.env.DOCS_MCP_TOKEN : mcpToken;
        if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /\s/.test(token))
          throw fail(503, 'MCP 配置暂时不可用');
        const name = 'docsprig-admin', url = `${allowedOrigin}/mcp/admin`;
        return json(res, 200, { name, url, config: { mcpServers: {
          [name]: { url, headers: { Authorization: `Bearer ${token}` } },
        } } });
      }
      if (path === '/content/site-name.json') {
        if (req.method !== 'GET') throw fail(405,'只支持 GET');
        return json(res,200,await store.siteName());
      }
      if (path === '/manage/site-name') {
        if (req.method !== 'PUT') throw fail(405,'只支持 PUT');
        if (req.headers.origin !== allowedOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403,'请求来源未获授权');
        const data = await jsonBody(req, 4096);
        if (!record(data) || Object.keys(data).length !== 1 || typeof data.name !== 'string') throw fail(400,'请只提供站点名称');
        return json(res,200,await store.setSiteName(data.name));
      }
      if (path === '/manage/preview') {
        if (req.method !== 'GET') throw fail(405, '只允许读取');
        const query = new URL(req.url, 'http://local.invalid').searchParams;
        const id = query.get('doc');
        if (query.getAll('doc').length !== 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(id ?? '') ||
            [...query.keys()].some(key => !['doc', 'v'].includes(key))) throw fail(400, '请指定有效的 doc 节点');
        // Workspace revision is a cache key only; always read the current draft.
        const version = query.get('v');
        if (query.getAll('v').length > 1 || (version !== null &&
            (!/^(?:0|[1-9][0-9]*)$/.test(version) || !Number.isSafeInteger(Number(version)))))
          throw fail(400, 'v 必须是非负安全整数');
        // Most API nodes are self-contained. Do not transfer every document body
        // from PostgreSQL just to preview one endpoint. Legacy fragments still
        // need a consistent workspace snapshot to resolve their shared base.
        let nodes, node;
        if (store.readNode) node = await store.readNode(id);
        else { ({ nodes } = await store.read()); node = nodes.find(n => n.id === id); }
        if (!node) throw fail(404, '接口节点不存在');
        if (node.type !== 'api') throw fail(400, '仅支持接口节点预览');
        let value = previewBody(node.body);
        if (!nodes && !Object.hasOwn(value, 'openapi') && !Object.hasOwn(value, 'x-open-docs-document-kind')) {
          ({ nodes } = await store.read());
          node = nodes.find(n => n.id === id);
          if (!node) throw fail(404, '接口节点不存在');
          if (node.type !== 'api') throw fail(400, '仅支持接口节点预览');
          value = previewBody(node.body);
        }
        return json(res, 200, previewContract(node, nodes ?? [], value));
      }
      if (path === '/manage/session') {
        if (req.method !== 'GET') throw fail(405,'只允许读取');
        return json(res,200,{admin:true});
      }
      if (path === '/manage/tabs' || path === '/manage/tabs/publish') {
        const publish = path.endsWith('/publish');
        if (!(publish ? ['POST'] : ['PUT', 'DELETE']).includes(req.method)) throw fail(405, '不支持的方法');
        if (req.headers.origin !== allowedOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '请求来源未获授权');
        const data = await input(req);
        if (!publish && req.method === 'DELETE') {
          if (Object.keys(data).some(key => !['revision', 'id'].includes(key)) || !validId(data.id))
            throw fail(400, '请指定要删除的栏目');
          return json(res, 200, await store.deleteTab(data.revision, data.id, actor, snapshot => content.stage(snapshot)));
        }
        if (Object.keys(data).some(key => !(publish ? ['revision'] : ['revision', 'tabs']).includes(key)))
          throw fail(400, '栏目请求包含不支持的字段');
        const next = publish
          ? await store.publishTabs(data.revision, actor, snapshot => content.stage(snapshot))
          : await store.saveTabs(data.revision, data.tabs, actor);
        return json(res, 200, next);
      }
      if (['/manage/workspace','/manage/node','/manage/node/move','/manage/publish'].includes(path)) {
        const method = req.method;
        const allowed = {'/manage/workspace':['GET'],'/manage/node':['PUT','DELETE'],'/manage/node/move':['POST'],'/manage/publish':['POST']}[path];
        if (!allowed.includes(method)) throw fail(405,'不支持的方法');
        if (req.method !== 'GET' && (req.headers.origin !== allowedOrigin || req.headers['sec-fetch-site'] === 'cross-site')) throw fail(403,'请求来源未获授权');
        if (req.method === 'GET') return json(res,200,await store.read());
        const data = await input(req);
        if (Object.hasOwn(data,'nodes')) throw fail(400,'一次只能操作一个节点');
        if (path === '/manage/node/move') {
          const { revision, id, parentId, beforeId } = data;
          if (Object.keys(data).some(k => !['revision','id','parentId','beforeId'].includes(k)) ||
              !validId(id) || !validId(parentId) || (beforeId !== null && !validId(beforeId)))
            throw fail(400,'请指定节点、目标父目录和插入位置');
          return json(res,200,await store.moveNode(revision,id,parentId,beforeId,actor));
        }
        if (method === 'DELETE') {
          if (Object.keys(data).some(k => !['revision','id'].includes(k)) || typeof data.id !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,128}$/.test(data.id)) throw fail(400,'请指定要删除的节点');
          return json(res,200,await store.deleteNode(data.revision,data.id,actor,snapshot => content.stage(snapshot)));
        }
        if (method === 'PUT' && (!data.node || typeof data.node !== 'object' || Array.isArray(data.node))) throw fail(400,'缺少节点');
        if (method === 'POST' && (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.id) || !Number.isSafeInteger(data.draftVersion) || data.draftVersion < 1)) throw fail(400,'请指定要发布的节点和草稿版本');
        const next = method === 'PUT' ? await store.saveNode(data.revision,data.node,actor) : await store.publishNode(data.revision,data.id,data.draftVersion,actor,snapshot => content.stage(snapshot));
        return json(res,200,next);
      }
      const match = /^\/content\/dev\/(?:(current)\/(api\.yaml|index\.json|tree\.json)|releases\/([\w-]{1,128})\/([\w.-]+(?:\/[\w.-]+)*))$/.exec(path);
      if (!match) throw fail(404,'地址不存在');
      if (!['GET','HEAD'].includes(req.method)) throw fail(405,'只允许读取');
      let id = match[3], file = match[2] || match[4];
      if (file.split('/').some(part => part === '.' || part === '..')) throw fail(404,'地址不存在');
      if (match[1]) { const release = await store.current(); if (!release) throw fail(404,'尚未发布内容'); id = release.id; }
      else if (!await store.hasRelease(id)) throw fail(404,'发布版本不存在');
      const { body,contentType } = await content.read(`releases/${id}/${file}`);
      res.writeHead(200, { 'Content-Type':contentType, 'Content-Length':body.length,
        'Content-Security-Policy':"default-src 'none'; sandbox", 'Cache-Control':match[1] ? 'no-store' : 'public, max-age=31536000, immutable' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      // Do not expose upstream response bodies, storage identifiers, or signing diagnostics to clients.
      if (err.code && err.name !== 'SyntaxError') {
        console.error('docs upstream request failed', String(err.code).replace(/[^A-Za-z0-9_-]/g,'').slice(0,64));
        return json(res,503,{error:'存储或数据库暂时不可用'});
      }
      const code = Number(err.status); const status = [400,401,403,404,405,409,413,415,422,503].includes(code) ? code : 500;
      if (status === 500) console.error('docs request failed',err.code ?? err.name);
      json(res,status,{error:status === 500 ? '服务暂时无法完成此请求' : err.message});
    }
  };
}
