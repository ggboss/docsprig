import { Slot } from 'zudoku';
import McpConnect from './McpConnect';
import { useRef, useState } from 'react';
import type { DocNode } from './workbench-tree';
export type TabMetadata = {id:string;title:string;sort:number};
export default function AdminTabs({tabs,active,disabled,select,save,publish,logout,remove,nonempty}: {
  tabs:DocNode[];active:string;disabled:boolean;select:(node:DocNode)=>void;
  save:(tabs:TabMetadata[],focus?:string)=>Promise<boolean>;publish:()=>void;logout:()=>void;
  remove:(tab:DocNode)=>Promise<boolean>;nonempty:string[];
}) {
  const [dialog,setDialog] = useState<{id:string;title:string}|null>(null);
  const [name,setName] = useState(''), [saving,setSaving] = useState(false);
  const drag = useRef<string|null>(null);
  const metadata = () => tabs.map(({id,title},sort) => ({id,title,sort}));
  const reorder = async (id:string,target:string) => {
    if (disabled || saving || id===target) return;
    const list=metadata(),from=list.findIndex(n=>n.id===id),to=list.findIndex(n=>n.id===target);
    if (from<0 || to<0) return;
    list.splice(to,0,list.splice(from,1)[0]);setSaving(true);
    try {await save(list.map((n,sort)=>({...n,sort})));} finally {setSaving(false);}
  };
  const deleteTab = async (tab:DocNode) => {
    if(disabled||saving||dialog||tabs.length<=1||nonempty.includes(tab.id))return;
    if(!window.confirm(`删除栏目「${tab.title}」？${tab.publishedVersion===null?'该栏目尚未发布。':'该栏目将从当前浏览端下线。'}仅允许删除空栏目，不会删除子节点或发布其他草稿。`))return;
    setSaving(true);try{await remove(tab);}finally{setSaving(false);}
  };
  const open = (node?:DocNode) => {setDialog(node ? {id:node.id,title:node.title} : {id:crypto.randomUUID(),title:''});setName(node?.title ?? '');};
  const icon = (path:string) => <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={path}/></svg>;
  const inline = dialog && <form className="wb-inline-tab" aria-label={dialog.title?'编辑栏目':'新增栏目'} onKeyDown={e=>{if(e.key==='Escape'&&!saving){e.preventDefault();setDialog(null);}}} onSubmit={async e=>{
    e.preventDefault();if(!name.trim()||saving||disabled)return;
    const items=metadata(), existing=items.find(t=>t.id===dialog.id);
    if(existing)existing.title=name.trim();else items.push({id:dialog.id,title:name.trim(),sort:items.length});
    setSaving(true);try{if(await save(items,dialog.id))setDialog(null);}finally{setSaving(false);}
  }}>
    <input aria-label="栏目名称" placeholder="栏目名称" autoFocus onFocus={e=>e.target.select()} maxLength={200} value={name} disabled={saving} onChange={e=>setName(e.target.value)}/>
    <button type="submit" title="保存栏目" aria-label="保存栏目" disabled={saving||disabled||!name.trim()}>{icon('m5 12 4 4 10-10')}</button>
    <button type="button" title="取消" aria-label="取消" disabled={saving} onClick={()=>setDialog(null)}>{icon('m6 6 12 12 M18 6 6 18')}</button>
  </form>;
  return <>
    <Slot.Source name="head-navigation-end"><div className="wb-header-actions"><McpConnect admin/><button className="wb-logout" title="退出登录" aria-label="退出登录" disabled={disabled||saving} onClick={logout}>{icon('M10 4H4v16h6 M9 12h11 m-5-5 5 5-5 5')}</button></div></Slot.Source>
    <div className="wb-tabs-bar">
      <div className="wb-management-tabs" role="tablist" aria-label="管理栏目">{tabs.map((tab,index) => <div className="wb-tab-item" key={tab.id} draggable={!disabled && !saving && !dialog} onDragStart={e=>{drag.current=tab.id;e.dataTransfer.setData('text/plain',tab.id);e.dataTransfer.effectAllowed='move';}} onDragEnd={()=>{drag.current=null;}} onDragOver={e=>{if(drag.current)e.preventDefault();}} onDrop={e=>{e.preventDefault();const id=drag.current;drag.current=null;if(id)void reorder(id,tab.id);}}>
        {dialog?.id===tab.id ? inline : <><button id={`wb-tab-${tab.id}`} type="button" role="tab" aria-selected={active===tab.id} aria-controls="wb-section" disabled={disabled||saving||!!dialog} onClick={()=>select(tab)} onDoubleClick={()=>open(tab)} onKeyDown={e=>{if(e.key==='F2'){e.preventDefault();open(tab);}else if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const target=tabs[index+(e.key==='ArrowLeft'?-1:1)];if(target)void reorder(tab.id,target.id);}}} title="双击改名，拖动或 Alt + 方向键排序">{tab.title}</button>
        <button className="wb-tab-edit" type="button" title="编辑栏目" aria-label={`编辑栏目「${tab.title}」`} disabled={disabled||saving||!!dialog} onClick={()=>open(tab)}>{icon('m14 5 5 5 M4 20l5-1 12-12-5-5L4 14z')}</button>
        <button className="wb-tab-edit" type="button" title={tabs.length<=1?'至少保留一个栏目':nonempty.includes(tab.id)?'栏目非空，请先移动或删除子节点':'删除空栏目'} aria-label={`删除栏目「${tab.title}」`} disabled={disabled||saving||!!dialog||tabs.length<=1||nonempty.includes(tab.id)} onClick={()=>void deleteTab(tab)}>{icon('M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7')}</button></>}
      </div>)}{dialog&&!dialog.title&&inline}
      <button className="wb-icon" title="新增栏目" aria-label="新增栏目" disabled={disabled||saving||!!dialog} onClick={()=>open()}>{icon('M12 5v14 M5 12h14')}</button>
      <button className="wb-icon wb-publish-tabs" title="发布栏目的名称和顺序，不发布文档正文" aria-label="发布栏目" disabled={disabled||saving||!!dialog||!tabs.some(t=>t.draftVersion!==t.publishedVersion)} onClick={publish}>{icon('M12 15V3 m-5 5 5-5 5 5 M4 15v5h16v-5')}发布栏目</button></div>
      <div className="wb-tabs-tools"><a href="/doc" target="_blank" rel="noreferrer">查看浏览端 ↗</a></div>
    </div>
  </>;
}
