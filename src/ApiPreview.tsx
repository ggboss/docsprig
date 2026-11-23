import AutoHeightFrame from './AutoHeightFrame';

export default function ApiPreview({id,version}: {id:string;version:number|string}) {
  // The frame loads and validates the contract itself. A parent preflight would
  // serialize a second authenticated database read before starting the renderer.
  return <AutoHeightFrame key={`${id}:${version}`} title="接口文档预览" src={`/api-preview?${new URLSearchParams({doc:id,v:String(version)})}`} />;
}
