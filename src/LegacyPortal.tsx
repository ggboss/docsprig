import { Navigate, useLocation } from 'zudoku/router';
import { usePublishedTree } from './PublishedTree';
import { legacyDetailTarget, portalRedirect } from './portal-routes.mjs';

function LegacyDetail() {
  const location = useLocation();
  const tree = usePublishedTree();
  if (!tree) return <p role="status">正在打开文档…</p>;
  return <Navigate replace to={legacyDetailTarget(location, tree.value?.byId.values() ?? [])} />;
}

export default function LegacyPortal() {
  const {pathname, search, hash} = useLocation();
  const target = portalRedirect(pathname, search, hash);
  return target ? <Navigate replace to={target} /> : <LegacyDetail />;
}
