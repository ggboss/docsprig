import { parse, stringify } from 'yaml';

export function operationTemplate(id: string) {
  return stringify({openapi:'3.1.0','x-open-docs-document-kind':'operation',
    info:{title:'接口文档',version:'1.0.0'},paths:{'/example':{get:{summary:'示例接口',
      operationId:`operation_${id.replaceAll('-', '')}`,responses:{'200':{description:'成功'}}}}}});
}
const map = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
export function operationError(body: string) {
  try {
    const v: unknown = parse(body);
    if (map(v) && 'openapi' in v) {
      if (typeof v.openapi !== 'string' || !/^3\.[01]\.\d+$/.test(v.openapi) || !map(v.paths) || !map(v.info)) return '需要有效的 OpenAPI 3 文档、info 与 paths。';
      if (v['x-open-docs-document-kind'] === 'operation') {
        if (v.openapi !== '3.1.0') return '新建单接口文档使用 OpenAPI 3.1.0。';
        const paths = Object.entries(v.paths).filter(([k]) => k.startsWith('/'));
        if (paths.length !== 1 || !map(paths[0][1])) return '单接口文档需要一条请求路径。';
        const ops = Object.entries(paths[0][1]).filter(([k]) => /^(get|put|post|delete|options|head|patch|trace)$/.test(k));
        if (ops.length !== 1 || !map(ops[0][1])) return '每个接口节点需要且只能有一个 HTTP 方法。';
        if (!map(ops[0][1].responses) || !Object.keys(ops[0][1].responses).some(k=>/^(default|[1-5](?:\d\d|XX))$/.test(k))) return '请至少添加一个响应（例如 200）。';
      }
      return '';
    }
    if (!map(v) || Object.keys(v).some(k => !['path','method','operation'].includes(k))) return '请填写完整的 OpenAPI 文档，或包含 path、method、operation 的兼容片段。';
    if (typeof v.path !== 'string' || !v.path.startsWith('/')) return 'path 必须以 / 开头。';
    if (typeof v.method !== 'string' || !/^(get|put|post|delete|options|head|patch|trace)$/i.test(v.method)) return 'method 应为HTTP 方法，例如 get。';
    if (!map(v.operation) || !text(v.operation.summary) || !text(v.operation.operationId)) return 'operation 中需要填写 summary 和 operationId。';
    if (!map(v.operation.responses) || !Object.keys(v.operation.responses).length) return 'operation.responses 至少需要一个响应。';
  } catch (e) { return `YAML 解析失败：${e instanceof Error ? e.message : '请检查缩进。'}`; }
  return '';
}
