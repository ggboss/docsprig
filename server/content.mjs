import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parseDocument, stringify } from 'yaml';
import { validate, validatePathParameters } from '@scalar/openapi-validator';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const keyPattern = new RegExp(`^releases/${uuid}/(?:api\\.yaml|(?:index|tree)\\.json|api/[0-9a-f]{64}\\.json|md/(?:[0-9a-f]{64}\\.md|badge\\.svg))$`, 'u');
const mime = { yaml: 'application/yaml', json: 'application/json', md: 'text/markdown; charset=utf-8', svg: 'image/svg+xml' };
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function contentType(key) { return mime[key.split('.').pop()]; }

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Zudoku 0.93.2: HttpMethods, getAllOperations/getAllTags and slugifyWithCounter.
const methods = ['get', 'put', 'post', 'patch', 'delete', 'options', 'head', 'trace'];
function countedSlug() {
  const counts = new Map();
  return text => {
    const base = text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
      .replace(/['‘’“”]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
}
function parseBody(body) {
  if (typeof body !== 'string') fail('Expected an API document body');
  const doc = parseDocument(body, { uniqueKeys: true, stringKeys: true });
  if (doc.errors.length || doc.warnings.length) fail('Invalid OpenAPI YAML');
  try { return doc.toJS({ maxAliasCount: 0 }); } catch { fail('YAML aliases are not supported'); }
}
function resolvePointer(api, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) fail('Only local JSON Pointer references are supported');
  let pointer;
  try { pointer = decodeURIComponent(ref.slice(2)); } catch { fail('Malformed reference'); }
  let target = api;
  for (const token of pointer.split('/')) {
    if (/~(?![01])/.test(token)) fail('Malformed JSON Pointer');
    const part = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, part)) fail('Unresolved OpenAPI reference');
    target = target[part];
  }
  return target;
}
// Resolve only the shallow objects needed for navigation and path-parameter checks;
// recursive component schemas are valid and must not be recursively expanded.
function resolveObject(api, value) {
  const chain = [], seen = new Set();
  while (value?.$ref) {
    if (seen.has(value)) fail('Circular OpenAPI object reference');
    seen.add(value);
    chain.push(value);
    value = resolvePointer(api, value.$ref);
  }
  return chain.length ? Object.assign(Object.create(null), value, ...chain.reverse()) : value;
}
function checkContract(api) {
  if (!/^3\.[01]\.\d+$/.test(api?.openapi) || !record(api.paths)) fail('Expected OpenAPI 3 with paths');
  const pending = [api];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [name, child] of Object.entries(value)) {
      if (['$id', '$dynamicRef', '$recursiveRef'].includes(name)) fail(`Unsupported reference feature: ${name}`);
      if (name === '$ref' || name === 'operationRef') resolvePointer(api, child);
      pending.push(child);
    }
  }
  if (!validate(api).valid) fail('Invalid OpenAPI structure');
}

// Count actual Operation Objects, not lookalike keys in schemas or examples. A
// reusable callback/path component may be reached repeatedly, including recursively.
function validateOperations(api, primary) {
  const ids = new Map(), seen = new Set(), pending = [...primary], links = [];
  const values = obj => Object.entries(obj ?? {}).filter(([k]) => !k.startsWith('x-')).map(([,v]) => v);
  function addPath(entry) {
    const item = resolveObject(api, entry);
    for (const method of methods) if (item?.[method]) pending.push(item[method]);
  }
  function addCallback(callback) { values(resolveObject(api, callback)).forEach(addPath); }
  Object.values(api.webhooks ?? {}).forEach(addPath);
  Object.values(api.components?.pathItems ?? {}).forEach(addPath);
  Object.values(api.components?.callbacks ?? {}).forEach(addCallback);
  function addResponse(response) { links.push(...Object.values(resolveObject(api, response)?.links ?? {})); }
  Object.values(api.components?.responses ?? {}).forEach(addResponse);
  links.push(...Object.values(api.components?.links ?? {}));
  while (pending.length) {
    const op = pending.pop();
    if (seen.has(op)) continue;
    seen.add(op);
    if (op.operationId !== undefined) {
      if (ids.has(op.operationId)) fail(`Duplicate operationId: ${op.operationId}`);
      ids.set(op.operationId, op);
    }
    Object.values(op.callbacks ?? {}).forEach(addCallback);
    values(op.responses).forEach(addResponse);
  }
  for (const link of links) {
    const target = resolveObject(api, link);
    if (target?.operationId !== undefined && !ids.has(target.operationId)) fail('Unresolved link operationId');
    if (target?.operationRef !== undefined && !seen.has(resolvePointer(api, target.operationRef))) fail('Invalid link operationRef');
  }
}

