import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import test from "node:test";
import { execa } from "execa";
import type {
	Containment,
	Invocation,
} from "../../src/platform/containment.ts";
import {
	markerTargets,
	ProcessContainment,
} from "../../src/platform/processContainment.ts";
import {
	recursivelyEmpty,
	SystemdContainment,
} from "../../src/platform/systemdContainment.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import { eventually, isolate } from "../support/harness.ts";
import { liveContainment } from "../support/live.ts";

const gate = resolve("bin/durable-gate");
const token = "exact-release-token";
const hash = createHash("sha256").update(token).digest("hex");
for (const scenario of [
	"EOF",
	"empty",
	"wrong",
	"oversized",
	"timeout",
	"exact",
] as const)
	test(`gate ${scenario}`, { timeout: 5000 }, async () => {
		const home = isolate(),
			marker = join(home, "executed");
		const child = execa(
			process.execPath,
			[gate, hash, "/bin/sh", "-c", 'printf x > "$1"', "target", marker],
			{
				env: { DURABLE_GATE_TIMEOUT_MS: "100" },
				stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
				reject: false,
			},
		);
		const pipe = child.stdio[3] as unknown as Writable;
		pipe.on("error", () => {});
		child.nodeChildProcess.once("exit", () => pipe.destroy());
		if (scenario === "exact") pipe.end(`${token}\n`);
		else if (scenario === "EOF") pipe.end();
		else if (scenario === "empty") pipe.end("\n");
		else if (scenario === "wrong") pipe.end("bad\n");
		else if (scenario === "oversized") pipe.end("x".repeat(2000));
		const result = await child;
		assert.equal(result.exitCode, scenario === "exact" ? 0 : 97);
		assert.equal(existsSync(marker), scenario === "exact");
	});
