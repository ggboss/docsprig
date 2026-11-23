import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownEditor from '../src/MarkdownEditor';

function Harness() {
  const [value,setValue]=useState('# 标题\r\n\r\n原始 **粗体**。\r\n');
  const [calls,setCalls]=useState(0),[source,setSource]=useState(false);
  Object.assign(window,{mdHarness:{replace:setValue,value,calls}});
  const change=(next:string)=>{setValue(next);setCalls(n=>n+1);};
  return <main style={{maxWidth:960,margin:'30px auto',fontFamily:'system-ui',padding:16}}>
    <h1>Markdown editor</h1>
    <button type="button" onClick={()=>setSource(!source)}>父级源码切换</button>
    {source?<textarea aria-label="父级源码" value={value} onChange={e=>change(e.target.value)}/>:<MarkdownEditor value={value} onChange={change}/>}
    <output aria-label="变更次数">{calls}</output>
    <pre data-testid="source" style={{whiteSpace:'pre-wrap'}}>{value}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness/></StrictMode>);
