import { html } from "../../../html.js";
import { Icon } from "../ui/index.js";
import { nav } from "../data.js";
export default function Shell({page,setPage,theme,setTheme,children}) { const items=[...nav.filter(x=>x[0]==='new'),...nav.filter(x=>x[0]!=='new')]; return html`<div class=${`e-app ${theme}`}><aside class="e-rail"><button class="e-logo">D</button><nav>${items.map(([id,label,icon])=>html`<button class=${`${page===id?'active':''} ${id==='new'?'e-rail-new':''}`} onClick=${()=>setPage(id)} title=${label}><${Icon} name=${icon}/><span>${label}</span></button>`)}</nav><footer><i class="e-dot run"></i><button title="Toggle theme" onClick=${()=>setTheme(theme==='dark'?'light':'dark')}>◐</button><button class="e-avatar">NR</button></footer></aside>${children}</div>`; }
