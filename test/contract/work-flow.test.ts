import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApi } from "../../src/api/routes.ts";
import { createToken } from "../../src/api/tokens.ts";
import { ApprovalNonces } from "../../src/approval/nonce.ts";
import { readAudit } from "../../src/steward/audit.ts";
import { pauseFile, resumeLocal } from "../../src/steward/killswitch.ts";
import type { WorkItem } from "../../src/steward/workItems.ts";
import { WorkerRegistry } from "../../src/workers/registry.ts";
import { eventually, fixture, isolate } from "../support/harness.ts";
import { candidate, workDependencies } from "../support/work.ts";

async function setup(
	options: {
		report?: boolean;
		count?: number;
		maxAttempts?: number;
		itemMinutes?: number;
	} = {},
) {
	const home = isolate();
	const deps = workDependencies(home);
	deps.dispatcher.autoReport = options.report ?? false;
	let now = Date.now();
	const timers = new Set<{ at: number; callback: () => void }>();
	const notifications: string[] = [];
	const definition = {
		profile: "fixture",
		scope: { repos: [{ slug: "acme/repo" }] },
		sources: [{ kind: "github-issues" as const, repo: "acme/repo" }],
		schedule: { pollSeconds: 1 },
		limits: {
			maxConcurrentWorkers: 1,
			maxWorkersPerDay: 10,
			maxAttemptsPerItem: options.maxAttempts ?? 3,
			itemMinutes: options.itemMinutes ?? 60,
		},
		models: {
			steward: { provider: "faux", model: "one" },
			worker: { provider: "faux", model: "one" },
		},
	};
	const config = {
		definition,
		now: () => now,
		setTimer(callback: () => void, delay: number) {
			const timer = { at: now + delay, callback };
			timers.add(timer);
			return () => {
				timers.delete(timer);
			};
		},
		pollCandidates: async () =>
			Array.from({ length: options.count ?? 1 }, (_, index) =>
				candidate(index + 1),
			),
		work: {
			...deps,
			agent: "agent",
			login: "operator-login",
			definition,
			machine: { name: "fixture", agents: ["agent"] },
			env: {},
			checkoutFor: () => "fixture/repo",
			check: async () => {},
			notify: async (event: "escalation" | "budget-stop") => {
				notifications.push(event);
			},
			drainMs: 0,
			now: () => now,
		},
	};
	let { harness } = await fixture(config);
	const step = async (milliseconds = 1000) => {
		now += milliseconds;
		for (const timer of [...timers])
			if (timer.at <= now) {
				timers.delete(timer);
				timer.callback();
			}
		await new Promise((resolve) => setTimeout(resolve, 25));
	};
	const items = async () => Object.values((await harness.workItems()).items);
	return {
		home,
		deps,
		config,
		notifications,
		step,
		items,
		get harness() {
			return harness;
		},
		async restart() {
			await harness.close();
			deps.workers = new WorkerRegistry();
			config.work.workers = deps.workers;
			({ harness } = await fixture(config));
			harness.start();
		},
		now: () => now,
	};
}

test("steward queue -> claim -> read-only scout child -> fake Pi worker -> attributed draft PR survives restart", async () => {
	const rig = await setup({ report: true });
	try {
		rig.harness.start();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		await rig.step();
		await eventually(async () => (await rig.items())[0].prs.length === 1);
		const before = (await rig.items())[0];
		assert.equal(before.stage, "review");
		assert.equal(
			before.outcome,
			undefined,
			"a draft PR/handoff is not completion",
		);
		assert.equal(rig.deps.github.comments.length, 1);
		assert.equal(rig.deps.github.pulls[0].draft, true);
		assert.match(
			rig.deps.github.pulls[0].footer ?? "",
			/not yet reviewed by a human/,
		);
		const script = rig.deps.dispatcher.launches[0].command;
		assert.match(
			readFileSync(script, "utf8"),
			/--provider 'faux' --model 'one'/,
		);
		assert.match(
			readFileSync(script.replace("launch-worker.sh", "brief.md"), "utf8"),
			/idea-to-pr/,
		);
		assert.ok(
			(await rig.harness.tree()).some(
				(node) => node.kind === "scout" && node.item === before.id,
			),
		);
		assert.equal(
			readAudit("agent").filter((event) => event.event === "github-write")
				.length,
			rig.deps.github.writes.length,
		);
		assert.ok(
			readAudit("agent")
				.filter((event) => event.event === "github-write")
				.every(
					(event) =>
						event.profile === "fixture" && event.login === "operator-login",
				),
		);
		await rig.restart();
		await rig.step();
		await eventually(async () => (await rig.harness.snapshot()).ticks >= 3);
		assert.equal((await rig.items())[0].id, before.id);
		assert.equal(rig.deps.github.comments.length, 1);
		assert.equal(rig.deps.dispatcher.launches.length, 1);
		rig.deps.github.pulls[0].state = "merged";
		await rig.step();
		await eventually(async () => (await rig.items())[0].outcome === "merged");
	} finally {
		await rig.harness.close();
	}
});

