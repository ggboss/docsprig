import { Slot } from 'zudoku';
import { Link } from 'zudoku/router';
import { firstDocument, href, usePublishedTree, type Item } from './published-tree';
import './portal.css';

export default function PublicTabs({roots,active}: {roots?:Item[];active?:string}) {
  return (
    <Slot.Source name="top-navigation-before"><nav className="portal-tabs" aria-label="文档栏目">
      <div className="portal-tab-list">{roots?.map(n => <Link key={n.id} to={href(n.id, firstDocument(n)?.id)} aria-current={active === n.id ? 'page' : undefined}>{n.title}</Link>)}
      {!roots?.length && <span className="portal-muted">文档中心</span>}</div>
    </nav></Slot.Source>
  );
}

export function LoginTabs() {
  const { result } = usePublishedTree();
  return <PublicTabs roots={result?.value?.roots} />;
}
