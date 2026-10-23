import { element, textBlock } from "./views/dom.js";
import { renderChat } from "./views/chat.js";

const root = document.querySelector("#app");
let csrf = "";
let selected;
let stream;
let retryTimer;
const state = { devices: [], nodes: [], transcript: [], details: new Map(), error: "" };

async function api(device, path, method = "GET", body) {
	const response = await fetch(`/api/devices/${encodeURIComponent(device)}/v1${path}`, {
		method,
		headers: method === "GET" ? {} : { "content-type": "application/json", "x-durable-csrf": csrf, "idempotency-key": crypto.randomUUID() },
		body: method === "GET" ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		const seconds = Number(response.headers.get("retry-after"));
		state.error = error.error?.code === "rate_limited" && Number.isFinite(seconds)
			? `Rate limited; try again in ${seconds} seconds.`
			: error.error?.message ?? "Request failed";
		draw();
		throw Error(state.error);
	}
	return response.json();
}

async function selectNode(device, node) {
	selected = { device, node };
	state.transcript = await api(device, `/conversations/${encodeURIComponent(node.id)}/transcript`);
	draw();
}

function nodeLabel(node) {
	return `${node.kind} · ${node.status}${node.item ? ` · ${node.item}` : ""}`;
}

function tree(parent, device, nodes) {
	const list = element("ul", undefined, "tree");
	for (const node of nodes.filter((candidate) => candidate.parentId === parent)) {
		const item = document.createElement("li");
		const button = element("button", nodeLabel(node));
		button.addEventListener("click", () => selectNode(device, node).catch(() => {}));
		item.append(button, tree(node.id, device, nodes));
		list.append(item);
	}
	return list;
}

function fleet() {
	const panel = element("nav", undefined, "fleet");
	panel.append(element("h2", "Fleet"));
	for (const device of state.devices) {
		const detail = state.details.get(device.id) ?? {};
		panel.append(element("h3", `${device.id}: ${device.status}`));
		panel.append(element("p", `Last check: ${new Date(device.checkedAt).toLocaleTimeString()}`));
		if (detail.budget) panel.append(textBlock({ budget: detail.budget, paused: detail.paused }));
		if (Array.isArray(detail.inbox) && detail.inbox.some((entry) => !entry.acked))
			panel.append(element("p", `Inbox: ${detail.inbox.filter((entry) => !entry.acked).length} unread`, "badge"));
		panel.append(tree(null, device.id, state.nodes.filter((node) => node.device === device.id)));
	}
	return panel;
}

function detailPanel() {
	const panel = element("section", undefined, "detail");
	if (!selected) {
		panel.append(element("h2", "Agent detail"), element("p", "Select a conversation to read its live transcript."));
		return panel;
	}
	const detail = state.details.get(selected.device) ?? {};
	panel.append(element("h2", `Agent ${selected.device}`));
	for (const [label, value] of [["Scout queue", detail.queue], ["Inbox", detail.inbox], ["Audit", detail.audit]]) {
		const section = element("section");
		section.append(element("h3", label));
		for (const entry of Array.isArray(value) ? value : value?.items ?? []) {
			const row = textBlock(entry);
			section.append(row);
			if (label === "Inbox" && entry.id && !entry.acked) {
				const ack = element("button", "Acknowledge");
				ack.addEventListener("click", () => api(selected.device, `/inbox/${encodeURIComponent(entry.id)}/ack`, "POST", {}).then(load));
				section.append(ack);
			}
		}
		panel.append(section);
	}
	if (selected.node.capabilities?.attach) panel.append(textBlock(`Open in Orca: ${selected.node.capabilities.attach}`));
	return panel;
}

function draw() {
	root.replaceChildren();
	root.append(element("h1", "Durable console"));
	root.append(element("p", state.error, "error"));
	const controls = element("div", undefined, "controls");
	const pause = element("button", "Pause agent");
	pause.disabled = !selected;
	pause.addEventListener("click", () => {
		if (selected && confirm("Pause this agent?")) api(selected.device, "/pause", "POST", {}).catch(() => {});
	});
	controls.append(pause);
	const create = element("button", "New conversation");
	create.addEventListener("click", () => newConversation());
	controls.append(create);
	root.append(controls);
	const layout = element("div", undefined, "layout");
	layout.append(fleet(), detailPanel(), renderChat(selected?.node, state, (path, method, body) => api(selected.device, path, method, body)));
	root.append(layout, element("footer", "Console controls chat, pause, and reads only. It cannot approve or resume agents."));
}

function newConversation() {
	if (!selected) return;
	const dialog = document.createElement("dialog");
	const form = document.createElement("form");
	const kind = document.createElement("select");
	for (const value of ["chat", "scout"]) kind.append(new Option(value, value));
	const item = document.createElement("input"); item.placeholder = "Scout item (required for scout)";
	const submit = element("button", "Start"); submit.type = "submit";
	form.append(element("label", "Kind"), kind, item, submit);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const body = kind.value === "scout" ? { kind: "scout", item: item.value } : { kind: "chat", name: "Chat" };
		api(selected.device, "/conversations", "POST", body).then(() => { dialog.close(); load(); }).catch(() => {});
	});
	dialog.append(form); document.body.append(dialog); dialog.showModal();
}

function streamKey(node) {
	if (node.kind === "steward") return `${node.device}/steward`;
	return `${node.device}/${node.kind.includes("worker") ? "worker" : "agent"}/${node.id}`;
}

function connect() {
	stream?.close();
	stream = new EventSource("/api/stream");
	stream.addEventListener("hello", (event) => {
		const id = JSON.parse(event.data).id;
		const subs = state.nodes.slice(0, 20).map(streamKey);
		fetch(`/api/stream/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json", "x-durable-csrf": csrf }, body: JSON.stringify({ subs }) }).catch(() => {});
	});
	for (const name of ["snapshot", "delta", "tree"]) stream.addEventListener(name, (event) => {
		const frame = JSON.parse(event.data);
		if (selected && frame.key === streamKey(selected.node) && frame.state?.entries) state.transcript = frame.state.entries;
		load(false).catch(() => {});
	});
	stream.addEventListener("disconnected", () => { state.error = "A daemon stream disconnected; reconnecting."; draw(); });
	stream.onerror = () => { clearTimeout(retryTimer); retryTimer = setTimeout(connect, 1000); };
}

async function load(reconnect = true) {
	const boot = await fetch("/api/bootstrap").then((response) => response.json());
	csrf = boot.csrf;
	state.devices = boot.devices;
	state.nodes = [];
	state.details = new Map();
	for (const device of boot.devices.filter((entry) => entry.status === "online")) {
		try {
			const [treeData, budget, queue, inbox, audit] = await Promise.all([
				api(device.id, "/conversations?tree=true"), api(device.id, "/budget"), api(device.id, "/queue"), api(device.id, "/inbox"), api(device.id, "/audit"),
			]);
			state.nodes.push(...treeData.nodes.map((node) => ({ ...node, device: device.id })));
			state.details.set(device.id, { budget, queue, inbox, audit });
		} catch { /* device status remains visible */ }
	}
	draw();
	if (reconnect) connect();
}
load().catch((error) => { root.textContent = `Console unavailable: ${error.message}`; });
