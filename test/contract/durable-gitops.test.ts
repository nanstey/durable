import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	GitOperations,
	type OperationIntent,
	type WorkerGit,
	WorkerGithubCli,
} from "../../src/workers/durable/gitops.ts";
import {
	withWorkerOperation,
	workerOperation,
} from "../../src/workers/durable/operation.ts";
import type { JobSpec } from "../../src/workers/kind.ts";
import { durableRig } from "../support/durable.ts";

async function rigForOperations() {
	const rig = await durableRig();
	const records = new Map<string, OperationIntent>();
	const job: JobSpec = {
		id: "attempt",
		item: "item",
		agent: "agent",
		repo: "acme/repo",
		role: "worker",
		briefText: "brief",
		workspace: {
			id: "workspace",
			path: rig.checkout,
			branch: "durable/agent/item",
		},
		model: { provider: "faux", model: "one" },
		limits: {},
		env: {},
	};
	const store = {
		read: async (id: string, op: string) => records.get(`${id}/${op}`),
		write: async (intent: OperationIntent) => {
			records.set(`${intent.attemptId}/${intent.op}`, structuredClone(intent));
		},
	};
	let conflicts = 0;
	const make = (git: WorkerGit = rig.nativeGit, github = rig.github) =>
		new GitOperations({
			store,
			git,
			github,
			login: "operator-login",
			check: async () => {},
			conflict: async () => {
				conflicts++;
			},
		});
	return { ...rig, records, job, store, make, conflicts: () => conflicts };
}

test("push response lost after success reconciles exact SHA; interrupted rerun never pushes twice or creates a second PR", async () => {
	const rig = await rigForOperations();
	try {
		let pushes = 0;
		const git = {
			head: rig.nativeGit.head.bind(rig.nativeGit),
			commit: rig.nativeGit.commit.bind(rig.nativeGit),
			push: async (...args: Parameters<typeof rig.nativeGit.push>) => {
				pushes++;
				assert.deepEqual(
					rig.records.get("attempt/push_branch"),
					args[1],
					"intent is committed before push",
				);
				await rig.nativeGit.push(...args);
				throw Error("reply lost");
			},
		};
		const operations = rig.make(git);
		const sha = await rig.nativeGit.head(rig.job);
		assert.equal(
			(await operations.run(rig.job, "push_branch")).state,
			"confirmed",
		);
		assert.equal(rig.records.get("attempt/push_branch")?.commitSha, sha);
		assert.equal(pushes, 1);
		// Simulates reopening the durable store with a fresh in-flight map.
		assert.equal(
			(await rig.make(git).run(rig.job, "push_branch")).state,
			"confirmed",
		);
		assert.equal(pushes, 1);
		const createPr = rig.github.createPr;
		let creates = 0;
		rig.github.createPr = async (input) => {
			creates++;
			assert.equal(rig.records.get("attempt/open_draft_pr")?.state, "intent");
			await createPr(input);
			throw Error("PR reply lost");
		};
		assert.equal(
			(await operations.run(rig.job, "open_draft_pr")).state,
			"confirmed",
		);
		assert.equal(
			(await rig.make(git).run(rig.job, "open_draft_pr")).state,
			"confirmed",
		);
		assert.equal(creates, 1);
		assert.equal(rig.drafts.length, 1);
	} finally {
		await rig.harness.close();
	}
});

test("intervening branch changes before push or on interrupted retry are conflicts and never overwrite", async () => {
	for (const beforeFirstPush of [true, false]) {
		const rig = await rigForOperations();
		try {
			let reads = 0,
				pushes = 0;
			const git = {
				head: rig.nativeGit.head.bind(rig.nativeGit),
				commit: rig.nativeGit.commit.bind(rig.nativeGit),
				push: async () => {
					pushes++;
					throw Error("not applied");
				},
			};
			let moved = false;
			const github = {
				...rig.github,
				remoteHead: async () => {
					reads++;
					return moved || (beforeFirstPush && reads > 1)
						? "somebody-elses-sha"
						: undefined;
				},
			};
			const operations = rig.make(git, github);
			const first = await operations.run(rig.job, "push_branch");
			if (beforeFirstPush) assert.equal(first.state, "conflict");
			else {
				assert.equal(first.state, "intent");
				moved = true;
				assert.equal(
					(await rig.make(git, github).run(rig.job, "push_branch")).state,
					"conflict",
				);
			}
			assert.equal(pushes, beforeFirstPush ? 0 : 1);
			assert.equal(rig.conflicts(), 1);
		} finally {
			await rig.harness.close();
		}
	}
});

test("concurrent same-item retries have one network effect and return busy with the same intent", async () => {
	const rig = await rigForOperations();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let pushes = 0;
	try {
		const operations = rig.make({
			head: rig.nativeGit.head.bind(rig.nativeGit),
			commit: rig.nativeGit.commit.bind(rig.nativeGit),
			push: async (...args) => {
				pushes++;
				started();
				await gate;
				await rig.nativeGit.push(...args);
			},
		});
		const first = operations.run(rig.job, "push_branch");
		await ready;
		const second = await operations.run(rig.job, "push_branch");
		assert.equal(second.state, "busy");
		assert.deepEqual(
			"intent" in second ? second.intent : null,
			rig.records.get("attempt/push_branch"),
		);
		release();
		assert.equal((await first).state, "confirmed");
		assert.equal(pushes, 1);
	} finally {
		release();
		await rig.harness.close();
	}
});

