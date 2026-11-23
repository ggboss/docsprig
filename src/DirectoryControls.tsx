import { SearchIcon, ChevronLeftIcon, ChevronRightIcon } from 'zudoku/icons';
import { InputGroup, InputGroupAddon, InputGroupInput } from 'zudoku/ui/InputGroup.js';

export function DirectorySearch({value,change,controls}:{value:string;change:(value:string)=>void;controls?:string}) {
  return <InputGroup className="portal-filter"><InputGroupAddon aria-hidden="true"><SearchIcon className="size-3.5"/></InputGroupAddon><InputGroupInput type="search" aria-label="筛选目录" aria-controls={controls} placeholder="搜索当前栏目" value={value} onChange={e=>change(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();change('');}}}/></InputGroup>;
}
export function DirectoryToggle({closed,toggle,controls,className}:{closed:boolean;toggle:()=>void;controls:string;className:string}) {
  const label=closed?'展开目录':'收起目录',Icon=closed?ChevronRightIcon:ChevronLeftIcon;
  return <button type="button" className={className} aria-label={label} title={label} aria-expanded={!closed} aria-controls={controls} onClick={toggle}><Icon aria-hidden="true" size={14}/></button>;
}
