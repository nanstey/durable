import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { execa } from "execa";
import { createApi } from "../../src/api/routes.ts";
import { createToken } from "../../src/api/tokens.ts";
import { FakeDispatcher } from "../../src/dispatch/fake.ts";
import { GitProcessDispatcher } from "../../src/dispatch/gitProcess.ts";
import { OrcaDispatcher } from "../../src/dispatch/orca.ts";
import type {
	HostedProcess,
	WorkerDispatcher,
	Workspace,
} from "../../src/dispatch/types.ts";
import { PiSessionKind } from "../../src/workers/piSession.ts";
import { WorkerRegistry } from "../../src/workers/registry.ts";
import { eventually, fixture, isolate } from "../support/harness.ts";

async function gitRepository(home: string) {
	const repo = join(home, "repo");
	mkdirSync(repo);
	await execa("git", ["init", "-q", repo]);
	await execa("git", [
		"-C",
		repo,
		"config",
		"user.email",
		"test@example.invalid",
	]);
	await execa("git", ["-C", repo, "config", "user.name", "Test"]);
	writeFileSync(join(repo, "README.md"), "fixture\n");
	await execa("git", ["-C", repo, "add", "."]);
	await execa("git", ["-C", repo, "commit", "-qm", "fixture"]);
	return repo;
}

async function exerciseDispatcher(
	dispatcher: WorkerDispatcher,
	workspace: Workspace,
): Promise<HostedProcess> {
	assert.equal((await dispatcher.listWorkspaces()).length, 1);
	assert.equal(
		(
			await dispatcher.createWorkspace({
				id: workspace.id,
				repo: "ignored",
				branch: workspace.branch,
				path: workspace.path,
			})
		).path,
		workspace.path,
	);
	const hosted = await dispatcher.hostProcess({
		id: "job",
		workspace,
		command: "/bin/sh",
		args: ["-c", "printf launched; sleep 30"],
		env: { PATH: process.env.PATH, HOSTILE_PARENT_VALUE: undefined },
		headless: true,
	});
	assert.equal(
		(
			await dispatcher.hostProcess({
				id: "job",
				workspace,
				command: "/bin/false",
				env: {},
			})
		).handle,
		hosted.handle,
	);
	assert.equal(await dispatcher.processStatus(hosted), "running");
	if (dispatcher.sendInput) await dispatcher.sendInput(hosted, "steer");
	if (dispatcher.readOutput) {
		await eventually(
			async () =>
				(await dispatcher.readOutput?.(hosted))?.includes(
					dispatcher.name === "fake" ? "steer" : "launched",
				) ?? false,
		);
		assert.match(
			await dispatcher.readOutput(hosted),
			dispatcher.name === "fake" ? /steer/ : /launched/,
		);
	}
	await dispatcher.interruptProcess(hosted, "soft");
	const hard = await dispatcher.hostProcess({
		id: "hard-job",
		workspace,
		command: "/bin/sh",
		args: ["-c", "sleep 30"],
		env: { PATH: process.env.PATH },
		headless: true,
	});
	await dispatcher.interruptProcess(hard, "hard");
	return hosted;
}

test("fake dispatcher contract covers workspace, process, input, output, viewer, and held removal", async () => {
	const dispatcher = new FakeDispatcher();
	const workspace = await dispatcher.createWorkspace({
		id: "item",
		repo: "fixture",
		branch: "durable/agent/item",
	});
	const hosted = await exerciseDispatcher(dispatcher, workspace);
	assert.equal(await dispatcher.processStatus(hosted), "exited");
	assert.deepEqual(await dispatcher.workspaceTerminals?.(workspace), []);
	assert.deepEqual(
		await dispatcher.openViewer(workspace, {
			title: "viewer",
			command: "tail -f log",
		}),
		{ kind: "command", command: "tail -f log" },
	);
	await assert.rejects(
		dispatcher.removeWorkspace(workspace, { held: true }),
		/human-held/,
	);
	await dispatcher.removeWorkspace(workspace);
});

test("git-process contract launches an isolated worker and refuses dirty or held removal", async () => {
	const home = isolate();
	const repo = await gitRepository(home);
	const dispatcher = new GitProcessDispatcher(join(home, "workspaces"));
	const workspace = await dispatcher.createWorkspace({
		id: "item",
		repo,
		branch: "durable/agent/item",
	});
	const hosted = await exerciseDispatcher(dispatcher, workspace);
	await eventually(
		async () => (await dispatcher.processStatus(hosted)) === "exited",
	);
	assert.deepEqual(
		await dispatcher.openViewer(workspace, {
			title: "viewer",
			command: "tail -f log",
		}),
		{ kind: "command", command: "tail -f log" },
	);
	await assert.rejects(
		dispatcher.removeWorkspace(workspace, { held: true }),
		/human-held/,
	);
	const bin = join(home, "bin");
	const piLog = join(home, "pi.log");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "pi"),
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(piLog)}\n`,
	);
	chmodSync(join(bin, "pi"), 0o700);
	const registry = new WorkerRegistry();
	const kind = new PiSessionKind(dispatcher, join(home, "launchers"));
	const launched = await registry.launch(dispatcher, kind, {
		id: "pi-job",
		agent: "agent",
		item: "pi-item",
		role: "worker",
		briefText: "brief by value",
		workspace: { id: "pi-item", repo, branch: "durable/agent/pi-item" },
		model: { provider: "faux", model: "one" },
		limits: {},
		env: { PATH: `${bin}:${process.env.PATH}` },
	});
	await eventually(
		async () => (await dispatcher.processStatus(launched.process)) === "exited",
	);
	await eventually(() => existsSync(piLog));
	assert.match(readFileSync(piLog, "utf8"), /--provider/);
	assert.match(readFileSync(piLog, "utf8"), /--model/);
	writeFileSync(join(workspace.path, "dirty"), "x");
	await assert.rejects(dispatcher.removeWorkspace(workspace), /dirty/);
});

test("orca contract lists terminals before launch and reuses matching titles", async () => {
	const home = isolate();
	const calls = join(home, "calls");
	const command = join(home, "orca-stub");
	writeFileSync(
		command,
		`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
