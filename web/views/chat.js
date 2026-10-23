import { element, textBlock } from "./dom.js";

export function renderChat(node, state, request) {
	const panel = element("section", undefined, "chat");
	panel.append(element("h2", node ? `Conversation ${node.id}` : "Conversation"));
	for (const entry of state.transcript ?? []) panel.append(textBlock(entry.model ?? entry.data ?? entry.body ?? entry));
	if (!node) return panel;
	const composer = document.createElement("form");
	const input = document.createElement("textarea");
	input.name = "message";
	input.required = true;
	input.maxLength = 1048576;
	input.placeholder = "Send a follow-up";
	composer.append(input);
	const follow = element("button", "Follow-up");
	follow.type = "submit";
	composer.append(follow);
	if (node.capabilities?.steer) {
		const steer = element("button", "Steer");
		steer.type = "submit";
		steer.value = "steer";
		steer.name = "action";
		composer.append(steer);
	}
	if (node.capabilities?.interrupt) {
		const abort = element("button", "Abort");
		abort.type = "button";
		abort.addEventListener("click", () => request(`/v1/conversations/${encodeURIComponent(node.id)}/abort`, "POST", {}));
		composer.append(abort);
	}
	composer.addEventListener("submit", async (event) => {
		event.preventDefault();
		const action = new FormData(composer).get("action") === "steer" ? "steer" : "followUp";
		await request(`/v1/conversations/${encodeURIComponent(node.id)}/messages`, "POST", { body: input.value, whenBusy: action, requestId: crypto.randomUUID() });
		input.value = "";
	});
	panel.append(composer);
	return panel;
}