test("cap+1 is refused; wall-clock limit is terminal and not resumed after restart", async () => {
	const rig = await setup({ count: 2, itemMinutes: 1 });
	try {
		rig.harness.start();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		assert.equal((await rig.items()).length, 2);
		await rig.step(61000);
		await eventually(async () =>
			(await rig.items()).some((item) => item.outcome === "limit"),
		);
		const limited = (await rig.items()).find(
			(item) => item.outcome === "limit",
		) as WorkItem;
		assert.equal(limited.attempts[0].cancelledBy, "limit");
		assert.ok(rig.notifications.includes("budget-stop"));
		await rig.restart();
		await rig.step();
		assert.equal(
			(await rig.items()).find((item) => item.id === limited.id)?.attempts
				.length,
			1,
		);
	} finally {
		await rig.harness.close();
	}
});

test("exited worker uses a counted --continue attempt, reaches escalation once, and never retries intentional cancellation", async () => {
	const rig = await setup({ maxAttempts: 2 });
	try {
		rig.harness.start();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		const first = (await rig.items())[0];
		await rig.deps.workers.interrupt(first.attempts[0].id, "hard");
		await rig.step();
		await eventually(() => rig.deps.dispatcher.launches.length === 2);
		assert.match(
			readFileSync(rig.deps.dispatcher.launches[1].command, "utf8"),
			/--continue --provider 'faux' --model 'one'/,
		);
		const retry = (await rig.items())[0].attempts.at(-1)!;
		await rig.deps.workers.interrupt(retry.id, "hard");
		await rig.step();
		await eventually(
			async () => (await rig.items())[0].outcome === "needs-human",
		);
		await rig.step();
		assert.equal(
			rig.deps.github.comments.filter((comment) =>
				comment.body.includes("durable-escalation"),
			).length,
			1,
		);
		assert.equal(
			rig.notifications.filter((event) => event === "escalation").length,
			1,
		);
	} finally {
		await rig.harness.close();
	}
});

test("disabled file stops running workers with paused outcome and survives restart without redispatch", async () => {
	const rig = await setup();
	try {
		rig.harness.start();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		pauseFile("agent");
		await rig.step();
		await eventually(async () => (await rig.items())[0].outcome === "paused");
		await rig.restart();
		await rig.step();
		assert.equal(rig.deps.dispatcher.launches.length, 1);
		assert.equal((await rig.items())[0].attempts[0].cancelledBy, "paused");
	} finally {
		await rig.harness.close();
	}
});

test("crash recovery with a fresh worker registry resumes once without another claim or workspace", async () => {
	const rig = await setup();
	try {
		rig.harness.start();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		await rig.deps.workers.interrupt(
			(await rig.items())[0].attempts[0].id,
			"hard",
		);
		await rig.restart();
		await rig.step();
		await eventually(() => rig.deps.dispatcher.launches.length === 2);
		assert.equal(rig.deps.github.comments.length, 1);
		assert.equal((await rig.deps.dispatcher.listWorkspaces()).length, 1);
		assert.equal((await rig.items())[0].attempts.length, 2);
		const tasks = (await rig.harness.native.inspect(rig.harness.context)).tasks;
		assert.equal(
			tasks.filter((task) => task.record.kind === "steward.work-item").length,
			1,
		);
	} finally {
		await rig.harness.close();
	}
});

test("quiet hours block only new dispatch, daily launch cap is enforced, and a TTY agent resume requeues paused work", async () => {
	const rig = await setup({ count: 2 });
	try {
		rig.config.definition.limits.maxWorkersPerDay = 1;
		Object.assign(rig.config.definition.schedule, {
			quietHours: "00:00-00:00 UTC",
		});
		rig.harness.start();
		await eventually(async () => (await rig.items()).length === 2);
		await rig.step();
		assert.equal(rig.deps.dispatcher.launches.length, 0);
		Object.assign(rig.config.definition.schedule, { quietHours: undefined });
		await rig.step();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		Object.assign(rig.config.definition.schedule, {
			quietHours: "00:00-00:00 UTC",
		});
		await rig.step();
		assert.equal(
			(await rig.items())[0].outcome,
			undefined,
			"quiet hours must not stop a running worker",
		);
		Object.assign(rig.config.definition.schedule, { quietHours: undefined });
		await rig.harness.pause();
		assert.equal((await rig.items())[0].outcome, "paused");
		await assert.rejects(async () => resumeLocal("agent", false), /TTY/);
		resumeLocal("agent", true);
		await rig.step();
		assert.equal(
			rig.deps.dispatcher.launches.length,
			1,
			"daily launch cap still applies after guarded resume",
		);
		await rig.step(86400000);
		await eventually(() => rig.deps.dispatcher.launches.length === 2);
		// Either eligible item may win the next slot; no queue-priority contract orders equal candidates.
		assert.equal(
			(await rig.items()).reduce(
				(count, item) => count + item.attempts.length,
				0,
			),
			2,
		);
		assert.equal(
			(await rig.items())[0].outcome,
			undefined,
			"guarded resume requeued paused work",
		);
	} finally {
		await rig.harness.close();
	}
});

