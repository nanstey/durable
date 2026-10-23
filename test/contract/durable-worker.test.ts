import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	type ConversationId,
	defineDoc,
	defineTask,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { pauseFile, resumeLocal } from "../../src/steward/killswitch.ts";
import { workItemId } from "../../src/steward/workItems.ts";
import {
	emptyWorkState,
	type WorkState,
} from "../../src/steward/workRuntime.ts";
import { durableWorkerToolNames } from "../../src/workers/durable/tools.ts";
import type { WorkerHandle } from "../../src/workers/kind.ts";
import { durableRig } from "../support/durable.ts";
import { eventually } from "../support/harness.ts";
import { candidate } from "../support/work.ts";

const call = (name: string, args: JsonObject = {}) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
async function worker(rig: Awaited<ReturnType<typeof durableRig>>) {
	await eventually(async () =>
		Boolean((await rig.items())[0]?.attempts[0]?.worker),
	);
	const item = (await rig.items())[0];
	const registered = await rig.config.work.workers.get(item.attempts[0].id);
	const id = Number(
		registered.handle.process.handle.replace("durable:", ""),
	) as ConversationId;
	const conversation = (await rig.harness.native.conversation(
		id,
		rig.harness.context,
	))!;
	return { ...registered, item, conversation };
}

test("selected native kind: claim -> fake workspace -> faux model fixed tools -> manifest commit -> local push -> fake draft PR; restart reuses ownership", async () => {
	const rig = await durableRig();
	const parent = process.env;
	process.env = {
		...parent,
		GH_TOKEN: "hostile-token",
		GITHUB_TOKEN: "hostile-alias",
		ANTHROPIC_API_KEY: "hostile-provider",
		PROFILE_SECRET: "hostile-profile",
		SSH_AUTH_SOCK: "hostile-socket",
	};
	rig.faux.setResponses([
		call("read", { path: "file.txt" }),
		call("edit", { path: "file.txt", before: "before", after: "after" }),
		call("write", { path: "new.txt", text: "new content" }),
		call("search", { needle: "after" }),
		call("bash", { command: "pwd; env" }),
		call("commit", { message: "fix: small change" }),
		call("push_branch"),
		call("open_draft_pr", { title: "Small change" }),
		call("report", { summary: "Done" }),
	]);
	try {
		rig.harness.start();
		await eventually(async () => rig.drafts.length === 1, 15000);
		const { kind, handle, item, conversation } = await worker(rig);
		await eventually(async () => (await kind.status(handle)) === "exited");
		assert.equal(
			rig.deps.dispatcher.launches.length,
			0,
			"no external Pi process",
		);
		assert.equal(rig.deps.github.comments.length, 1, "claim is code-owned");
		assert.equal(rig.pushes(), 1);
		assert.equal(rig.drafts[0].draft, true);
		assert.ok(rig.drafts[0].body.includes(rig.marker(item.id)));
		const commit = await rig.git(
			"--git-dir",
			rig.remote,
			"show",
			"-s",
			"--format=%an <%ae>%n%B",
			rig.drafts[0].headSha,
		);
		assert.match(commit, /Manifest Worker <worker@example.invalid>/);
		assert.match(commit, /Durable-Agent: agent/);
		assert.equal(
			await rig.git(
				"--git-dir",
				rig.remote,
				"show",
				`${rig.drafts[0].headSha}:file.txt`,
			),
			"after",
		);
		assert.equal(
			readFileSync(join(rig.checkout, "new.txt"), "utf8"),
			"new content",
		);
		const agent = await conversation.agent(rig.harness.context);
		assert.equal(agent.cwd, rig.checkout);
		assert.deepEqual(
			agent.tools.map((tool) => tool.name).sort(),
			[...durableWorkerToolNames].sort(),
		);
		const entries = await conversation.entries(
			{ order: "ascending" },
			200,
			undefined,
			rig.harness.context,
		);
		const results = entries.items.filter(
			(entry) => entry.kind === "pi.tool-result",
		);
		assert.equal(results.length, 9);
		assert.ok(!JSON.stringify(results).includes("fixture-secret"));
		assert.ok(!JSON.stringify(results).includes("fixture-token"));
		assert.ok(!JSON.stringify(results).includes("fixture-alias"));
		assert.doesNotMatch(
			JSON.stringify(results),
			/hostile-(?:token|alias|provider|profile|socket)|fixture-(?:provider|connector)/,
		);
		assert.ok(JSON.stringify(results).includes("DURABLE_WORKER=1"));
		assert.equal(kind.capabilities().tokenInShell, false);
		assert.equal(kind.capabilities().resumeAfterCrash, true);
		assert.deepEqual(kind.capabilities(), {
			attach: "interactive",
			steer: true,
			transcript: true,
			interrupt: true,
			resumeAfterCrash: true,
			skills: "allowlisted-text",
			extensions: false,
			anthropicOAuth: "modelAuth-option",
			headless: true,
			processIsolated: false,
			tokenInShell: false,
			viewable: "durable-attach",
		});
		await assert.rejects(
			() =>
				kind.start({
					...handle.job,
					id: "unsupported-reviewer",
					role: "reviewer",
				}),
			{ code: "not_supported", status: 501 },
		);
		await eventually(async () => (await rig.items())[0].prs.length === 1);
		const before = (await rig.harness.tree()).filter(
			(node) => node.kind === "worker-durable",
		);
		assert.equal(before.length, 1);
		await rig.restart();
		rig.harness.start();
		await eventually(async () => (await rig.harness.snapshot()).ticks >= 2);
		const resumed = await rig.config.work.kinds
			.get("durable-conversation")
			.resume(handle);
		assert.equal(resumed.process.handle, handle.process.handle);
		assert.equal(
			(await rig.harness.tree()).filter(
				(node) => node.kind === "worker-durable",
			).length,
			1,
		);
		assert.equal(rig.pushes(), 1);
		assert.equal(rig.drafts.length, 1);
	} finally {
		process.env = parent;
		await rig.harness.close();
	}
});

