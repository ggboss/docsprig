// Reject encoded separators/traversal as well as redirects outside published content.
export function publishedURL(value: string, base: string): string {
  if (!value.trim()) throw Error('内容地址为空');
  const url = new URL(value, base), origin = new URL(base).origin;
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin || url.username || url.password ||
      !url.pathname.startsWith('/content/') || /[\\\x00-\x1f\x7f]/.test(value) ||
      /%(?:2e|2f|5c|25|00)/i.test(url.pathname)) throw Error('内容地址不在同源发布目录内');
  return url.href;
}
