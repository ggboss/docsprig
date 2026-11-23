import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Both endpoints share protocol mechanics, not capabilities or authorization.
// A fresh MCP server per stateless request prevents cross-client/session leakage.
export function createMcpEndpoint({origin,path,enabled=true,authenticate,createServer}) {
  const allowed=new URL(origin);
  const reject=(res,status,message)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...(status===401?{'WWW-Authenticate':'Bearer realm="docsprig-admin"'}:{})});res.end(JSON.stringify({error:message}));};
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(!enabled||req.url!==path)return reject(res,404,'MCP 未启用或地址不存在');
    if(req.headers.host!==allowed.host||(req.headers.origin!==undefined&&req.headers.origin!==allowed.origin)||req.headers['sec-fetch-site']==='cross-site')return reject(res,403,'请求来源未获授权');
    if(authenticate){try{await authenticate(req);}catch{return reject(res,401,'需要有效的 MCP 管理令牌');}}
    if(req.method!=='POST'){res.setHeader('Allow','POST');return reject(res,405,'仅支持无状态 Streamable HTTP POST');}
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return reject(res,415,'需要 application/json');
    let server,transport;
    try {
      const limit=4*1024*1024;let bytes=0;const chunks=[];
      if(Number(req.headers['content-length'])>limit)return reject(res,413,'MCP 请求过大');
      for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)return reject(res,413,'MCP 请求过大');chunks.push(chunk);}
      let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{return reject(res,400,'JSON 格式错误');}
      server=createServer();
      transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.once('close',()=>{void transport.close().catch(()=>{});void server.close().catch(()=>{});});
      await server.connect(transport);await transport.handleRequest(req,res,data);
    }catch{
      if(!res.headersSent)reject(res,500,'MCP 服务暂时不可用');else res.end();
      await transport?.close().catch(()=>{});await server?.close().catch(()=>{});
    }
  };
}
