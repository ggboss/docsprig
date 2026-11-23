import AutoHeightFrame from './AutoHeightFrame';
import { contentURL } from './content';
export default function ApiReference({spec,title}: {spec:string;title:string}) {
  let url:URL;
  try {url=contentURL(spec,new URL(location.origin));} catch {return <p role="alert">接口文档地址无效。</p>;}
  return <AutoHeightFrame title={title || '接口文档'} src={`/api-reference?${new URLSearchParams({spec:url.pathname})}`} />;
}