test("worker-only stop keeps the agent ticking and soft/hard interruptions are never automatically retried", async () => {
	const rig = await setup();
	try {
		rig.harness.start();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		const worker = (await rig.items())[0].attempts[0].id;
		await rig.harness.interruptWorker(worker, "soft");
		assert.equal((await rig.items())[0].outcome, undefined);
		await rig.step();
		assert.equal(rig.deps.dispatcher.launches.length, 1);
		await rig.harness.requestWork((await rig.items())[0].id);
		await rig.step();
		await eventually(() => rig.deps.dispatcher.launches.length === 2);
		const token = createToken("agent", "stop", ["pause"]);
		const app = createApi({
			agent: "agent",
			machine: "fixture",
			profile: "fixture",
			definition: rig.config.definition,
			harness: rig.harness,
			workers: rig.deps.workers,
		});
		assert.equal(
			(
				await app.request("/v1/workers/stop", {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
			200,
		);
		assert.equal(
			(await rig.items())[0].attempts.at(-1)?.cancelledBy,
			"stopped",
		);
		const ticks = (await rig.harness.snapshot()).ticks;
		await rig.step();
		assert.ok((await rig.harness.snapshot()).ticks > ticks);
		await rig.restart();
		await rig.step();
		assert.equal(rig.deps.dispatcher.launches.length, 2);
	} finally {
		await rig.harness.close();
	}
});

test("hold API is pause-scoped, fences immediately, survives restart, and release is nonce-only and epoch-bound", async () => {
	const rig = await setup();
	try {
		rig.harness.start();
		await eventually(() => rig.deps.dispatcher.launches.length === 1);
		const item = (await rig.items())[0].id;
		const pause = createToken("agent", "pauser", ["pause", "read"]);
		const read = createToken("agent", "reader", ["read"]);
		let delivered = "";
		const nonces = new ApprovalNonces("agent", rig.now);
		const app = () =>
			createApi({
				agent: "agent",
				machine: "fixture",
				profile: "fixture",
				harness: rig.harness,
				definition: rig.config.definition,
				workers: rig.deps.workers,
				processes: rig.deps.processes,
				nonces,
				deliverNonce: async (_item, code) => {
					delivered = code;
					return true;
				},
			});
		const post = (path: string, token?: string, body = {}) =>
			app().request(`/v1/items/${item}/${path}`, {
				method: "POST",
				headers: {
					...(token ? { authorization: `Bearer ${token}` } : {}),
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		assert.equal((await post("hold", read)).status, 403);
		assert.equal((await post("hold", pause)).status, 202);
		assert.equal(rig.deps.processes.fenced(item), true);
		await eventually(
			() => rig.deps.processes.snapshot().holds[item].state === "held",
		);
		await rig.restart();
		await rig.step();
		assert.equal(rig.deps.dispatcher.launches.length, 1);
		assert.equal((await post("release/request", pause)).status, 202);
		assert.ok(delivered);
		for (const scopes of [
			["read"],
			["chat"],
			["pause"],
			["read", "chat", "pause"],
		] as const) {
			const token = createToken("agent", `scopes-${scopes.join("-")}`, [
				...scopes,
			]);
			assert.equal(
				(await post("release", token, { code: delivered })).status,
				403,
			);
		}
		assert.equal(
			(
				await post("release", undefined, {
					code: nonces.issue("release", "another", 1),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await post("release", undefined, {
					code: nonces.issue("approve", item, 1),
				})
			).status,
			403,
		);
		assert.equal(
			(await post("release", undefined, { code: delivered })).status,
			200,
		);
		assert.equal(
			(await post("release", undefined, { code: delivered })).status,
			403,
		);
		await rig.step();
		await eventually(() => rig.deps.dispatcher.launches.length === 2);
		assert.equal((await rig.items())[0].attempts.length, 2);
		assert.equal(JSON.stringify(readAudit("agent")).includes(delivered), false);
	} finally {
		await rig.harness.close();
	}
});
