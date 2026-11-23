import { ensureRandomUUID } from './src/browser-crypto.mjs';
import type { ZudokuConfig } from 'zudoku';
import RuntimeBrand, { defaultSiteName } from './src/RuntimeBrand';
import { openApiPlugin } from 'zudoku/plugins/openapi';
import { contentURL } from './src/content';
import PreviewShell from './src/PreviewShell';
import LegacyPortal from './src/LegacyPortal';
import PreviewNavigation, { previewRoutes } from './src/PreviewNavigation';

ensureRandomUUID();

const preview = typeof window !== 'undefined' && /^\/(?:api-preview|api-reference)(?:\/|$)/.test(window.location.pathname);
const previewVersion = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('v') ?? '0';
const previewDoc = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('doc') ?? '';

const reference = typeof window !== 'undefined' && window.location.pathname.startsWith('/api-reference');
function previewInput() {
  if (!reference) return new URL(`/manage/preview?${new URLSearchParams({doc:previewDoc,v:previewVersion})}`,window.location.origin).href;
  try {return contentURL(new URLSearchParams(window.location.search).get('spec') ?? '',new URL(window.location.origin)).href;} catch {return new URL('/content/dev/invalid-reference',window.location.origin).href;}
}

const previewBasePath = reference ? '/api-reference' : '/api-preview';
const previewSearch = typeof window === 'undefined' ? '' : window.location.search;
const previewPlugin = preview ? openApiPlugin({
  type:'url', input:previewInput(), path:previewBasePath, skipPreload:true,
  options:{disablePlayground:true,showInfoPage:false,schemaDownload:{enabled:false}},
}) : undefined;
const previewNavigation = previewPlugin && 'getNavigation' in previewPlugin ? previewPlugin.getNavigation : undefined;

export default {
  // Green theme with contrast-adjusted action colors.
  theme: {
    light: { primary:'#007967', primaryForeground:'#ffffff', accent:'#e2f6f1', accentForeground:'#075d51', ring:'#00836f' },
    dark: { primary:'#45dec2', primaryForeground:'#092d26', accent:'#163d35', accentForeground:'#a2f2de', ring:'#45dec2' },
  },
  metadata: { title: `%s | ${defaultSiteName}`, defaultTitle: defaultSiteName },
  site: { logo: { src: { light: '/logo-light.svg', dark: '/logo-dark.svg' }, alt: defaultSiteName, width: '32px', height: '32px', href: '/doc' } },
  slots: {
    'head-navigation-start': () => <RuntimeBrand />,
    'layout-before-head': () => preview ? <PreviewShell /> : null,
    'content-before': () => previewNavigation ? <PreviewNavigation basePath={previewBasePath} search={previewSearch} getNavigation={previewNavigation} /> : null,
  },
  // The public header and admin tabs come from their respective runtime trees.
  navigation: [],
  // Do not prerender a snapshot of independently published content.
  plugins: typeof window === 'undefined' ? [] : previewPlugin && 'getRoutes' in previewPlugin ? [{...previewPlugin, getRoutes:() => previewRoutes(previewPlugin.getRoutes(), previewBasePath), getNavigation:async () => []}] : [{getRoutes:() => [{path:'/',element:<LegacyPortal />},{path:'/api/*',element:<LegacyPortal />}]}],
} satisfies ZudokuConfig;
