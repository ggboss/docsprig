// Exact aliases only: native /api-reference and /api-preview have their own routers.
export function portalRedirect(pathname, search = '', hash = '') {
  if (!/^\/(?:api\/?|guides\/?|changelog\/?)?$/.test(pathname)) return undefined;
  if (/^\/changelog\/?$/.test(pathname)) {
    const params = new URLSearchParams(search);
    params.set('tab', 'changelog');
    search = `?${params}`;
  }
  return `/doc${search}${hash}`;
}

// Historical tag/operation URLs need the published tree and browser fragment.
export function legacyDetailTarget({ pathname, search, hash }, items) {
  let route = pathname + hash;
  try { route = decodeURI(route); } catch { /* Unrecognised bookmark. */ }
  const params = new URLSearchParams(search);
  if (!params.has('doc')) {
    for (const item of items) {
      if (item.detailRoutes?.includes(route)) {
        params.set('doc', item.id);
        search = `?${params}`;
        break;
      }
    }
  }
  return `/doc${search}${hash}`;
}