if (args[0] === "terminal" && args[1] === "list") console.log("[]");
else if (args[0] === "worktree") console.log(JSON.stringify({ path: ${JSON.stringify(home)} }));
else console.log(JSON.stringify({ id: "terminal-1" }));
`,
	);
	chmodSync(command, 0o700);
	const dispatcher = new OrcaDispatcher(command);
	const workspace = { id: "item", path: home, branch: "durable/agent/item" };
	const process = await dispatcher.hostProcess({
		id: "job",
		workspace,
		command: "pi",
		env: { GH_TOKEN: "test-secret-not-in-argv" },
	});
	assert.equal(process.handle, "terminal-1");
	assert.equal(
		(
			await dispatcher.hostProcess({
				id: "job",
				workspace,
				command: "pi",
				env: {},
			})
		).handle,
		"terminal-1",
	);
	assert.deepEqual(
		await dispatcher.openViewer(workspace, {
			title: "viewer",
			command: "durable attach agent/item",
		}),
		{ kind: "orca-terminal", handle: "terminal-1" },
	);
	const logged = readFileSync(calls, "utf8").trim().split("\n");
	assert.match(logged[0], /terminal list/);
	assert.match(logged[1], /terminal create/);
	assert.doesNotMatch(logged[1], /test-secret-not-in-argv/);
	assert.match(logged[2], /terminal list/);
	assert.match(logged[3], /terminal create/);
	const registry = new WorkerRegistry();
	const kind = new PiSessionKind(dispatcher, join(home, "launchers"));
	const launched = await registry.launch(dispatcher, kind, {
		id: "pi-job",
		agent: "agent",
		item: "pi-item",
		role: "worker",
		briefText: "brief by value",
		workspace: { id: "pi-item", repo: home, branch: "durable/agent/pi-item" },
		model: { provider: "faux", model: "one" },
		limits: {},
		env: {},
	});
	assert.equal(launched.process.handle, "terminal-1");
});

test("pi-session registry creates a workspace before launching and exposes transcript tail", async () => {
	const home = isolate();
	const piDir = join(home, "pi");
	mkdirSync(join(piDir, "sessions"), { recursive: true });
	writeFileSync(join(piDir, "sessions", "worker.jsonl"), '{"text":"tail"}\n');
	const dispatcher = new FakeDispatcher();
	const kind = new PiSessionKind(dispatcher, join(home, "launchers"));
	const registry = new WorkerRegistry();
	const handle = await registry.launch(dispatcher, kind, {
		id: "job",
		agent: "agent",
		item: "item",
		role: "worker",
		briefText: "implement this",
		workspace: { id: "item", repo: "fixture", branch: "durable/agent/item" },
		model: { provider: "faux", model: "one" },
		limits: {},
		env: { PATH: process.env.PATH },
		piDir,
	});
	assert.equal(handle.process.workspace.id, "item");
	assert.deepEqual(await registry.transcript("job"), ['{"text":"tail"}']);
	assert.equal((await registry.tree(null))[0].source, "dispatcher");
	await registry.steer("job", "continue");
	await registry.interrupt("job", "hard");
});

test("worker routes expose registered leaves, transcripts, steering, and interruption", async () => {
	const home = isolate();
	const dispatcher = new FakeDispatcher();
	const registry = new WorkerRegistry();
	const kind = new PiSessionKind(dispatcher, join(home, "launchers"));
	await registry.launch(dispatcher, kind, {
		id: "worker",
		agent: "agent",
		item: "item",
		role: "worker",
		briefText: "brief",
		workspace: { id: "item", repo: "fixture", branch: "durable/agent/item" },
		model: { provider: "faux", model: "one" },
		limits: {},
		env: {},
	});
	const { harness } = await fixture();
	try {
		const api = createApi({
			agent: "agent",
			machine: "fixture",
			profile: "fixture",
			harness,
			definition: { profile: "fixture" },
			workers: registry,
		});
		const read = createToken("agent", "read", ["read"]);
		const chat = createToken("agent", "chat", ["chat"]);
		const pause = createToken("agent", "pause", ["pause"]);
		const headers = (token: string) => ({ authorization: `Bearer ${token}` });
		assert.equal(
			(await api.request("/v1/workers", { headers: headers(read) })).status,
			200,
		);
		assert.equal(
			(await api.request("/v1/sessions", { headers: headers(read) })).status,
			200,
		);
		assert.equal(
			(
				await api.request("/v1/workers/worker/transcript", {
					headers: headers(read),
				})
			).status,
			200,
		);
		assert.equal(
			(
				await api.request("/v1/workers/worker/steer", {
					method: "POST",
					headers: { ...headers(chat), "content-type": "application/json" },
					body: JSON.stringify({ body: "continue" }),
				})
			).status,
			202,
		);
		assert.equal(
			(
				await api.request("/v1/workers/worker/interrupt", {
					method: "POST",
					headers: { ...headers(pause), "content-type": "application/json" },
					body: JSON.stringify({ mode: "hard" }),
				})
			).status,
			202,
		);
	} finally {
		await harness.close();
	}
});
