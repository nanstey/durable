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
		if (detail.metrics) {
			panel.append(element("h4", "Metrics (last 30 days)"));
			panel.append(textBlock(detail.metrics));
		}
		if (detail.improvements?.patterns?.length) {
			panel.append(element("h4", "Improvement evidence"));
			panel.append(textBlock(detail.improvements));
		}
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
	for (const [label, value] of [["Scout queue", detail.queue], ["Inbox", detail.inbox], ["Audit", detail.audit], ["Metrics", detail.metrics], ["Improvement evidence", detail.improvements]]) {
		const section = element("section");
		section.append(element("h3", label));
		for (const entry of Array.isArray(value) ? value : value?.items ?? []) {
			const row = textBlock(entry);
			section.append(row);
			if (label === "Scout queue" && entry.workItem && detail.scopeSummary?.includes("pause")) {
				const hold = element("button", "Hold item");
				hold.addEventListener("click", () => {
					if (confirm("Hold this item? Wait for held before editing.")) api(selected.device, `/items/${encodeURIComponent(entry.workItem)}/hold`, "POST", {}).then(load).catch(() => {});
				});
				section.append(hold);
			}
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

function base64url(value) {
	const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(text, (char) => char.charCodeAt(0));
}
async function passkey(device, action, item, enrollmentCode) {
	let issued = await api(device, "/approvals/challenge", "POST", { action, item, enrollmentCode });
	while (true) {
		const options = issued.publicKey;
		options.challenge = base64url(options.challenge);
		for (const credential of options.allowCredentials ?? options.excludeCredentials ?? []) credential.id = base64url(credential.id);
		if (options.user?.id) options.user.id = base64url(options.user.id);
		const credential = issued.kind === "registration"
			? await navigator.credentials.create({ publicKey: options })
			: await navigator.credentials.get({ publicKey: options });
		const result = await api(device, "/approvals/assert", "POST", { action, item, kind: issued.kind, challengeId: issued.challengeId, response: credential.toJSON() });
		if (result.approved) return result;
		issued = result;
	}
}
function approvals() {
	const panel = element("section", undefined, "approvals");
	panel.append(element("h2", "Approvals"));
	if (!selected) { panel.append(element("p", "Select an agent to review approvals.")); return panel; }
	const queue = state.details.get(selected.device)?.items ?? [];
	const pending = queue.filter((item) => item.gate?.state === "waiting-approval");
	for (const item of pending) {
		const gate = item.gate;
		const row = element("section");
		row.append(element("h3", `PR #${gate.pr ?? "?"}: ${item.id}`), textBlock({
			title: item.candidate?.title,
			url: item.candidate?.url,
			headSha: gate.sha,
			reasons: gate.reasons,
			verdict: item.review?.result?.verdict ?? item.review?.verdict,
			risk: item.review?.result?.risk,
			holdEpoch: item.holdEpoch,
		}));
		const approve = element("button", "Confirm with passkey");
		approve.addEventListener("click", () => { if (confirm(`Approve ${item.id} at ${gate.sha}?`)) passkey(selected.device, "approve", item.id).then(load).catch((error) => { state.error = error.message; draw(); }); });
		row.append(approve); panel.append(row);
	}
	for (const item of queue.filter((candidate) => candidate.outcome === "held")) {
		const release = element("button", `Release ${item.id} with passkey`);
		release.addEventListener("click", () => { if (confirm(`Release human hold for ${item.id}?`)) passkey(selected.device, "release", item.id).then(load).catch(() => {}); });
		panel.append(release);
	}
	const resume = element("button", "Resume agent with passkey");
	resume.addEventListener("click", () => { if (confirm("Resume this agent?")) passkey(selected.device, "resume", selected.device).then(load).catch(() => {}); });
	panel.append(resume);
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
	layout.append(fleet(), detailPanel(), approvals(), renderChat(selected?.node, { ...state, scopes: state.details.get(selected?.device)?.scopeSummary }, (path, method, body) => api(selected.device, path, method, body)));
	root.append(layout, element("footer", "Passkey approvals are verified by the daemon; the console only relays browser assertions."));
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
			const [treeData, budget, queue, items, inbox, audit, info, metrics, improvements] = await Promise.all([
				api(device.id, "/conversations?tree=true"), api(device.id, "/budget"), api(device.id, "/queue"), api(device.id, "/items"), api(device.id, "/inbox"), api(device.id, "/audit"), api(device.id, "/device"), api(device.id, "/metrics"), api(device.id, "/improvements"),
			]);
			state.nodes.push(...treeData.nodes.map((node) => ({ ...node, device: device.id })));
			state.details.set(device.id, { budget, queue, items: Object.values(items.items ?? {}), inbox, audit, metrics, improvements, scopeSummary: info.scopeSummary });
			if (selected?.device === device.id) selected.node = state.nodes.find((node) => node.device === device.id && node.id === selected.node.id) ?? selected.node;
		} catch { /* device status remains visible */ }
	}
	draw();
	if (reconnect) connect();
}
load().catch((error) => { root.textContent = `Console unavailable: ${error.message}`; });
