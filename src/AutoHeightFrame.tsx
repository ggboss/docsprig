import { useEffect, useRef, useState } from 'react';

export default function AutoHeightFrame({src,title}: {src:string;title:string}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height,setHeight] = useState(360);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.type !== 'open-docs:preview-size') return;
      const next = event.data.height;
      if (Number.isFinite(next) && next >= 0 && next < 1000000) setHeight(Math.max(160, Math.ceil(next)));
    };
    const theme = () => frame.current?.contentWindow?.postMessage({type:'open-docs:preview-theme',dark:document.documentElement.classList.contains('dark')},location.origin);
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
    window.addEventListener('message',receive);
    return () => {window.removeEventListener('message',receive);observer.disconnect();};
  },[src]);
  return <iframe ref={frame} className="wb-api-preview" title={title} src={src} style={{display:'block',width:'100%',height,border:0}} onLoad={() => frame.current?.contentWindow?.postMessage({type:'open-docs:preview-theme',dark:document.documentElement.classList.contains('dark')},location.origin)} />;
}
