import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { portalRedirect } from '../src/portal-routes.mjs';

const pages = new Map([['/doc', 'doc.html'], ['/admin', 'admin.html'], ['/login', 'login.html']]);
const types = new Map(Object.entries({ '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' }));
const backend = /^\/(?:content|manage|mcp)(?:\/|$)/;

function staticFile(path) {
  if (/^\/api(?:\/|$)/.test(path)) return 'api.html';
  if (/^\/(?:api-reference|api-preview)(?:\/|$)/.test(path)) return 'index.html';
  const page = pages.get(path === '/' ? path : path.replace(/\/$/, ''));
  if (page) return page;
  if (/^\/logo-(?:light|dark)\.svg$/.test(path)) return path.slice(1);
  // Only the flat client asset directory is public, not maps, SSR code, or build metadata.
  if (/^\/assets\/[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(path) &&
      extname(path) !== '.html' && types.has(extname(path))) return path.slice(1);
}

function reject(res, status) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(status === 405 ? 'Method not allowed' : status === 404 ? 'Not found' : 'Service unavailable');
}

// Deploy dist as a read-only build artifact in a trusted parent directory.
export function withPortal(apiHandler, distDir) {
  const root = resolve(distDir);
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const raw = (req.url ?? '').split('?', 1)[0];
    let path = raw;
    if (!backend.test(raw)) {
      try { path = decodeURIComponent(raw); } catch { return reject(res, 404); }
    }
    // Forward all methods, queries and bodies unchanged. No static fallback on backend errors.
    if (backend.test(path)) {
      try { return await apiHandler(req, res); } catch { return reject(res, 500); }
    }
    try {
      // Inspect before any URL/filesystem normalization. Encoded separators are not aliases.
      if (!path.startsWith('/') || /[\\%?#\x00-\x1f\x7f]|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || /%2f/i.test(raw))
        return reject(res, 404);
      const redirect = portalRedirect(path, req.url.slice(raw.length));
      const file = staticFile(path);
      if (!redirect && !file) return reject(res, 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return reject(res, 405);
      }
      // A fragment is not sent over HTTP; omitting it from Location lets the browser inherit it.
      if (redirect) {
        res.writeHead(308, { Location: redirect, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const asset = file.startsWith('assets/');
      if (!(await lstat(root)).isDirectory() || (asset && !(await lstat(join(root, 'assets'))).isDirectory()))
        return reject(res, 404);
      const handle = await open(join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return reject(res, 404);
        res.writeHead(200, { 'Content-Type': types.get(extname(file)), 'Content-Length': stat.size,
          'Cache-Control': asset && /-[A-Za-z0-9_-]{8}\.[^.]+$/.test(file)
            ? 'public, max-age=31536000, immutable' : 'no-store' });
        if (req.method === 'HEAD') res.end();
        else await pipeline(handle.createReadStream(), res);
      } finally { await handle.close(); }
    } catch (error) {
      const missing = ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error?.code);
      reject(res, missing ? 404 : 500);
    }
  };
}