test("trusted git ignores hostile worktree config/hooks/helpers and push lands only on the fixed target", async () => {
	const rig = await rigForOperations();
	try {
		const marker = join(rig.home, "hostile-executed");
		const script = join(rig.home, "hostile.sh");
		writeFileSync(script, `#!/bin/sh\nenv > '${marker}'\n`, { mode: 0o700 });
		const hooks = join(rig.home, "hostile-hooks");
		mkdirSync(hooks);
		for (const name of ["pre-push", "pre-commit", "reference-transaction"])
			writeFileSync(join(hooks, name), `#!/bin/sh\n'${script}'\n`, {
				mode: 0o700,
			});
		for (const [key, value] of [
			["remote.origin.pushurl", join(rig.home, "wrong-remote.git")],
			["url.file:///wrong/.insteadOf", rig.remote],
			["credential.helper", `!${script}`],
			["core.hooksPath", hooks],
			["core.fsmonitor", script],
			["core.sshCommand", script],
			["filter.hostile.clean", script],
		])
			await rig.git("-C", rig.checkout, "config", key, value);
		writeFileSync(
			join(rig.checkout, ".gitattributes"),
			"file.txt filter=hostile\n",
		);
		writeFileSync(join(rig.checkout, "file.txt"), "changed\n");
		const operations = rig.make();
		const sha = await operations.commit(rig.job, "fix: guarded commit");
		assert.equal(
			(await operations.run(rig.job, "push_branch")).state,
			"confirmed",
		);
		assert.equal(
			await rig.github.remoteHead("acme/repo", rig.job.workspace.branch),
			sha,
		);
		assert.equal(
			existsSync(marker),
			false,
			"no hostile hook, helper, fsmonitor or filter executed",
		);
		const push = rig.processes.commands.find((args) => args.includes("push"))!;
		assert.equal(push.at(-1), `${sha}:refs/heads/durable/agent/item`);
		assert.ok(push.includes(rig.remote));
		assert.ok(!push.some((arg) => arg.includes("fixture-token")));
		assert.equal(
			await rig.git("--git-dir", rig.remote, "show", `${sha}:file.txt`),
			"changed",
		);
	} finally {
		await rig.harness.close();
	}
});

test("an explicitly retried attempt starts from the pushed SHA, not the original checkout head", async () => {
	const rig = await rigForOperations();
	try {
		writeFileSync(join(rig.checkout, "file.txt"), "first attempt\n");
		const first = rig.make();
		const sha = await first.commit(rig.job, "fix: first attempt");
		await first.run(rig.job, "push_branch");
		const next = { ...rig.job, id: "attempt-2", baseSha: sha };
		assert.equal(await rig.nativeGit.head(next), sha);
		writeFileSync(join(rig.checkout, "file.txt"), "second attempt\n");
		const second = rig.make();
		const nextSha = await second.commit(next, "fix: explicit retry");
		assert.equal((await second.run(next, "push_branch")).state, "confirmed");
		assert.equal(
			await rig.github.remoteHead("acme/repo", rig.job.workspace.branch),
			nextSha,
		);
		assert.equal(
			await rig.git("--git-dir", rig.remote, "rev-parse", `${nextSha}^`),
			sha,
		);
	} finally {
		await rig.harness.close();
	}
});

test("code-owned GitHub reads inherit attempt containment and cancellation prevents follow-on subprocesses", async () => {
	const rig = await rigForOperations();
	const controller = new AbortController();
	const calls: Array<{ item?: string; attemptId?: string }> = [];
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const client = new WorkerGithubCli({
		env: {},
		processes: {
			launch: async (_argv, _env, options = {}) => {
				calls.push(options);
				await waiting;
				return { exitCode: 0, stdout: "[]", stderr: "" };
			},
		},
	});
	try {
		const request = withWorkerOperation(
			rig.job,
			{
				terminate: async () => {
					release();
					return true;
				},
			},
			controller.signal,
			async () => {
				await client.remoteHead("acme/repo", rig.job.workspace.branch);
				await client.remoteHead("acme/repo", rig.job.workspace.branch);
			},
		);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		await assert.rejects(request);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0], { item: "item", attemptId: "attempt" });
		assert.equal(
			workerOperation(),
			undefined,
			"execution context cannot leak into the next invocation",
		);
		const before = rig.processes.commands.length;
		await assert.rejects(() =>
			withWorkerOperation(rig.job, rig.processes, controller.signal, () =>
				rig.nativeGit.commit(rig.job, "must not execute"),
			),
		);
		assert.equal(rig.processes.commands.length, before);
	} finally {
		release();
		await rig.harness.close();
	}
});

test("draft PR refuses wrong head SHA, non-draft or moved remote head", async () => {
	for (const mode of ["wrong-sha", "not-draft", "moved"] as const) {
		const rig = await rigForOperations();
		try {
			const operations = rig.make();
			await operations.run(rig.job, "push_branch");
			const sha = await rig.nativeGit.head(rig.job);
			rig.drafts.push({
				number: 1,
				headSha: mode === "wrong-sha" ? "other" : sha,
				draft: mode !== "not-draft",
				body: rig.marker("item"),
			});
			if (mode === "moved") rig.github.remoteHead = async () => "moved";
			assert.equal(
				(await operations.run(rig.job, "open_draft_pr")).state,
				"conflict",
			);
			assert.equal(rig.conflicts(), 1);
		} finally {
			await rig.harness.close();
		}
	}
});
