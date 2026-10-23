import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { execa } from "execa";
import { createApi } from "../../src/api/routes.ts";
import { createToken, revokeToken } from "../../src/api/tokens.ts";
import { selectServiceManager } from "../../src/platform/service/select.ts";
import {
	SystemdUserServiceManager,
	unitText,
} from "../../src/platform/service/systemdUser.ts";
import { fixture, isolate } from "../support/harness.ts";

test("ServiceManager installs units, enables, stops, disables, reads logs and status through runner", async () => {
	const home = isolate(),
		commands: string[][] = [];
	const service = new SystemdUserServiceManager({
		directory: home,
		runner: async (command, args) => {
			commands.push([command, ...args]);
			return { exitCode: 0, stdout: "active\n" };
		},
	});
	await service.install("fixture");
	await service.enable("fixture");
	await service.start("fixture");
	await service.stop("fixture");
	await service.disable("fixture");
	assert.ok((await service.status("fixture")).active);
	for await (const line of service.logs("fixture"))
		assert.equal(line, "active\n");
	const unit = readFileSync(join(home, "durable-agent@.service"), "utf8");
	assert.match(unit, /KillMode=control-group/);
	assert.match(unit, /OnFailure=durable-agent-failure@%i.service/);
	assert.match(unit, /TimeoutStopSec=30/);
	assert.match(unit, /NoNewPrivileges=yes/);
	assert.match(
		readFileSync(join(home, "durable-agent-failure@.service"), "utf8"),
		/ExecStart=/,
	);
	assert.ok(
		commands.some((args) =>
			args
				.join(" ")
				.includes(["enable --now durable-agent@", "fixture.service"].join("")),
		),
	);
	assert.ok(commands.some((args) => args[0] === "journalctl"));
});
test("non-Linux service selection skips with a clear Linux-only message", async () => {
	const messages: string[] = [];
	const write = console.log;
	console.log = (message: string) => messages.push(message);
	try {
		const service = selectServiceManager({ platform: "darwin" });
		await service.enable("fixture");
		assert.match(
			(await service.status("fixture")).text,
			/Linux with systemd --user/,
		);
	} finally {
		console.log = write;
	}
	assert.match(messages.join("\n"), /skipping/);
});
test("service failure is explicit; inactive status is not treated as a crash", async () => {
	const service = new SystemdUserServiceManager({
		runner: async () => ({ exitCode: 1, stdout: "inactive" }),
	});
	await assert.rejects(service.start("fixture"), /failed/);
	assert.equal((await service.status("fixture")).active, false);
});
test("unit contains only optional non-default state home, never profile secrets", () => {
	assert.equal(unitText().includes("Environment="), false);
	assert.match(
		unitText('state%with"quote'),
		/DURABLE_HOME=state%%with\\"quote/,
	);
	assert.equal(/GH_TOKEN|auth-profiles|secrets\//.test(unitText()), false);
});
test("core source has no platform-specific command names or imports", () => {
	function walk(path: string): string[] {
		return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory()
				? entry.name === "platform"
					? []
					: walk(join(path, entry.name))
				: entry.name.endsWith(".ts")
					? [join(path, entry.name)]
					: [],
		);
	}
	for (const file of walk("src"))
		assert.doesNotMatch(
			readFileSync(file, "utf8"),
			/\bsystemctl\b|\bnotify-send\b/,
			file,
		);
});
test("citty preserves doctor help and rejects unknown commands", async () => {
	assert.match(
		(await execa(process.execPath, ["bin/durable.ts", "doctor", "--help"]))
			.stdout,
		/doctor|ID/,
	);
	const bad = await execa(
		process.execPath,
		["bin/durable.ts", "not-a-command"],
		{ reject: false },
	);
	assert.notEqual(bad.exitCode, 0);
	const workerOnly = await execa(
		process.execPath,
		["bin/durable.ts", "stop", "fixture", "--workers", "--dry-run"],
		{ reject: false },
	);
	assert.equal(workerOnly.exitCode, 0);
	assert.match(workerOnly.stdout, /POST \/v1\/workers\/stop/);
});
test("SSE hello then snapshot; fake-clock ping, tree delta, disconnect and reconnect snapshot", async (t) => {
	isolate();
	const { harness } = await fixture();
	try {
		const token = createToken("agent", "stream", ["read"]);
		const app = createApi({
			agent: "agent",
			machine: "fixture",
			profile: "fixture",
			harness,
			definition: { profile: "fixture" },
		});
		const response = await app.request("/v1/events", {
			headers: { authorization: `Bearer ${token}` },
		});
		assert.match(response.headers.get("content-type")!, /text\/event-stream/);
		const reader = response.body!.getReader();
		const decode = new TextDecoder();
		let output = "";
		while (!output.includes('"type":"snapshot"'))
			output += decode.decode((await reader.read()).value);
		assert.ok(
			output.indexOf('"type":"hello"') < output.indexOf('"type":"snapshot"'),
		);
		await reader.cancel();
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.enable({ apis: ["setInterval"] });
		const reconnect = await app.request("/v1/events", {
			headers: { authorization: `Bearer ${token}` },
		});
		const next = reconnect.body!.getReader();
		let second = "";
		while (!second.includes('"type":"snapshot"'))
			second += decode.decode((await next.read()).value);
		assert.ok(second.includes('"type":"hello"'));
		const chat = await harness.create("chat");
		t.mock.timers.tick(15000);
		let delta = "";
		while (!delta.includes('"type":"tree"') || !delta.includes(": ping"))
			delta += decode.decode((await next.read()).value);
		assert.ok(delta.includes(chat));
		revokeToken("agent", "stream");
		t.mock.timers.tick(250);
		while (!(await next.read()).done) {
			/* Drain already committed frames before the disconnect. */
		}
		await next.cancel();
		assert.equal((await harness.tree()).length, 2);
	} finally {
		await harness.close();
	}
});
