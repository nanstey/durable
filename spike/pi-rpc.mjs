// Spike (throwaway): drive `pi --mode rpc` (option 2 transport + profile rebinding check).
// Usage: PI_CODING_AGENT_DIR=<derived dir> node pi-rpc.mjs <pi-binary> [extra pi args...]
// Prints a redacted summary of responses/events; sends get_state, a prompt that forces one tool call, then exits.
import { spawn } from "node:child_process";

const [bin, ...extra] = process.argv.slice(2);
const child = spawn(bin, ["--mode", "rpc", "--no-session", ...extra], {
	stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const counts = {};
let text = "";
const t0 = Date.now();
const toolSeen = [];
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
child.stderr.on("data", (d) =>
	process.stderr.write("[stderr] " + String(d).slice(0, 200)),
);
child.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).replace(/\r$/, "");
		buf = buf.slice(i + 1);
		if (!line) continue;
		const r = JSON.parse(line);
		counts[r.type] = (counts[r.type] ?? 0) + 1;
		if (r.type === "response")
			console.log(
				"response",
				r.id,
				r.command,
				r.success,
				r.error ?? "",
				r.command === "get_state"
					? JSON.stringify({
							model: r.data?.model?.provider + "/" + r.data?.model?.id,
							streaming: r.data?.isStreaming,
						})
					: JSON.stringify(r.data ?? {}).slice(0, 120),
			);
		if (
			r.type === "message_update" &&
			r.assistantMessageEvent?.type === "text_delta"
		)
			text += r.assistantMessageEvent.delta;
		if (r.type === "tool_execution_start") toolSeen.push(r.toolName);
		if (r.type === "message_end" && r.message?.errorMessage)
			console.log("error:", r.message.errorMessage.slice(0, 200));
		if (r.type === "agent_settled") {
			console.log(
				JSON.stringify({
					ms: Date.now() - t0,
					text: text.slice(-60),
					tools: toolSeen,
					eventCounts: counts,
				}),
			);
			child.stdin.end();
		}
	}
});
setTimeout(() => {
	if (process.env.SET_MODEL) {
		const [provider, modelId] = process.env.SET_MODEL.split("//");
		send({ id: "m1", type: "set_model", provider, modelId });
	}
	send({ id: "s1", type: "get_state" });
	setTimeout(
		() =>
			send({
				id: "p1",
				type: "prompt",
				message:
					"Use the bash tool to run `echo rpc-tool-ok`, then reply with exactly: ok",
			}),
		1500,
	);
}, 2000);
setTimeout(() => {
	console.log("timeout", JSON.stringify(counts));
	child.kill();
}, 60000).unref();
child.on("exit", (c) => console.log("pi exited", c));
