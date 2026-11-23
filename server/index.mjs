import { configuredOrigins, routeOrigins } from './origins.mjs';
import { fileURLToPath } from 'node:url';
import { withPortal } from './portal.mjs';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createStore } from './store.mjs';
import { createContent } from './content.mjs';
import { adminActor } from './auth.mjs';
import { handler } from './http.mjs';
import { createMcpHandler } from './mcp.mjs';
import { createMcpEndpoint } from './mcp-http.mjs';
import { createPublicMcpServer } from './mcp-public.mjs';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const pool = new Pool({connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:5000});
pool.on('error', err => console.error('Idle database connection error:',err.code));
const bind = process.env.DOCS_BIND || '127.0.0.1';
if (!process.env.DOCS_PUBLIC_ORIGIN && !['127.0.0.1','::1'].includes(bind)) throw Error('DOCS_PUBLIC_ORIGIN required for a non-loopback binding');
const store = createStore(pool);
const content = createContent({ loadRelease: id => store.releaseNodes(id) });
const origins = configuredOrigins(process.env.DOCS_PUBLIC_ORIGIN || 'http://127.0.0.1:4180', process.env.DOCS_ALLOWED_ORIGINS);
const backend = routeOrigins(origins, origin => {
  const api = handler({store,content,authenticate:adminActor,origin});
  const mcp = createMcpHandler({store,content,origin});
  const publicMcp = createMcpEndpoint({origin,path:'/mcp/docs',
    createServer:()=>createPublicMcpServer({store,content})});
  return (req,res) => {
    const path=req.url?.split('?')[0];
    return (path === '/mcp/admin' ? mcp : path === '/mcp/docs' ? publicMcp : api)(req,res);
  };
});
const server = createServer(withPortal(backend, fileURLToPath(new URL('../dist/',import.meta.url))));
server.listen(Number(process.env.PORT || 4191), bind, () => console.log('Docs backend listening on port', server.address().port));
for (const sig of ['SIGTERM','SIGINT']) process.once(sig,() => { server.close(async () => { await pool.end(); }); server.closeIdleConnections(); });