const kindKey = 'x-open-docs-document-kind';
const defaultDialect = 'https://spec.openapis.org/oas/3.1/dialect/base';

// Marked documents are self-contained. Unmarked OpenAPI documents retain their
// historical meaning as the optional shared base; fragments remain supported.
function describe(body) {
  const value = parseBody(body);
  if (!record(value)) fail('Expected an API document object');
  if (Object.hasOwn(value, kindKey)) {
    if (value[kindKey] !== 'operation') fail('Unsupported x-open-docs-document-kind');
    if (value.openapi !== '3.1.0') fail('Operation documents require OpenAPI 3.1.0');
    checkContract(value);
    const paths = Object.keys(value.paths).filter(key => key.startsWith('/'));
    if (paths.length !== 1) fail('Operation documents require exactly one path and method');
    const path = paths[0], entry = value.paths[path];
    if (!record(entry) || Object.hasOwn(entry, '$ref')) fail('Operation documents do not support referenced path items');
    const selected = methods.filter(method => Object.hasOwn(entry, method));
    if (selected.length !== 1) fail('Operation documents require exactly one path and method');
    if (Object.hasOwn(value, 'webhooks')) fail('Operation documents do not support top-level webhooks');
    if (entry[selected[0]].callbacks || value.components?.callbacks || value.components?.pathItems)
      fail('Operation documents do not support callbacks or reusable path items in aggregation');
    // Relocating these pointers would change their meaning in the aggregate.
    const pending = [value];
    while (pending.length) {
      const part = pending.pop();
      if (!part || typeof part !== 'object') continue;
      for (const [key, child] of Object.entries(part)) {
        if ((key === '$ref' || key === 'operationRef') &&
            !/^#\/(?:components|paths)\//.test(child)) fail('Operation document references must target components or paths');
        pending.push(child);
      }
    }
    return { value, path, method: selected[0], operation: entry[selected[0]], standalone: true };
  }
  if (Object.hasOwn(value, 'openapi')) return { value, base: true };
  const method = typeof value.method === 'string' && value.method.toLowerCase();
  if (!methods.includes(method) || typeof value.path !== 'string' || !value.path.startsWith('/') ||
      !record(value.operation) || Object.keys(value).some(k => !['path', 'method', 'operation'].includes(k)))
    fail('Expected {path, method, operation}');
  return { value, method, path: value.path, operation: value.operation };
}

function mergeField(target, key, value, label) {
  if (Object.hasOwn(target, key) && !isDeepStrictEqual(target[key], value)) fail(`Conflicting ${label}: ${key}`);
  Object.defineProperty(target, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
}

function mergeDocument(api, document) {
  if (!api.openapi.startsWith('3.1.')) fail('无法发布：OpenAPI 3.1.0 单接口文档不能与 OpenAPI 3.0 基础契约合并。请先将基础契约完整迁移并验证为 OpenAPI 3.1，再发布；不要只修改版本号。', 422);
  if ((api.jsonSchemaDialect ?? defaultDialect) !== (document.jsonSchemaDialect ?? defaultDialect))
    fail('Conflicting jsonSchemaDialect in operation documents');
  for (const [key, value] of Object.entries(document)) {
    // Info belongs to the individual document. The aggregate has the base's
    // Info (or the service default); individual contracts preserve their Info.
    // Servers/security are applied to the operation below, never globally.
    if (['openapi', 'info', 'paths', 'servers', 'security', kindKey].includes(key)) continue;
    if (key === 'components') {
      api.components ??= {};
      for (const [category, entries] of Object.entries(value)) {
        if (category.startsWith('x-')) { mergeField(api.components, category, entries, 'components metadata'); continue; }
        if (!Object.hasOwn(api.components, category)) Object.defineProperty(api.components, category,
          { value: {}, enumerable: true, writable: true, configurable: true });
        for (const [name, component] of Object.entries(entries)) mergeField(api.components[category], name, component, `component ${category}`);
      }
    } else if (key === 'tags') {
      api.tags ??= [];
      for (const tag of value) {
        const previous = api.tags.find(item => item.name === tag.name);
        if (previous && !isDeepStrictEqual(previous, tag)) fail(`Conflicting tag metadata: ${tag.name}`);
        if (!previous) api.tags.push(structuredClone(tag));
      }
    } else mergeField(api, key, value, 'document metadata');
  }
  for (const [key, value] of Object.entries(document.paths))
    if (!key.startsWith('/')) mergeField(api.paths, key, value, 'paths metadata');
}

export function validateApiDraft(body, nodes = [], previousBody) {
  // Inspect the stored discriminator before classifying the replacement. Removing
  // it must not silently turn an existing standalone document into a shared base.
  let previous;
  if (previousBody !== undefined) {
    try { previous = parseBody(previousBody); } catch { /* Legacy unfinished drafts can still be repaired. */ }
  }
  if (previous?.[kindKey] === 'operation' && parseBody(body)?.[kindKey] !== 'operation')
    fail('不能更改单接口文档的类型：请保留 x-open-docs-document-kind: operation 标记。删除或修改该标记会将文档误识别为共享基础契约；如需基础契约，请新建独立文档。', 422);
  const selected = describe(body);
  const row = { body, item: { id: 'selected' } };
  if (selected.standalone || selected.base) compile([row]);
  else {
    const bases = [];
    for (const node of nodes) {
      if (node.type !== 'api') continue;
      let other;
      try { other = describe(node.body); } catch { continue; }
      if (other.base) bases.push({ body: node.body, item: { id: node.id } });
    }
    compile([...bases, row]);
  }
}

export function operationDocument(body) {
  const document = describe(body);
  if (!document.standalone) return null;
  compile([{ body, item: { id: 'preview' } }]);
  return document.value;
}

// A full contract is an optional base, not an endpoint. Keep its bytes when unmodified.
function compile(rows) {
  let base;
  const leaves = [], owners = new Map();
  for (const row of rows) {
    const document = describe(row.body);
    if (document.base) {
      if (base || !record(document.value.paths)) fail('Expected at most one base contract with paths');
      checkContract(document.value);
      base = { ...row, value: document.value };
    } else leaves.push({ ...row, ...document });
    row.item.detailRoutes = [];
  }
  const api = base ? structuredClone(base.value) : { openapi: '3.1.0', info: { title: '服务端 API', version: '1' }, paths: {} };
  // Validate each marked document in isolation before merging: another node
  // must never supply a missing reference for a supposedly standalone contract.
  for (const leaf of leaves.filter(leaf => leaf.standalone)) {
    compile([{ body: stringify(Object.fromEntries(Object.entries(leaf.value).filter(([key]) => key !== kindKey))),
      item: { id: leaf.item.id } }]);
    mergeDocument(api, leaf.value);
  }
  const pathContext = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([key]) => !methods.includes(key) && key !== 'servers'));
  for (const leaf of leaves) {
    const { method, path, item } = leaf;
    const operation = structuredClone(leaf.operation);
    const hadPath = Object.hasOwn(api.paths, path);
    const entry = api.paths[path] ??= {};
    if (!record(entry) || '$ref' in entry || method in entry) fail(`Conflicting operation: ${method} ${path}`);
    if (leaf.standalone) {
      const ownPath = leaf.value.paths[path];
      if (hadPath && !isDeepStrictEqual(pathContext(entry), pathContext(ownPath)))
        fail(`Conflicting path metadata: ${path}`);
      for (const [key, value] of Object.entries(pathContext(ownPath))) mergeField(entry, key, value, `path metadata ${path}`);
      if (leaves.some(other => !other.standalone && other.path === path) &&
          !isDeepStrictEqual(pathContext(ownPath), pathContext(base?.value.paths[path])))
        fail(`Conflicting path metadata with legacy operation: ${path}`);
      operation.security ??= structuredClone(leaf.value.security ?? []);
      operation.servers ??= structuredClone(ownPath.servers ?? leaf.value.servers ?? [{ url: '/' }]);
    }
    entry[method] = operation;
    owners.set(`${method} ${path}`, item);
  }
  checkContract(api);
  const primary = new Set(), routes = new Set(), tags = new Map(), templates = new Set();
  const categories = new Set();
  const opSlug = countedSlug(), tagSlug = countedSlug();
  for (const [path, entry] of Object.entries(api.paths)) {
    if (!path.startsWith('/')) continue; // paths-level specification extensions
    const template = path.replace(/\{[^{}]+\}/g, '{}');
    if (templates.has(template)) fail(`Duplicate path template: ${path}`);
    templates.add(template);
    const pathItem = resolveObject(api, entry);
    const resolvedParams = obj => obj?.parameters?.map(param => resolveObject(api, param));
    const parameterView = { parameters: resolvedParams(pathItem) };
    for (const method of methods) {
      const op = pathItem?.[method];
      if (!op) continue;
      parameterView[method] = { parameters: resolvedParams(op) };
      if (op.operationId !== undefined && primary.has(op)) fail(`Duplicate operationId: ${op.operationId}`);
      primary.add(op);
      const slug = opSlug(op.summary || op.operationId || `${method}-${path}`);
      const owner = owners.get(`${method} ${path}`) ?? base.item;
      const groups = op.tags?.length ? new Set(op.tags) : [null];
      for (const tag of groups) {
        if (tag !== null && !tags.has(tag)) {
          const category = tagSlug(tag);
          if (categories.has(category)) fail(`Conflicting Zudoku tag: ${tag}`);
          categories.add(category);
          tags.set(tag, category);
        }
        const category = tag === null ? '~endpoints' : tags.get(tag);
        const route = `/api/${category}#${slug}`;
        if (!category || !slug || routes.has(route)) fail(`Unaddressable Zudoku operation: ${method} ${path}`);
        routes.add(route);
        owner.detailRoutes.push(route);
      }
    }
    const [error] = validatePathParameters({ paths: { [path]: parameterView } });
    if (error) fail(error.message);
  }
  validateOperations(api, primary);
  const documents = new Map();
  if (base) documents.set(base.item.id, base.value);
  for (const leaf of leaves) {
    if (leaf.standalone) { documents.set(leaf.item.id, leaf.value); continue; }
    const { paths, webhooks, ...context } = api;
    const pathItem = resolveObject(api, paths[leaf.path]);
    const pathContext = Object.fromEntries(Object.entries(pathItem).filter(([key]) => !methods.includes(key) && key !== '$ref'));
    const document = { ...context, paths: { [leaf.path]: { ...pathContext, [leaf.method]: leaf.operation } } };
    checkContract(document);
    documents.set(leaf.item.id, document);
  }
  return { aggregate: base && !leaves.length ? base.body : stringify(api), documents };
}

