export const parameterTypes = {string:'文本', integer:'整数', number:'数字', boolean:'布尔', object:'对象', array:'数组', null:'空值'} as const;
export function typeLabel(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(parameterTypes,value) ? parameterTypes[value as keyof typeof parameterTypes] : '未指定';
}

type Dict = Record<string, unknown>;
export const record = (value: unknown): value is Dict => value !== null && typeof value === 'object' && !Array.isArray(value);

// An unsupported node is opaque, not an empty object awaiting initialization.
export function editable(value: unknown): value is Dict {
  return record(value) && !['$ref', '$dynamicRef', '$recursiveRef', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'prefixItems'].some(k => Object.hasOwn(value, k)) &&
    !Array.isArray(value.items) &&
    (value.type === undefined || (typeof value.type === 'string' && Object.hasOwn(parameterTypes, value.type)) || nullableType(value.type));
}
export function nullableType(type: unknown): type is string[] {
  return Array.isArray(type) && type.length === 2 && type.includes('null') && type.filter(t => t !== 'null').length === 1 && type.filter(t => t !== 'null').every(t => typeof t === 'string' && Object.hasOwn(parameterTypes, t));
}
export function composition(value: unknown): 'anyOf' | 'oneOf' | 'allOf' | undefined {
  if (!record(value) || ['$ref', '$dynamicRef', '$recursiveRef'].some(k => Object.hasOwn(value,k))) return;
  const keys = (['anyOf', 'oneOf', 'allOf'] as const).filter(k => Object.hasOwn(value,k));
  const variants = keys.length === 1 ? value[keys[0]] : undefined;
  if (Array.isArray(variants) && variants.length > 0) return keys[0];
}
export function kind(schema: Dict) {
  return (nullableType(schema.type) ? schema.type.find(t => t !== 'null') : schema.type) ?? (schema.properties !== undefined ? 'object' : schema.items !== undefined ? 'array' : '');
}

function briefType(schema: unknown): string {
  if (schema === undefined) return '未指定';
  if (record(schema) && typeof schema.$ref === 'string') return `引用：${schema.$ref}`;
  return editable(schema) ? typeLabel(kind(schema)) : '复杂结构';
}
export function schemaSummary(schema: unknown): string {
  const combined = composition(schema);
  if (combined) return `${combined === 'allOf' ? '同时满足' : combined === 'oneOf' ? '任选一种' : '多种类型'}（${((schema as Dict)[combined] as unknown[]).length} 种结构）`;
  if (!editable(schema)) return briefType(schema);
  switch (kind(schema)) {
    case 'object': return record(schema.properties) || schema.properties === undefined
      ? `对象（${Object.keys(schema.properties ?? {}).length} 个字段）` : '对象（复杂结构）';
    case 'array': return `数组（元素：${briefType(schema.items)}）`;
    default: return briefType(schema);
  }
}
