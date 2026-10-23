import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectReview, type RunningReview } from "../../src/gate/review.ts";
import { FakeDispatcher } from "../../src/dispatch/fake.ts";
import type { WorkerHandle, WorkerKind } from "../../src/workers/kind.ts";
import { WorkerRegistry } from "../../src/workers/registry.ts";

const definition = {
	profile: "review",
	models: {
		worker: { provider: "openai", model: "gpt" },
		reviewer: { provider: "anthropic", model: "claude" },
	},
} as const;

function running(
	kind: RunningReview["kind"],
	outputFile: string,
): RunningReview {
	return {
		id: `review-${kind}`,
		agent: "agent",
		item: "item",
		repo: "acme/api",
		baseRef: "main",
		headSha: "head",
		producer: definition.models.worker,
		workspace: { id: "workspace", repo: "acme/api", branch: "review" },
		briefText: "Review.",
		outputFile,
		env: {},
		limits: {},
		kind,
	};
}

function reviewer(
	kind: RunningReview["kind"],
	result: WorkerKind["result"],
	lines: string[],
): WorkerKind {
	return {
		name: kind,
		async start() {
			throw Error("not used");
		},
		async status() {
			return "exited";
		},
		result,
		async interrupt() {},
		async *transcript() {
			yield* lines;
		},
		async resume(handle) {
			return handle;
		},
		describe(handle) {
			return {
				id: handle.id,
				item: handle.job.item,
				workspace: handle.job.workspace.path,
				startedAt: handle.startedAt,
			};
		},
		capabilities() {
			return {
				attach: "read",
				steer: false,
				transcript: true,
				interrupt: true,
				resumeAfterCrash: false,
				skills: "full",
				extensions: false,
				anthropicOAuth: "extension",
				headless: true,
				processIsolated: true,
				tokenInShell: false,
				viewable: "terminal",
			};
		},
	};
}

for (const kind of ["pi-session", "durable-conversation"] as const)
	test(`records kind-neutral reviewer provenance for ${kind}`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "durable-review-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const output = join(root, "result.json");
		writeFileSync(
			output,
			JSON.stringify({
				verdict: "approve",
				risk: "low",
				summary: "Looks good.",
				headSha: "head",
			}),
		);
		const active = running(kind, output);
		const result = {
			status: "exited",
			...(kind === "durable-conversation"
				? {
						review: {
							verdict: "approve" as const,
							risk: "low" as const,
							summary: "Looks good.",
							headSha: "head",
						},
					}
				: {}),
		};
		const registry = new WorkerRegistry();
		const fake = new FakeDispatcher();
		const workspace = await fake.createWorkspace(active.workspace);
		const handle: WorkerHandle = {
			id: active.id,
			job: {
				...active,
				workspace,
				role: "reviewer",
				model: definition.models.reviewer,
			},
			process: { id: active.id, handle: active.id, workspace },
			startedAt: 1,
		};
		registry.register(
			reviewer(kind, async () => result, [
				JSON.stringify({
					role: "assistant",
					provider: "anthropic",
					model: "claude",
				}),
			]),
			handle,
		);
		const stored = await collectReview(active, registry, definition);
		assert.equal(
			stored.provenance.source,
			kind === "pi-session" ? "pi-session-log" : "durable-entries",
		);
		assert.equal(stored.provenance.entries, 1);
	});

test("refuses a same-family fallback assistant entry", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-review-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const active = running("pi-session", join(root, "result.json"));
	writeFileSync(
		active.outputFile,
		JSON.stringify({
			verdict: "approve",
			risk: "low",
			summary: "OK",
			headSha: "head",
		}),
	);
	const registry = new WorkerRegistry();
	const fake = new FakeDispatcher();
	const workspace = await fake.createWorkspace(active.workspace);
	const handle: WorkerHandle = {
		id: active.id,
		job: {
			...active,
			workspace,
			role: "reviewer",
			model: definition.models.reviewer,
		},
		process: { id: active.id, handle: active.id, workspace },
		startedAt: 1,
	};
	registry.register(
		reviewer("pi-session", async () => ({ status: "exited" }), [
			JSON.stringify({ role: "assistant", provider: "openai", model: "gpt" }),
		]),
		handle,
	);
	await assert.rejects(
		() => collectReview(active, registry, definition),
		/not an independent/,
	);
});
