// Real user-service drill with injected faux model/identity, never operator credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createToken } from "../src/api/tokens.ts";
import { run } from "../src/steward/main.ts";
import { readAudit } from "../src/steward/audit.ts";
import { eventually, fauxModels } from "../test/support/harness.ts";

if (process.argv[2] === "child") {
	const home = process.env.DURABLE_HOME!;
	let runtime: Awaited<ReturnType<typeof run>>;
	const slow = defineTool({ name: "slow", description: "drill-only contained tool", parameters: Type.Object({}), execute: async (_args, _api, context) => {
		context.abortSignal?.addEventListener("abort", () => { void runtime.processes.terminate(); }, { once: true });
		const result = await runtime.processes.launch(["/bin/sh", "-c", 'echo ready > "$1"; sleep 300 & sleep 300; wait', "drill", join(home, "tool-started")], { PATH: process.env.PATH }, { item: "drill", attemptId: "one" });
		return { output: [{ type: "text", text: result.stdout }] };
	} });
	const { models, faux } = fauxModels();
	faux.setResponses(existsSync(join(home, "tool-started")) ? [fauxAssistantMessage("drill recovered")] : [fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })]);
	runtime = await run("drill", { models, extensions: [defineExtension({ name: "drill.slow", tools: [slow] })], preflight: async () => ({ ok: true, checks: [{ name: "faux identity", ok: true, detail: "offline drill only" }] }) });
	if (!existsSync(join(home, "tool-started"))) {
		await runtime.harness.root.configure({ tools: [slow] }, runtime.harness.context);
		const id = (await runtime.harness.tree())[0].id;
		await runtime.harness.submit(id, "run slow drill tool", "drill", "followUp", "hash");
	}
} else {
	const home = mkdtempSync(join(tmpdir(), "durable-live-")); process.env.DURABLE_HOME = home;
	const config = join(home, "definitions"); mkdirSync(config);
	const socket = createServer(); await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const address = socket.address(); assert.ok(address && typeof address !== "string");
	const port = address.port; await new Promise<void>((resolve) => socket.close(() => resolve()));
	writeFileSync(join(config, "drill.yaml"), "profile: fixture\nschedule:\n  pollSeconds: 1\nmodels:\n  steward:\n    provider: faux\n    model: one\n");
	const machine = join(home, "machine.yaml"); writeFileSync(machine, `name: fixture\nagents:\n  - id: drill\n    port: ${port}\n`);
	process.env.DURABLE_AGENTS_DIR = config; process.env.DURABLE_MACHINE_FILE = machine;
	const unit = `durable-drill-${randomUUID()}`;
	const ctl = (args: string[]) => execa("systemctl", ["--user", ...args], { reject: false, timeout: 10000 });
	const token = createToken("drill", "curl-read", ["read"]);
	const pause = createToken("drill", "pause", ["pause"]);
	const headers = { authorization: `Bearer ${token}` };
	const base = `http://127.0.0.1:${port}`;
	try {
		await execa("systemd-run", ["--user", "--collect", "--quiet", "--unit", unit, "--property=KillMode=control-group", "--property=Restart=on-failure", "--property=RestartSec=12", `--setenv=DURABLE_HOME=${home}`, `--setenv=DURABLE_AGENTS_DIR=${config}`, `--setenv=DURABLE_MACHINE_FILE=${machine}`, process.execPath, fileURLToPath(import.meta.url), "child"], { timeout: 10000 });
		await eventually(() => existsSync(join(home, "tool-started")), 10000);
		const curl = (path: string, extra: string[] = []) => execa("curl", ["--silent", "--show-error", "--config", "-", ...extra, `${base}${path}`], { input: `header = "Authorization: Bearer ${token}"\n`, reject: false, timeout: 5000 });
		const device = JSON.parse((await curl("/v1/device")).stdout);
		const nodes = JSON.parse((await curl("/v1/conversations?tree=true")).stdout).nodes;
		assert.equal((await curl(`/v1/conversations/${nodes[0].id}/transcript`)).exitCode, 0);
		assert.equal((await curl("/v1/inbox")).exitCode, 0);
		const stream = await curl("/v1/events", ["--no-buffer", "--max-time", "1"]);
		assert.ok(stream.stdout.indexOf('"type":"hello"') < stream.stdout.indexOf('"type":"snapshot"'));
		const denied = await curl(`/v1/conversations/${nodes[0].id}/messages`, ["--output", "/dev/null", "--write-out", "%{http_code}", "--request", "POST", "--data", JSON.stringify({ body: "hello", requestId: "denied", whenBusy: "followUp" })]);
		assert.equal(denied.stdout, "403");
		const old = JSON.parse(readFileSync(join(home, "agents/drill/procs.json"), "utf8")).invocations[0];
		assert.equal((await ctl(["kill", "--kill-whom=main", "--signal=KILL", unit])).exitCode, 0);
		await eventually(async () => { try { const current = await (await fetch(`${base}/v1/device`, { headers, signal: AbortSignal.timeout(500) })).json(); return current.startedAt > device.startedAt; } catch { return false; } }, 35000);
		assert.equal(existsSync(`/proc/${old.pid}`), false);
		assert.equal(JSON.parse(readFileSync(join(home, "agents/drill/procs.json"), "utf8")).invocations.length, 0);
		assert.equal((await fetch(`${base}/v1/pause`, { method: "POST", headers: { authorization: `Bearer ${pause}` } })).status, 200);
		const ticks = readAudit("drill").filter((event) => event.event === "tick").length;
		await new Promise((resolve) => setTimeout(resolve, 2200));
		assert.equal(readAudit("drill").filter((event) => event.event === "tick").length, ticks);
		await execa("script", ["-q", "-c", `${process.execPath} ${fileURLToPath(new URL("../bin/durable.ts", import.meta.url))} resume drill`, "/dev/null"], { timeout: 10000 });
		await eventually(() => readAudit("drill").filter((event) => event.event === "tick").length > ticks);
		const control = await ctl(["show", "--property=KillMode", "--property=ControlGroup", unit]);
		assert.ok(control.stdout.includes("KillMode=control-group"));
		console.log(JSON.stringify({ liveUserService: true, identity: "faux-injected", curlDevice: true, curlSseOrdered: true, curlTranscript: true, curlInbox: true, readPostStatus: 403, sigkillRestart: true, oldToolGone: true, pauseNoTicks: true, ttyCliResume: true, killMode: "control-group" }));
	} finally { await ctl(["stop", unit]); await ctl(["reset-failed", unit]); }
}
