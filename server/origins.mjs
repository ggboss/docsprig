// Explicit aliases let one service support LAN and loopback access without
// trusting arbitrary Host, Origin, or proxy forwarding headers.
export function configuredOrigins(primary, aliases = '') {
  const origins = [primary, ...aliases.split(',').map(value => value.trim()).filter(Boolean)];
  const hosts = new Map();
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw Error('Invalid configured documentation origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== origin)
      throw Error('Documentation origins must be HTTP(S) origins without credentials or a path');
    if (hosts.has(url.host) && hosts.get(url.host) !== origin)
      throw Error('Documentation origins cannot use different protocols for the same host');
    hosts.set(url.host, origin);
  }
  return [...hosts.values()];
}

export function routeOrigins(origins, createHandler) {
  const handlers = new Map(origins.map(origin => [new URL(origin).host, createHandler(origin)]));
  return (req, res) => {
    const handler = handlers.get(req.headers.host);
    if (handler) return handler(req, res);
    res.writeHead(403, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
    res.end(JSON.stringify({error:'请求地址未获授权'}));
  };
}