test("background run-worker belongs to WorkItemTask; main abort, node abort and soft interrupt leave attempt waiting for follow-up", async () => {
	const rig = await durableRig();
	writeFileSync(
		join(rig.checkout, "ready.sh"),
		"#!/bin/sh\necho ready > ready; sleep 30\n",
	);
	rig.faux.setResponses([call("bash", { command: "sh ready.sh" })]);
	try {
		rig.harness.start();
		const { kind, handle, conversation } = await worker(rig);
		await eventually(() =>
			rig.processes.commands.some((argv) => argv.includes("sh ready.sh")),
		);
		const graph = await rig.harness.native.taskGraph(rig.harness.context);
		const anchor = Object.values(graph.value.tasks).find(
			(task) => task.kind === "durable.run-worker",
		)!;
		assert.equal(
			anchor.background,
			false,
			"native API forbids background child tasks",
		);
		assert.equal(graph.value.tasks[anchor.owner!].kind, "steward.work-item");
		assert.equal(graph.value.tasks[anchor.owner!].background, true);
		const loop = Object.values(graph.value.tasks).find(
			(task) => task.kind === "steward-loop",
		)!;
		graph.dispose();
		await rig.harness.native.abortTask(loop.id, rig.harness.context);
		await rig.harness.root.abort(rig.harness.context);
		assert.equal(await kind.status(handle), "running");
		await kind.interrupt(handle, "soft");
		assert.equal(
			(await rig.harness.tree()).find((node) => node.kind === "worker-durable")
				?.status,
			"waiting",
		);
		assert.equal((await kind.result(handle)).outcome, undefined);
		assert.equal(await kind.status(handle), "running");
		rig.faux.setResponses([fauxAssistantMessage("follow-up accepted")]);
		await kind.steer!(handle, "Continue by inspecting the files.");
		await eventually(async () =>
			JSON.stringify(
				(
					await conversation.entries(
						{ order: "ascending" },
						100,
						undefined,
						rig.harness.context,
					)
				).items,
			).includes("follow-up accepted"),
		);
		const count = (
			await conversation.entries(
				{ order: "ascending" },
				100,
				undefined,
				rig.harness.context,
			)
		).items.length;
		const publicId = (await rig.harness.tree()).find(
			(node) => node.kind === "worker-durable",
		)!.id;
		await rig.harness.abort(publicId);
		await rig.restart();
		rig.harness.start();
		await new Promise((resolve) => setTimeout(resolve, 1200));
		assert.equal(
			(
				await (
					await worker(rig)
				).conversation.entries(
					{ order: "ascending" },
					100,
					undefined,
					rig.harness.context,
				)
			).items.length,
			count,
		);
		assert.equal((await rig.items())[0].attempts.length, 1);
	} finally {
		await rig.harness.close();
	}
});

