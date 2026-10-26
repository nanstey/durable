import { html } from "../../../html.js";
import { icons } from "/prototype/vendor/icons.js";
export const Icon=({name})=>html`<svg class="e-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" dangerouslySetInnerHTML=${{__html:icons[name]||icons['circle-dot']}}/>`;
export const tone=s=>s==='running'?'run':s==='error'?'error':s==='done'?'done':s==='held'||s?.includes('waiting')?'wait':'idle';
export const StatusPill=({status})=>html`<span class=${`e-status ${tone(status)}`}><i></i>${status.replace('waiting-followup','needs input')}</span>`;
export const Chip=({children,onClick})=>html`<button class="e-chip" onClick=${onClick}>${children}</button>`;
export function Menu({open,children}){return open&&html`<div class="e-menu" role="menu">${children}</div>`}
export function Dialog({children,onClose}){return html`<div class="e-modal-back" onClick=${e=>e.target===e.currentTarget&&onClose?.()}><section class="e-modal">${children}</section></div>`}
export const Kbd=({children})=>html`<kbd>${children}</kbd>`;
export const EmptyState=({children})=>html`<div class="e-empty">${children}</div>`;
export const Tabs=({value,setValue,items})=>html`<div class="e-tabs">${items.map(x=>html`<button class=${value===x?'on':''} onClick=${()=>setValue(x)}>${x}</button>`)}</div>`;
