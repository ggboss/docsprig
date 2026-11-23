import { DirectoryToggle } from './DirectoryControls';
import "./reader-scroll.css";
import { useState, type ReactNode } from 'react';

export default function ReaderLayout({directory,children}:{directory:ReactNode;children:ReactNode;docKey?:string}) {
  const [closed,setClosed]=useState(false);
  return <div className={'portal-layout reader-layout'+(closed?' tree-closed':'')}>
    <div className="reader-rail"><div id="reader-tree" hidden={closed}>{directory}</div><DirectoryToggle className="reader-toggle" controls="reader-tree" closed={closed} toggle={()=>setClosed(!closed)}/></div>
    <div className="portal-content">{children}</div>
  </div>;
}
