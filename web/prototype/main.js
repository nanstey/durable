// PROTOTYPE — Variant E (ADE layout) is the chosen foundation.
import { render } from "/vendor/preact.js";
import { html } from "./html.js";
import ADE from "./variants/E.js";

render(html`<${ADE} />`, document.querySelector("#app"));
