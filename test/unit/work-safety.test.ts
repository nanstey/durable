import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { execa } from "execa";
import { ApprovalNonces } from "../../src/approval/nonce.ts";
import { FakeDispatcher } from "../../src/dispatch/fake.ts";
import { GitProcessDispatcher } from "../../src/dispatch/gitProcess.ts";
import { fencedDispatcher } from "../../src/dispatch/hold.ts";
import { workerToolEnv } from "../../src/identity/workerTools.ts";
import { ProcessContainment } from "../../src/platform/processContainment.ts";
import { workspaceWriters } from "../../src/platform/workspaceWriters.ts";
import { readAudit, setAuditIdentity } from "../../src/steward/audit.ts";
import { agentDir, saveJson } from "../../src/steward/files.ts";
import { Github } from "../../src/steward/github.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import { isolate } from "../support/harness.ts";

for (const mismatch of ["agent", "action", "item", "epoch", "expiry"])
	test(`release nonce refuses ${mismatch} mismatch and is single-use across restart`, () => {
		isolate();
		let now = 1000;
		const nonces = new ApprovalNonces("agent", () => now);
		const code = nonces.issue("release", "item", 1);
		const reader = new ApprovalNonces(
			mismatch === "agent" ? "another" : "agent",
			() => now,
		);
		if (mismatch === "expiry") now += 300001;
		assert.equal(
			reader.verify(
				mismatch === "action" ? "approve" : "release",
				mismatch === "item" ? "other" : "item",
				mismatch === "epoch" ? 2 : 1,
				code,
			),
			false,
		);
		if (mismatch !== "expiry") {
			assert.equal(nonces.verify("release", "item", 1, code), true);
			assert.equal(nonces.verify("release", "item", 1, code), false);
		}
	});

for (const name of ["fake", "git-process"] as const)
	test(`${name}: holding/held fences workspace creation, process launch, send and removal`, async () => {
		const home = isolate();
		const raw =
			name === "fake"
				? new FakeDispatcher()
				: new GitProcessDispatcher(join(home, "workspaces"));
		const dispatcher = fencedDispatcher(raw, "agent", () => true);
		const workspace = {
			id: "durable-agent-item",
			path: join(home, "workspace"),
			branch: "durable/agent/item",
		};
		for (const _state of ["holding", "held"]) {
			await assert.rejects(
				dispatcher.createWorkspace({ ...workspace, repo: "repo" }),
				/human-held/,
			);
			await assert.rejects(dispatcher.removeWorkspace(workspace), /human-held/);
			await assert.rejects(
				dispatcher.hostProcess({
					id: "job",
					workspace,
					command: "pi",
					env: {},
				}),
				/human-held/,
			);
			if (dispatcher.sendInput)
				await assert.rejects(
					dispatcher.sendInput({ id: "job", handle: "h", workspace }, "text"),
					/human-held/,
				);
		}
	});

test("Linux kill failure retains a holding fence, names its slice and escalates across restart", async () => {
	isolate();
	saveJson(join(agentDir("agent"), "procs.json"), {
		invocations: [
			{
				invocationId: "invocation",
				attemptId: "attempt",
				item: "item",
				slice: "durable-fixture.slice",
				unit: "durable-fixture.scope",
				marker: "marker",
				state: "intent",
			},
		],
		holds: {},
	});
	const backend = {
		confirmed: true,
		spawn: () => {
			throw Error("not invoked");
		},
		kill: async () => false,
		empty: async () => false,
	};
	let processes = new ProcessManager("agent", backend);
	processes.beginHold("item", "operator", "test");
	const held = await processes.finishHold("item");
	assert.equal(held.state, "holding");
	assert.match(held.reason ?? "", /durable-fixture.slice/);
	assert.match(held.reason ?? "", /populated 0/);
	assert.ok(readAudit("agent").some((event) => event.event === "escalation"));
	processes = new ProcessManager("agent", backend);
	assert.equal(processes.fenced("item"), true);
	assert.equal((await processes.verifyHold("item")).state, "holding");
});
test("Android hold stays fenced and advisory verification cannot establish ownership, including after restart", async () => {
	isolate();
	const backend = new ProcessContainment(
		async () => [],
		() => true,
	);
	let processes = new ProcessManager("agent", backend);
	processes.beginHold("item", "operator", "test");
	assert.equal((await processes.finishHold("item")).state, "holding");
	processes = new ProcessManager("agent", backend);
	const report = await processes.verifyHold("item");
	assert.equal(report.state, "holding");
	assert.equal(report.confirmedEmpty, false);
	assert.match(report.reason ?? "", /Force-stop Termux.*reboot/);
	await assert.rejects(
		processes.launch(["/bin/true"], {}, { item: "item" }),
		/fenced/,
	);
	assert.equal(processes.beginHold("item", "operator", "test").holdEpoch, 1);
	processes.releaseHold("item", 1);
	assert.equal(processes.beginHold("item", "operator", "test").holdEpoch, 2);
});

test("advisory proc inspection lists an unmarked writer in the workspace but cannot see a future absolute-path writer", async () => {
	const home = isolate();
	const workspace = join(home, "workspace");
	const proc = join(home, "proc");
	mkdirSync(workspace);
	for (const [pid, cwd] of [
		["101", workspace],
		["102", "/"],
	]) {
		const path = join(proc, pid);
		mkdirSync(join(path, "fd"), { recursive: true });
		writeFileSync(join(path, "status"), "Uid:\t1000\t1000\n");
		symlinkSync(cwd, join(path, "cwd"));
	}
	assert.deepEqual(await workspaceWriters(workspace, proc, 1000), [101]);
});

