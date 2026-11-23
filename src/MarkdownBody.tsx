import Markdown, { defaultUrlTransform } from 'react-markdown';
import gfm from 'remark-gfm';
import { publishedURL } from './published-url';
import demoBadge from '../public/content/dev/releases/demo-001/badge.svg?raw';

// content.stage bundles this same example asset when a draft references ./badge.svg.
const draftBadge = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(demoBadge)}`;
export function draftMarkdownBase(release: unknown) {
  const id = (release as {id?: string} | null)?.id;
  return new URL(`/content/dev/${id && /^[\w-]+$/.test(id) ? `releases/${id}` : 'current'}/md/`, window.location.origin).href;
}
export default function MarkdownBody({children, base, draft, inertLinks}: {children:string;base:string;draft?:boolean;inertLinks?:boolean}) {
  return <Markdown skipHtml remarkPlugins={[gfm]} disallowedElements={inertLinks ? ['a'] : undefined} unwrapDisallowed
    urlTransform={(value,key) => {
      if (key !== 'src') return defaultUrlTransform(value);
      if (draft && value === './badge.svg') return draftBadge;
      try { return publishedURL(value,base); } catch { return undefined; }
    }} components={{ img:({node,src,alt,...props}) => src ? <img {...props} src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer"/> : <span className="portal-muted">{alt || '图片不可用'}</span> }}>{children}</Markdown>;
}