async function prepare({ nodes, revision }, id, requested) {
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(nodes)) fail('Invalid revision or nodes');
  const base = `/content/dev/releases/${id}/`;
  const files = new Map(), byId = new Map(), groups = new Map(), entries = [];
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || !n.id.trim() || byId.has(n.id) || !Number.isFinite(n.sort) ||
        typeof n.title !== 'string' || !n.title.trim() || !['group','api','markdown'].includes(n.type) ||
        (n.type !== 'group' && typeof n.body !== 'string')) fail('Invalid or duplicate content node');
    if (n.parentId === null && n.type !== 'group') fail('Invalid section root');
    byId.set(n.id, n);
    if (!groups.has(n.parentId)) groups.set(n.parentId, []);
    groups.get(n.parentId).push(n);
  }
  for (const n of nodes) if (n.parentId !== null && byId.get(n.parentId)?.type !== 'group') fail('Invalid parent group');
  for (const siblings of groups.values()) siblings.sort((a,b) => a.sort - b.sort || (a.id < b.id ? -1 : 1));
  const tree = [];
  const apiRows = [];
  let badge = false;
  function branch(n, section) {
    const { id, parentId, sort, title, type } = n;
    const item = { id, parentId, sort, title, type };
    tree.push(item);
    if (type === 'group') return;
    if (type === 'api') {
      apiRows.push({ item, body: n.body });
      item.url = base + `api/${createHash('sha256').update(JSON.stringify(id)).digest('hex')}.json`;
      return;
    }
    const key = `md/${createHash('sha256').update(JSON.stringify(id)).digest('hex')}.md`;
    badge ||= n.body.includes('./badge.svg');
    if (section === 'changelog') entries.push({ title, markdown: base + key });
    if (!requested || requested === key) files.set(key, n.body);
    item.url = base + key;
  }
  const pending = (groups.get(null) ?? []).map(n => [n, n.id]).reverse();
  while (pending.length) {
    const [n, section] = pending.pop();
    branch(n, section);
    const children = groups.get(n.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) pending.push([children[i], section]);
  }
  if (tree.length !== nodes.length) fail('Content tree contains a cycle');
  // Markdown reads skip API compilation; the tree retains legacy detail-route metadata.
  if (!requested || requested === 'tree.json' || requested === 'api.yaml' || requested.startsWith('api/')) {
    const { aggregate, documents } = compile(apiRows);
    files.set('api.yaml', aggregate);
    for (const { item } of apiRows) files.set(item.url.slice(base.length), JSON.stringify(documents.get(item.id)));
  }
  if (badge && (!requested || requested === 'md/badge.svg')) files.set('md/badge.svg', await readFile(new URL('../public/content/dev/releases/demo-001/badge.svg', import.meta.url)));
  files.set('index.json', JSON.stringify({ entries }));
  files.set('tree.json', JSON.stringify({ roots: (groups.get(null) ?? []).map(node => node.id), nodes: tree }));
  return files;
}