for (const operation of [
	"hard",
	"hold",
	"pause",
	"kill-switch",
	"stop",
	"wall-clock",
	"tools",
	"turns",
	"tokens",
] as const)
	test(`native lifecycle ${operation} persists a terminal fence across restart`, async () => {
		const limits: Record<string, number> =
			operation === "wall-clock"
				? { itemMinutes: 0.002 }
				: operation === "tools"
					? { maxToolCalls: 1 }
					: operation === "turns"
						? { maxTurns: 1 }
						: operation === "tokens"
							? { tokenBudget: 1 }
							: {};
		const rig = await durableRig(limits);
		rig.faux.setResponses(
			operation === "tools"
				? [
						call("read", { path: "file.txt" }),
						call("write", { path: "forbidden", text: "no" }),
					]
				: [call("bash", { command: "sleep 30" })],
		);
		try {
			rig.harness.start();
			const { item, handle, kind } = await worker(rig);
			if (operation === "hard")
				await rig.harness.interruptWorker(handle.id, "hard");
			if (operation === "hold")
				await rig.harness.workRuntime!.hold(item.id, "operator", "test");
			if (operation === "pause") await rig.harness.pause();
			if (operation === "kill-switch") pauseFile("agent");
			if (operation === "stop") await rig.harness.workRuntime!.stop("stopped");
			const expected =
				operation === "hard"
					? "interrupted"
					: operation === "hold"
						? "held"
						: operation === "pause" || operation === "kill-switch"
							? "paused"
							: operation === "stop"
								? "stopped"
								: "limit";
			await eventually(
				async () => (await kind.result(handle)).outcome === expected,
			);
			await eventually(() => rig.processes.terminations > 0);
			await eventually(async () =>
				Boolean((await rig.items())[0].attempts[0].endedAt),
			);
			const before = rig.processes.commands.length;
			await rig.restart();
			rig.harness.start();
			await new Promise((resolve) => setTimeout(resolve, 1200));
			const restored = await rig.config.work.kinds
				.get("durable-conversation")
				.result(handle);
			assert.equal(restored.outcome, expected);
			assert.equal(rig.processes.commands.length, before);
			assert.equal((await rig.items())[0].attempts.length, 1);
			await assert.rejects(() =>
				rig.config.work.kinds.get("durable-conversation").steer!(
					handle,
					"do not restart",
				),
			);
			const publicId = (await rig.harness.tree()).find(
				(node) => node.kind === "worker-durable",
			)!.id;
			await assert.rejects(() =>
				rig.harness.submit(
					publicId,
					"do not restart",
					"blocked",
					"followUp",
					"blocked",
				),
			);
			rig.faux.setResponses([
				fauxAssistantMessage("explicit restart accepted"),
			]);
			if (expected === "held") {
				const epoch = rig.processes.snapshot().holds[item.id].holdEpoch;
				await rig.harness.workRuntime!.release(item.id, epoch);
			} else if (expected === "paused") {
				resumeLocal("agent", true);
				await rig.harness.workRuntime!.resumePaused();
			} else await rig.harness.requestWork(item.id);
			await eventually(
				async () => (await rig.items())[0].attempts.length === 2,
			);
			await eventually(
				async () =>
					(await rig.harness.tree()).filter(
						(node) => node.kind === "worker-durable",
					).length === 2,
			);
		} finally {
			await rig.harness.close();
		}
	});

test("parallel tool reservations cannot exceed maxToolCalls and native model dispatch stops at maxTurns", async () => {
	const rig = await durableRig({ maxToolCalls: 1, maxTurns: 2 });
	rig.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: "one", text: "one" }),
				fauxToolCall("write", { path: "two", text: "two" }),
			],
			{ stopReason: "toolUse" },
		),
		call("write", { path: "three", text: "three" }),
	]);
	try {
		rig.harness.start();
		const { kind, handle, conversation } = await worker(rig);
		await eventually(
			async () => (await kind.result(handle)).outcome === "limit",
		);
		await eventually(
			async () =>
				(
					await conversation.entries(
						{ order: "ascending" },
						100,
						undefined,
						rig.harness.context,
					)
				).items.filter((entry) => entry.kind === "pi.tool-result").length === 2,
		);
		const written = ["one", "two", "three"].filter((name) =>
			existsSync(join(rig.checkout, name)),
		);
		assert.equal(written.length, 1);
		const entries = await conversation.entries(
			{ order: "ascending" },
			100,
			undefined,
			rig.harness.context,
		);
		assert.equal(
			entries.items.filter((entry) => entry.kind === "pi.assistant").length,
			1,
		);
		assert.ok(
			(await rig.harness.snapshot()).budget.tokens > 0,
			"worker usage is charged to the agent ledger",
		);
	} finally {
		await rig.harness.close();
	}
});

