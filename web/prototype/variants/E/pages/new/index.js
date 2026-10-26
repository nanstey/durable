import { html } from "../../../../html.js";
import { useEffect, useRef, useState } from "/prototype/vendor/preact-hooks.js";
import { Icon, StatusPill, Kbd } from "../../ui/index.js";
import { agentChoices, projectChoices } from "./data.js";

const placeholder = "Describe what you want to accomplish…";
const modelChoices = ["Claude 4.5", "GPT-5"];

function Toast({ message }) {
  return message && html`<div class="p-new-toast" role="status">${message}</div>`;
}

function Picker({ label, value, choices, onChange, renderValue, renderChoice, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef(null);
  const shown = choices.filter(choice => renderChoice(choice).toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  const choose = choice => {
    if (choice.reason) return;
    onChange(choice);
    setOpen(false);
    setQuery("");
  };
  const keydown = event => {
    if (event.key === "Escape") setOpen(false);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(index => (index + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
    }
    if (event.key === "Enter" && shown[active]) { event.preventDefault(); choose(shown[active]); }
  };
  return html`<div class="p-new-picker" onKeyDown=${keydown}>
    <button class="p-new-toolbar-button" onClick=${() => !disabled && setOpen(!open)} aria-expanded=${open} aria-haspopup="listbox" disabled=${disabled}>
      <small>${label}</small><span>${renderValue(value)}</span><${Icon} name="chevron-down"/>
    </button>
    ${open && html`<div class="p-new-menu" role="listbox" aria-label=${label}>
      <input ref=${search} value=${query} onInput=${event => { setQuery(event.target.value); setActive(0); }} placeholder=${`Search ${label.toLowerCase()}`} aria-label=${`Search ${label.toLowerCase()}`}/>
      <div class="p-new-options">${shown.length ? shown.map((choice, index) => html`<button role="option" aria-selected=${choice === value} class=${`${choice.reason ? "disabled" : ""} ${index === active ? "active" : ""}`} disabled=${!!choice.reason} onClick=${() => choose(choice)}>
        <span>${renderChoice(choice)}${choice.reason && html`<em>${choice.reason}</em>`}</span>${choice.status && html`<${StatusPill} status=${choice.reason ? "held" : choice.status}/>`}
      </button>`) : html`<p>No matches</p>`}</div>
    </div>`}
  </div>`;
}

function AgentPicker({ agent, setAgent }) {
  return html`<${Picker} label="Agent" value=${agent} choices=${agentChoices} onChange=${setAgent}
    renderValue=${agent => agent ? `${agent.id} · ${agent.device}` : "Required"}
    renderChoice=${agent => `${agent.id} · ${agent.org} · ${agent.device}`}/>`;
}

function Composer({ toast }) {
  const [agent, setAgent] = useState(null);
  const [project, setProject] = useState(projectChoices[0]);
  const [kind, setKind] = useState("chat");
  const [model, setModel] = useState(modelChoices[0]);
  const [attached, setAttached] = useState(false);
  const [text, setText] = useState("");
  const [validation, setValidation] = useState("");
  const send = () => {
    if (!agent) { setValidation("Choose an available agent before starting."); return; }
    if (!text.trim()) { setValidation("Add a short task to start."); return; }
    setValidation("");
    setText("");
    toast(`Started with ${agent.id}`);
  };
  useEffect(() => {
    const shortcut = event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && document.activeElement?.closest(".p-new-composer")) {
        event.preventDefault();
        send();
      }
    };
    addEventListener("keydown", shortcut);
    return () => removeEventListener("keydown", shortcut);
  }, [agent, text]);
  const noProject = { repo: "No project", branch: "No repository" };
  return html`<section class="p-new-composer">
    <textarea value=${text} onInput=${event => { setText(event.target.value); setValidation(""); }} placeholder=${placeholder} aria-label="New conversation prompt" autofocus></textarea>
    ${validation && html`<p class="p-new-validation" role="alert">${validation}</p>`}
    ${attached && html`<div class="p-new-attachment"><${Icon} name="file-text"/> context.md <button onClick=${() => setAttached(false)}>Remove</button></div>`}
    <footer>
      <div class="p-new-toolbar">
        <${AgentPicker} agent=${agent} setAgent=${choice => { setAgent(choice); setValidation(""); }}/>
        <div class="p-new-derived"><small>Org</small><span>${agent ? agent.org : "Select an agent"}</span></div>
        <${Picker} label="Project" value=${project} choices=${[noProject, ...projectChoices]} onChange=${setProject}
          renderValue=${choice => choice.repo === "No project" ? "No project" : `${choice.repo} · ${choice.branch}`}
          renderChoice=${choice => choice.repo === "No project" ? "No project" : `${choice.repo} · ${choice.branch}`}/>
        <button class="p-new-toolbar-button" onClick=${() => setKind(kind === "chat" ? "scout" : "chat")}><small>Kind</small><span>${kind}</span><${Icon} name="chevron-down"/></button>
        <${Picker} label="Model" value=${model} choices=${modelChoices} onChange=${setModel} renderValue=${choice => choice} renderChoice=${choice => choice}/>
        <button class=${`p-new-attach ${attached ? "on" : ""}`} onClick=${() => setAttached(!attached)} aria-label="Attach context"><${Icon} name="paperclip"/><span>Attach</span></button>
      </div>
      <button class="p-new-send" onClick=${send}><span>Start</span><${Icon} name="arrow-up"/></button>
    </footer>
    <div class="p-new-keyhint"><${Kbd}>⌘</${Kbd}> / <${Kbd}>Ctrl</${Kbd}> + <${Kbd}>↵</${Kbd}> to start</div>
  </section>`;
}

export default function NewPage() {
  const [toast, setToast] = useState("");
  return html`<main class="e-page p-new-page p-new-landing">
    <div class="p-new-hero">
      <p class="p-new-kicker">NEW CONVERSATION</p>
      <h1>What are we working on?</h1>
      <p class="p-new-subtitle">Choose an agent, add the outcome, and start.</p>
      <${Composer} toast=${setToast}/>
    </div>
    <${Toast} message=${toast}/>
  </main>`;
}