// The repository persists immutable publication snapshots transactionally. This
// service validates snapshots and renders HTTP representations; it never stores files.
export function createContent({ loadRelease, cacheMaxEntries = 128, cacheMaxBytes = 32 * 1024 * 1024 } = {}) {
  for (const limit of [cacheMaxEntries, cacheMaxBytes])
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Content cache limits must be non-negative safe integers');
  // Cache rendered bytes, never mutable drafts or repository snapshots. API/tree
  // representations share one entry because prepare compiles them together.
  const cache = new Map(), pending = new Map();
  let cacheBytes = 0;
  const enabled = cacheMaxEntries > 0 && cacheMaxBytes > 0;
  async function render(id, resource, compiled) {
    const snapshot = await loadRelease(id);
    if (!snapshot) fail('Published release not found', 404);
    const representations = await prepare(snapshot, id, compiled ? undefined : resource);
    const files = new Map();
    let bytes = 0;
    for (const [name, value] of representations) {
      if (!compiled && name !== resource) continue;
      const body = Buffer.from(value);
      files.set(name, body);
      bytes += body.length + Buffer.byteLength(name);
    }
    return { files, bytes };
  }
  function retain(key, entry) {
    if (!enabled || cache.has(key) || entry.bytes > cacheMaxBytes) return;
    while (cache.size >= cacheMaxEntries || cacheBytes + entry.bytes > cacheMaxBytes) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    cache.set(key, entry);
    cacheBytes += entry.bytes;
  }
  return {
    async stage(snapshot) {
      const id = randomUUID();
      await prepare(snapshot, id);
      return { id, revision: snapshot.revision };
    },
    async read(key) {
      if (typeof key !== 'string' || !keyPattern.test(key) || /\s/.test(key)) fail('Invalid release key', 404);
      if (typeof loadRelease !== 'function') throw new Error('Published release repository is required');
      const [, id, ...parts] = key.split('/');
      const resource = parts.join('/');
      const compiled = resource === 'tree.json' || resource === 'api.yaml' || resource.startsWith('api/');
      // Compiling a release tree also renders its Markdown resources. Reuse
      // those bytes for public search/read instead of reloading the snapshot.
      const compiledKey = `${id}/compiled`;
      const cacheKey = !compiled && cache.get(compiledKey)?.files.has(resource)
        ? compiledKey : `${id}/${compiled ? 'compiled' : resource}`;
      let entry = cache.get(cacheKey);
      if (entry) {
        cache.delete(cacheKey);
        cache.set(cacheKey, entry); // Refresh LRU position.
      } else {
        let work = pending.get(cacheKey);
        if (!work) {
          work = render(id, resource, compiled);
          // Bound retained in-flight work too. Overflow requests still render,
          // but do not grow the coalescing map or displace active requests.
          if (enabled && pending.size < cacheMaxEntries) {
            work = work.finally(() => pending.delete(cacheKey));
            pending.set(cacheKey, work);
          }
        }
        entry = await work;
      }
      const value = entry.files.get(resource);
      if (value === undefined) fail('Content not found', 404);
      // Failed reads (including missing assets) never populate the cache.
      retain(cacheKey, entry);
      return { body: Buffer.from(value), contentType: contentType(resource) };
    },
  };
}