test("production GitHub adapter audits every write with identity and fences the exact work item", async () => {
	isolate();
	setAuditIdentity("agent", "fixture", "operator-login");
	const calls: Array<{ argv: string[]; item?: string; read?: boolean }> = [];
	let fenced = false;
	const github = new Github({
		agent: "agent",
		login: "operator-login",
		env: { PATH: "/bin" },
		itemForIssue: () => "item",
		processes: {
			launch: async (argv, _env, options) => {
				calls.push({
					argv,
					item: options?.item,
					read: options?.allowWhenDisabled,
				});
				if (fenced && options?.item === "item") throw Error("held");
				const path = argv[2];
				const method = argv[4];
				const value =
					path?.endsWith("/labels") && method === "GET"
						? [{ name: "durable/claimed" }]
						: path?.includes("/comments") && method === "GET"
							? [{ id: 1, body: "marker" }]
							: path?.includes("/comments")
								? { id: 1, body: "marker" }
								: {};
				return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
			},
		},
	});
	await github.addLabel("acme/repo", 1, "durable/claimed");
	await github.createComment("acme/repo", 1, "marker");
	await github.listComments("acme/repo", 1);
	await github.updateComment("acme/repo", 1, "marker");
	await github.deleteComment("acme/repo", 1);
	await github.removeLabel("acme/repo", 1, "durable/claimed");
	const writes = calls.filter((call) => call.argv[4] !== "GET");
	assert.ok(writes.length >= 5);
	assert.ok(writes.every((call) => call.item === "item"));
	const lines = readAudit("agent").filter(
		(event) => event.event === "github-write",
	);
	assert.equal(lines.length, writes.length);
	assert.ok(
		lines.every(
			(event) =>
				event.profile === "fixture" && event.login === "operator-login",
		),
	);
	fenced = true;
	await assert.rejects(github.updateComment("acme/repo", 1, "changed"), /held/);
});

test("supported worker git/gh tools enforce commit trailer, draft attribution, own branch and audit without real GitHub writes", async () => {
	const home = isolate();
	const bin = join(home, "bin");
	mkdirSync(bin);
	const recorded = join(home, "args.json");
	const comments = join(home, "comments.json");
	const lease = new Date(Date.now() + 7200000).toISOString();
	writeFileSync(
		comments,
		JSON.stringify([
			{
				id: 1,
				body: `<!-- durable-claim agent=agent lease=${lease} owner=installation -->`,
				user: { login: "operator-login" },
			},
		]),
	);
	for (const tool of ["git", "gh"]) {
		writeFileSync(
			join(bin, tool),
			`#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2);\nif (args.includes('--include')) console.log('HTTP/2 200 OK\\nDate: ' + new Date().toUTCString() + '\\n\\n{}');\nelse if (args[0] === 'api' && args[1].includes('/comments?')) console.log(fs.readFileSync(${JSON.stringify(comments)}, 'utf8'));\nelse fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(args));\n`,
		);
		chmodSync(join(bin, tool), 0o700);
	}
	const env = workerToolEnv("agent", "fixture", "operator-login", {
		PATH: `${bin}:${process.env.PATH}`,
	});
	env.DURABLE_WORKER = "1";
	env.DURABLE_ITEM = "item";
	env.DURABLE_CLAIM = JSON.stringify({
		target: {
			repo: "acme/repo",
			issue: 1,
			agent: "agent",
			owner: "installation",
			login: "operator-login",
			lease,
		},
		commentId: 1,
		policy: { durationMs: 7200000, graceMs: 300000 },
	});
	writeFileSync(env.DURABLE_FENCE_FILE!, JSON.stringify({ holds: {} }));
	await execa("git", ["commit", "-m", "change"], { env, extendEnv: false });
	assert.deepEqual(JSON.parse(readFileSync(recorded, "utf8")).slice(-2), [
		"--trailer",
		"Durable-Agent: agent",
	]);
	await execa(
		"gh",
		["pr", "create", "--title", "Change", "--body", "Description"],
		{ env, extendEnv: false },
	);
	const args = JSON.parse(readFileSync(recorded, "utf8")) as string[];
	assert.ok(args.includes("--draft"));
	assert.ok(args.includes("durable/agent:item") === false);
	assert.ok(args.includes("durable/agent:agent"));
	assert.ok(
		args.at(-1)?.includes("<!-- durable-item agent=agent item=item -->"),
	);
	assert.ok(args.at(-1)?.includes("not yet reviewed by a human"));
	assert.equal(
		readAudit("agent").filter((event) => event.event === "github-write").length,
		1,
	);
	await assert.rejects(
		execa("git", ["push", "origin", "main"], { env, extendEnv: false }),
	);
	// A different claim id fences the still-running worker, even under the same login.
	writeFileSync(
		comments,
		JSON.stringify([
			{
				id: 2,
				body: `<!-- durable-claim agent=agent lease=${lease} owner=winner -->`,
				user: { login: "operator-login" },
			},
		]),
	);
	for (const [tool, args] of [
		["gh", ["pr", "create", "--title", "Late", "--body", "Late"]],
		["gh", ["issue", "comment", "1", "--body", "Late"]],
		["gh", ["issue", "edit", "1", "--add-label", "Late"]],
	] as const) {
		await assert.rejects(
			execa(tool, [...args], { env, extendEnv: false }),
			/claim lease lost/,
		);
	}
	writeFileSync(
		env.DURABLE_FENCE_FILE!,
		JSON.stringify({ holds: { item: { state: "held" } } }),
	);
	await assert.rejects(
		execa("gh", ["issue", "comment", "1", "--body", "forbidden"], {
			env,
			extendEnv: false,
		}),
	);
});