test("gate read descriptor error exits 97 without target", async () => {
	const result = await execa(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {closeSync} from 'node:fs'; closeSync(3); process.argv=[process.execPath, ${JSON.stringify(gate)}, ${JSON.stringify(hash)}, '/usr/bin/true']; await import(${JSON.stringify(`file://${gate}`)});`,
		],
		{ stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], reject: false },
	);
	assert.equal(result.exitCode, 97);
});
test("recursive populated flag beats an empty slice cgroup.procs", async () => {
	const home = isolate(),
		group = join(home, "slice");
	mkdirSync(join(group, "scope"), { recursive: true });
	writeFileSync(join(group, "cgroup.procs"), "");
	writeFileSync(join(group, "cgroup.events"), "populated 1\nfrozen 0\n");
	writeFileSync(join(group, "scope/cgroup.procs"), "123\n");
	const backend = new SystemdContainment(
		async () => ({
			exitCode: 0,
			stdout: "LoadState=loaded\nControlGroup=/slice\nActiveState=active\n",
		}),
		home,
		0,
	);
	assert.equal(await backend.empty(record()), false);
	writeFileSync(join(group, "cgroup.events"), "populated 0\nfrozen 0\n");
	assert.ok(await backend.empty(record()));
	assert.equal(recursivelyEmpty("populated 1\n"), false);
});
function record(): Invocation {
	return {
		invocationId: "invocation",
		attemptId: "one",
		item: "item",
		unit: "durable-test.scope",
		slice: "durable-test.slice",
		state: "intent",
		marker: "invocation",
	};
}
test("a forgotten unit cannot hide a populated recorded kernel cgroup", async () => {
	const home = isolate();
	mkdirSync(join(home, "stale"));
	writeFileSync(join(home, "stale/cgroup.events"), "populated 1\n");
	const backend = new SystemdContainment(
		async () => ({ exitCode: 0, stdout: "LoadState=not-found\n" }),
		home,
		0,
	);
	assert.equal(await backend.empty({ ...record(), cgroup: "/stale" }), false);
	writeFileSync(join(home, "stale/cgroup.events"), "populated 0\n");
	assert.equal(await backend.empty({ ...record(), cgroup: "/stale" }), true);
});
test("failed cleanup retains every intent, fences item and audits escalation", async () => {
	const home = isolate();
	mkdirSync(join(home, "agents/fault"), { recursive: true });
	writeFileSync(
		join(home, "agents/fault/procs.json"),
		JSON.stringify({ invocations: [record()], holds: {} }),
	);
	const backend = {
		confirmed: true,
		kill: async () => false,
		empty: async () => false,
		spawn: () => {
			throw Error("unused");
		},
	} satisfies Containment;
	const manager = new ProcessManager("fault", backend);
	assert.equal(await manager.sweep(), false);
	assert.equal(manager.snapshot().invocations.length, 1);
	assert.ok(manager.fenced("item"));
	assert.match(
		readFileSync(join(home, "agents/fault/audit.jsonl"), "utf8"),
		/escalation/,
	);
	await assert.rejects(
		manager.launch(
			["/usr/bin/true"],
			{ PATH: process.env.PATH },
			{ item: "item" },
		),
		/fenced/,
	);
	assert.ok(new ProcessManager("fault", backend).fenced("item"));
});
test("scope creation failure never launches outside containment", async () => {
	const home = isolate(),
		marker = join(home, "executed");
	const stub = join(home, "systemd-run");
	writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const manager = new ProcessManager("refused", new SystemdContainment());
	await assert.rejects(
		manager.launch(["/bin/sh", "-c", `touch "$1"`, "x", marker], {
			PATH: home,
		}),
	);
	assert.equal(existsSync(marker), false);
});
test("Android marker scanner does not signal reused PIDs or unmarked setsid children", async () => {
	const rec = { ...record(), pid: 101, startTime: "old" };
	const uid = process.getuid?.() ?? -1;
	const processes = [
		{ pid: 101, pgid: 101, startTime: "reused", uid },
		{ pid: 102, pgid: 102, startTime: "marked", uid, marker: rec.marker },
		{ pid: 103, pgid: 103, startTime: "unmarked", uid },
	];
	assert.deepEqual(
		markerTargets(rec, processes, uid).map((p) => p.pid),
		[102],
	);
	const signalled: number[] = [];
	const backend = new ProcessContainment(
		async () => processes,
		(pid) => {
			signalled.push(pid);
			return true;
		},
	);
	assert.equal(await backend.kill(rec), false);
	assert.deepEqual(signalled, [102, 102]);
});
for (const state of ["intent", "registered", "releasing", "running"] as const)
	test(`startup treats ${state} as live`, async () => {
		const home = isolate();
		mkdirSync(join(home, "agents/fault"), { recursive: true });
		writeFileSync(
			join(home, "agents/fault/procs.json"),
			JSON.stringify({
				invocations: [{ ...record(), state }],
				holds: { held: { state: "held", holdEpoch: 1 } },
			}),
		);
		let killed = false;
		const manager = new ProcessManager("fault", {
			confirmed: true,
			kill: async () => {
				killed = true;
				return true;
			},
			empty: async () => true,
			spawn: () => {
				throw Error("unused");
			},
		});
		assert.ok(await manager.sweep());
		assert.ok(killed);
		assert.equal(manager.snapshot().invocations.length, 0);
		assert.ok(manager.fenced("held"));
	});
for (const action of [
	"intent",
	"spawn",
	"registered",
	"releasing",
	"token-write",
	"running",
	"delete",
	"kill",
])
	for (const side of ["before", "after"])
		test(`SIGKILL ${side}:${action} then real startup scope sweep`, {
			timeout: 20000,
			skip: !liveContainment,
		}, async () => {
			const home = isolate(),
				marker = join(home, "target");
			const child = await execa(
				process.execPath,
				["test/fixtures/crash-process.ts", `${side}:${action}`, marker],
				{ env: { DURABLE_HOME: home }, reject: false, timeout: 10000 },
			);
			assert.equal(child.signal, "SIGKILL");
			const manager = new ProcessManager(
				"fault",
				new SystemdContainment(undefined, undefined, 20),
			);
			assert.ok(await manager.sweep());
			assert.equal(manager.snapshot().invocations.length, 0);
			if (
				["intent", "spawn", "registered", "releasing"].includes(action) ||
				(action === "token-write" && side === "before")
			)
				assert.equal(existsSync(marker), false);
		});
test("real Linux containment kills background, nohup, setsid delayed writers recursively", {
	timeout: 25000,
	skip: !liveContainment,
}, async () => {
	const home = isolate(),
		delayed = join(home, "delayed"),
		started = join(home, "started");
	const manager = new ProcessManager(
		"descendants",
		new SystemdContainment(undefined, undefined, 100),
	);
	const result = manager.launch(
		[
			"/bin/sh",
			"-c",
			'sleep 300 & nohup sh -c "sleep 300" >/dev/null 2>&1 & setsid sh -c \'sleep 10; echo x >> "$1"\' child "$1" >/dev/null 2>&1 & echo ready > "$2"; wait',
			"parent",
			delayed,
			started,
		],
		{ PATH: process.env.PATH },
		{ item: "descendants", attemptId: "one" },
	);
	await eventually(() => existsSync(started));
	assert.ok(await manager.terminate({ item: "descendants" }));
	await result;
	assert.equal(manager.snapshot().invocations.length, 0);
	await new Promise((resolve) => setTimeout(resolve, 15000));
	assert.equal(existsSync(delayed), false);
});
