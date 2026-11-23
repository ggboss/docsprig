// Both development fixtures and published files use this same-origin mount.
export const current = '/content/dev/current';
export const contract = `${current}/api.yaml`;
export const manifest = `${current}/index.json`;

export function contentURL(path: string, base: URL): URL {
  if (!path.trim()) throw new Error('内容路径为空');
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/content/dev/') || url.username || url.password)
    throw new Error('内容路径不在同源发布目录内');
  return url;
}