test("legacy loop-owned work items are rehomed to a native background boundary before durable launch", async () => {
	const rig = await durableRig();
	const workDoc = defineDoc<WorkState>({
		kind: "steward.work-items",
		version: 1,
		scope: "session",
		initial: emptyWorkState,
		checkpointWhen: () => true,
	});
	const ownersDoc = defineDoc<{ owners: Record<string, number> }>({
		kind: "steward.work-owners",
		version: 1,
		scope: "session",
		initial: () => ({ owners: {} }),
		checkpointWhen: () => true,
	});
	const legacy = defineTask<{ item: string }, { phase: "advance" }, null>({
		name: "steward.work-item",
		version: 1,
		initial: () => ({ phase: "advance" }),
		phases: {
			advance: async () => {
				throw Error("the registered production task must run instead");
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				ctx,
			);
		},
	});
	const intake = candidate();
	const id = workItemId(intake);
	try {
		const loop = (
			await rig.harness.native.inspect(rig.harness.context)
		).tasks.find((task) => task.record.kind === "steward-loop")!.record.id;
		await rig.harness.native.commit(async (tx) => {
			const state = await tx.doc(workDoc);
			state.work.items[id] = {
				id,
				intakeRef: intake.ref,
				repo: intake.repo,
				candidate: intake,
				attempts: [],
				prs: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			state.work.byIntakeRef[intake.ref] = id;
			state.tasks[id] = { itemId: id, phase: "claim" };
			(await tx.doc(ownersDoc)).owners[id] = await tx.createTask(
				legacy,
				{ item: id },
				{ ownership: { kind: "task", taskId: loop } },
			);
		}, rig.harness.context);
		rig.harness.start();
		await worker(rig);
		const graph = await rig.harness.native.taskGraph(rig.harness.context);
		const anchor = Object.values(graph.value.tasks).find(
			(task) => task.kind === "durable.run-worker",
		)!;
		assert.equal(graph.value.tasks[anchor.owner!].background, true);
		graph.dispose();
		assert.equal((await rig.items())[0].attempts.length, 1);
		assert.equal(
			(await rig.harness.tree()).filter(
				(node) => node.kind === "worker-durable",
			).length,
			1,
		);
	} finally {
		await rig.harness.close();
	}
});

test("SIGKILL of an idle native worker leaves no terminal outcome and restart reattaches its background owner", async () => {
	const child = fork(
		fileURLToPath(new URL("../fixtures/durable-idle.ts", import.meta.url)),
		{
			execArgv: ["--experimental-strip-types"],
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		},
	);
	let rig: Awaited<ReturnType<typeof durableRig>> | undefined;
	try {
		const [message] = (await once(child, "message", {
			signal: AbortSignal.timeout(10000),
		})) as [{ home: string; handle: WorkerHandle; conversationId: string }];
		const exit = once(child, "exit");
		child.kill("SIGKILL");
		assert.deepEqual(await exit, [null, "SIGKILL"]);
		rig = await durableRig({}, message.home);
		rig.harness.start();
		const kind = rig.config.work.kinds.get("durable-conversation");
		const handle = await kind.resume(message.handle);
		assert.equal(handle.process.handle, message.handle.process.handle);
		assert.equal((await kind.result(handle)).outcome, undefined);
		assert.equal((await rig.items())[0].attempts.length, 1);
		assert.equal(
			(await rig.harness.tree()).filter(
				(node) => node.kind === "worker-durable",
			).length,
			1,
		);
		assert.ok(
			(await rig.harness.tree()).some(
				(node) => node.id === message.conversationId,
			),
		);
	} finally {
		child.kill("SIGKILL");
		await rig?.harness.close();
	}
});

test("close during native bash writes no terminal outcome; reopen reattaches the single child and reports interrupted", async () => {
	const rig = await durableRig();
	rig.faux.setResponses([call("bash", { command: "sleep 30" })]);
	try {
		rig.harness.start();
		const { handle, kind } = await worker(rig);
		await eventually(() =>
			rig.processes.commands.some((args) => args.includes("sleep 30")),
		);
		assert.equal((await kind.result(handle)).outcome, undefined);
		const before = (await rig.harness.tree()).find(
			(node) => node.kind === "worker-durable",
		)!;
		await rig.restart();
		rig.harness.start();
		const restoredKind = rig.config.work.kinds.get("durable-conversation");
		assert.equal(
			(await restoredKind.resume(handle)).process.handle,
			handle.process.handle,
		);
		await eventually(async () =>
			(await rig.harness.transcript(before.id)).some(
				(entry) =>
					entry.kind === "pi.tool-result" &&
					JSON.stringify(entry).includes("interrupted"),
			),
		);
		assert.equal((await restoredKind.result(handle)).outcome, undefined);
		assert.equal(
			(await rig.harness.tree()).filter(
				(node) => node.kind === "worker-durable",
			).length,
			1,
		);
		assert.equal((await rig.items())[0].attempts.length, 1);
	} finally {
		await rig.harness.close();
	}
});
