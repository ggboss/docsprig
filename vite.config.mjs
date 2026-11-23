import { portalRedirect } from './src/portal-routes.mjs';

function publicRoutes(req, res, next) {
  const url = req.url ?? '';
  const path = url.split('?', 1)[0];
  const redirect = portalRedirect(path, url.slice(path.length));
  if (redirect && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(308, { Location: redirect, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.url?.startsWith('/content/dev/current/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

const backend = process.env.OPEN_DOCS_BACKEND;
const proxy = backend ? Object.fromEntries(['/manage/', '/content/dev/', '^/content/site-name\\.json(?:\\?|$)'].map(prefix => [prefix, {target: backend}])) : undefined;
// Demo-only: preserve the public Host and Origin for the gateway's checks.
if (proxy && backend === process.env.OPEN_DEMO_GATEWAY && /^http:\/\/127\.0\.0\.1:\d+$/.test(backend)) {
  proxy['/__demo/'] = { target: backend, changeOrigin: false };
}
export default {
  server: {proxy}, preview: {proxy},
  plugins: [{
    name: 'same-origin-content',
    configureServer(server) { server.middlewares.use(publicRoutes); },
    configurePreviewServer(server) {
      server.middlewares.use(publicRoutes);
      // The standard preview is an MPA. Runtime API tags share the SPA shell.
      server.middlewares.use((req, _res, next) => {
        if (/^\/(?:api-preview|api-reference)(?:[/?]|$)/.test(req.url ?? '')) req.url = '/index.html';
        else if (/^\/doc\/?(?:\?|$)/.test(req.url ?? '')) req.url = '/doc.html';
        else if (/^\/api(?:[/?]|$)/.test(req.url ?? '')) req.url = '/api.html';
        next();
      });
    },
  }],
};
