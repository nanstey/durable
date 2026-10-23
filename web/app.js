import { h, render } from "./vendor/preact.js";
import htm from "./vendor/htm.js";
import { element } from "./views/dom.js";
import { renderChat } from "./views/chat.js";

const html = htm.bind(h);
const root = document.querySelector("#app");
let csrf = "";
let selected;
let state = { nodes: [], transcript: [] };

async function api(path, method = "GET", body) {
	const response = await fetch(`/api/devices/${encodeURIComponent(selected.device)}/v1${path}`, {
		method,
		headers: method === "GET" ? {} : { "content-type": "application/json", "x-durable-csrf": csrf },
		body: method === "GET" ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		showError(error.error?.code === "rate_limited" ? "Rate limited; try again when the countdown ends." : error.error?.message ?? "Request failed");
		throw Error("console request failed");
	}
	return response.json();
}
function showError(message) {
	const area = document.querySelector("#error");
	if (area) area.textContent = message;
}
async function selectNode(device, node) {
	selected = { device, node };
	state.transcript = await api(`/conversations/${encodeURIComponent(node.id)}/transcript`);
	draw();
}
function draw() {
	root.replaceChildren();
	const title = element("h1", "Durable console");
	root.append(title);
	const error = element("p", "", "error"); error.id = "error"; root.append(error);
	const controls = element("div", undefined, "controls");
	const newChat = element("button", "New chat");
	newChat.addEventListener("click", async () => { await api("/conversations", "POST", { kind: "chat", name: "Chat" }); await load(); });
	controls.append(newChat);
	const newScout = element("button", "New scout");
	newScout.addEventListener("click", async () => { const item = prompt("Scout item"); if (item) { await api("/conversations", "POST", { kind: "scout", item }); await load(); } });
	controls.append(newScout);
	const pause = element("button", "Pause agent");
	pause.addEventListener("click", async () => { if (confirm("Pause this agent?")) await api("/pause", "POST", {}); });
	controls.append(pause);
	root.append(controls);
	const layout = element("div", undefined, "layout");
	const fleet = element("nav", undefined, "fleet");
	for (const device of state.devices ?? []) {
		const deviceTitle = element("h2", `${device.id}: ${device.status}`); fleet.append(deviceTitle);
		for (const node of state.nodes.filter((candidate) => candidate.device === device.id)) {
			const button = element("button", `${node.kind}: ${node.id}`);
			button.addEventListener("click", () => selectNode(device.id, node));
			fleet.append(button);
		}
	}
	layout.append(fleet);
	const selectedNode = selected && state.nodes.find((node) => node.id === selected.node.id && node.device === selected.device);
	layout.append(renderChat(selectedNode, state, (path, method, body) => api(path, method, body)));
	root.append(layout);
	const footer = document.createElement("footer");
	render(html`<span>Console controls chat, pause, and reads only. It cannot approve or resume agents.</span>`, footer);
	root.append(footer);
}
async function load() {
	const boot = await fetch("/api/bootstrap").then((response) => response.json());
	csrf = boot.csrf;
	state.devices = boot.devices;
	state.nodes = [];
	for (const device of boot.devices.filter((entry) => entry.status === "online")) {
		selected = { device: device.id };
		try {
			const tree = await api("/conversations?tree=true");
			state.nodes.push(...tree.nodes.map((node) => ({ ...node, device: device.id })));
		} catch { /* status already identifies unavailable devices */ }
	}
	selected = undefined;
	draw();
}
load().catch((error) => { root.textContent = `Console unavailable: ${error.message}`; });
