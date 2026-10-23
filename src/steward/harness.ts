import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type Cursor,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	GenerationTask,
	Harness,
	hook,
	type JsonObject,
	type SetTimer,
	section,
	type TaskId,
	ToolTask,
	type Tx,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import { providerFor } from "../config/agent.ts";
import { eligibility } from "../sources/eligibility.ts";
import { GitHubIssuesSource } from "../sources/githubIssues.ts";
import { GitHubPrsSource } from "../sources/githubPrs.ts";
import { LocalFilesSource } from "../sources/localFiles.ts";
import type { Candidate, Source } from "../sources/types.ts";
import { ranked, type Queue, updateQueue } from "./queue.ts";
import type { AgentDef } from "../config/schema.ts";
import { createModelsFor } from "../identity/modelAuth.ts";
import { buildAgentEnv } from "../identity/env.ts";
import { loadManifest } from "../config/manifest.ts";
import { resolveProfile } from "../identity/profiles.ts";
import { buildTree } from "../tree/build.ts";
import type { IndexedConversation, NodeKind } from "../tree/nodes.ts";
import { audit } from "./audit.ts";
import { agentDir } from "./files.ts";
import {
	acknowledge,
	drainInbox,
	type InboxEvent,
	inboxEvent,
} from "./inbox.ts";
import { disabled, pauseFile } from "./killswitch.ts";
import { type Budget, exhausted } from "./limits.ts";
import { tick } from "./loop.ts";
import type { ProcessManager } from "./procs.ts";

type State = {
	uid: string;
	heartbeat: number;
	ticks: number;
	paused: boolean;
	budget: Budget;
	inbox: InboxEvent[];
	chat: Record<
		string,
		{ minute: number; day: number; minuteCount: number; dayCount: number }
	>;
	conversations: Record<
		string,
		{
			id: string;
			kind: NodeKind;
			startedAt: number;
			item?: string;
			turnAborted?: boolean;
		}
	>;
	requests: Record<string, { hash: string; id: number | string }>;
};
function document<T extends JsonObject>(kind: string, initial: () => T) {
	return defineDoc<T>({
		kind,
		version: 1,
		scope: "session",
		initial,
		checkpointWhen: () => true,
	});
}
const StateDoc = document<Omit<State, "budget" | "inbox" | "chat">>(
	"steward.state",
	() => ({
		uid: randomUUID(),
		heartbeat: 0,
		ticks: 0,
		paused: false,
		conversations: {},
		requests: {},
	}),
);
const BudgetDoc = document<Budget>("steward.budget", () => ({
	day: "",
	spent: 0,
	tokens: 0,
	stopped: false,
}));
const InboxDocument = document<{ events: InboxEvent[] }>(
	"steward.inbox",
	() => ({ events: [] }),
);
const ChatDoc = document<{ counters: State["chat"] }>("steward.chat", () => ({
	counters: {},
}));
const QueueDoc = document<Queue>("steward.queue", () => ({ items: {} }));
export type HarnessConfig = {
	agent: string;
	definition: AgentDef;
	storage: "sqlite" | "jsonl";
	models?: Models;
	now?: () => number;
	setTimer?: SetTimer;
	processes?: ProcessManager;
	/** Fixture seam for read-only scout polling. */
	pollCandidates?: () => Promise<Candidate[]>;
	checkoutFor?: (repo: string) => string | undefined;
	/** Test/probe extensions are never loaded from configuration or untrusted chat. */
	extensions?: Extension[];
};

async function indexedChildren(tx: Tx, ownerTaskId: TaskId) {
	const ids = new Set<number>();
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanConversations({ ownerTaskId }, 200, cursor);
		for (const conversation of page.items) ids.add(conversation.id);
		cursor = page.next;
	} while (cursor);
	return ids;
}

export async function openHarness(options: HarnessConfig) {
	const { agent, definition: def, processes } = options;
	const now = options.now ?? Date.now;
	const scoutSources: Source[] = [];
	if (!options.pollCandidates) {
		const configuredSources = def.sources ?? [];
		const profile = configuredSources.some((source) =>
			["github-issues", "github-prs"].includes(source.kind),
		)
			? resolveProfile(def.profile)
			: undefined;
		const scoutEnv = profile
			? buildAgentEnv(profile, "steward", { agent })
			: undefined;
		for (const source of configuredSources) {
			if (source.kind === "github-issues")
				scoutSources.push(
					new GitHubIssuesSource({
						...source,
						env: scoutEnv,
						onRateLimit: (remaining) =>
							audit(agent, { event: "github-rate-limit", remaining }),
					}),
				);
			if (source.kind === "github-prs" && profile)
				scoutSources.push(
					new GitHubPrsSource({
						repo: source.repo,
						login: loadManifest(profile.manifestFile).github.login,
						agentId: agent,
						env: scoutEnv,
					}),
				);
			const checkout = options.checkoutFor?.(source.repo) ?? source.checkout;
			if (source.kind === "local-files" && source.glob && checkout)
				scoutSources.push(
					new LocalFilesSource({
						repo: source.repo,
						checkout,
						pattern: source.glob,
						statusField: source.statusField,
						readyValue: source.readyValue,
					}),
				);
		}
	}
	const pollCandidates =
		options.pollCandidates ??
		(async () =>
			(await Promise.all(scoutSources.map((source) => source.poll()))).flat());
	const limits = { dailyDollars: 10, dailyTokens: 1000000, ...def.limits };
	const isDisabled = () => disabled(agent, def.schedule?.quietHours, now());
	let harness: Harness;
	async function queue() {
		return ranked((await harness.snapshot(QueueDoc, context))!);
	}
	const tools = [
		defineTool({
			name: "list_queue",
			description: "List the current work queue without source bodies.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => ({
				output: [{ type: "text", text: JSON.stringify(await queue()) }],
			}),
		}),
		defineTool({
			name: "explain_item",
			description:
				"Return code-owned stored reasons for a queue item, never its body.",
			parameters: Type.Object({ ref: Type.String() }),
			replay: "safe",
			execute: async ({ ref }) => ({
				output: [
					{
						type: "text",
						text: JSON.stringify(
							(await queue()).find((item) => item.ref === ref)
								? {
										ref,
										reasons: (await queue()).find((item) => item.ref === ref)!
											.reasons,
									}
								: null,
						),
					},
				],
			}),
		}),
		defineTool({
			name: "explain_item",
			description: "Explain a queue item without changing it.",
			parameters: Type.Object({ item: Type.String() }),
			replay: "safe",
			execute: async ({ item }) => ({
				output: [
					{ type: "text", text: JSON.stringify({ item, state: "unknown" }) },
				],
			}),
		}),
		defineTool({
			name: "status",
			description: "Read steward status and budget.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => ({
				output: [
					{
						type: "text",
						text: JSON.stringify(await snapshot()),
					},
				],
			}),
		}),
		defineTool({
			name: "set_priority",
			description:
				"Request a queue priority change; eligibility remains enforced.",
			parameters: Type.Object({
				item: Type.String(),
				priority: Type.Integer({ minimum: 0, maximum: 100 }),
			}),
			execute: async ({ item, priority }) => ({
				output: [
					{
						type: "text",
						text: JSON.stringify({ queued: "set_priority", item, priority }),
					},
				],
			}),
		}),
		defineTool({
			name: "request_merge",
			description: "Enqueue a merge request for gate evaluation.",
			parameters: Type.Object({ target: Type.String() }),
			execute: async ({ target }) => ({
				output: [
					{
						type: "text",
						text: JSON.stringify({ queued: "request_merge", target }),
					},
				],
			}),
		}),
		defineTool({
			name: "request_work",
			description:
				"Enqueue a work request for policy and eligibility evaluation.",
			parameters: Type.Object({ item: Type.String() }),
			execute: async ({ item }) => ({
				output: [
					{
						type: "text",
						text: JSON.stringify({ queued: "request_work", item }),
					},
				],
			}),
		}),
		defineTool({
			name: "pause",
			description:
				"Pause this agent. Only a human at a local terminal can resume it.",
			parameters: Type.Object({}),
			execute: async () => {
				pauseFile(agent);
				await processes?.terminate();
				return {
					output: [{ type: "text", text: "paused" }],
					control: { terminate: true },
				};
			},
		}),
	];
	const Safety = defineExtension({
		name: "steward.safety",
		tools,
		sections: [
			section(
				"steward",
				() =>
					"You are the read-only Durable steward. Never ask for or accept credentials. You may list the queue, read status, or pause. You cannot approve, resume, run shell commands, or write to GitHub.",
			),
		],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (_call, api, ctx) => {
					const state = (await api.snapshot(StateDoc, ctx))!;
					const item = state.conversations[String(api.conversationId)]?.item;
					if (
						isDisabled() ||
						exhausted((await api.snapshot(BudgetDoc, ctx))!, limits) ||
						processes?.fenced(item)
					)
						return { block: "paused, budget exhausted, or item fenced" };
				},
			}),
			hook(GenerationTask, {
				beforeRequest: async (_request, api, ctx) => {
					const state = (await api.snapshot(StateDoc, ctx))!;
					budgetBlocked =
						exhausted((await api.snapshot(BudgetDoc, ctx))!, limits) ||
						Boolean(
							processes?.fenced(
								state.conversations[String(api.conversationId)]?.item,
							),
						);
					if (isDisabled() || budgetBlocked)
						throw Error("model request refused by safety fence");
				},
				afterResponse: async (message) => {
					await harness.commit(async (tx) => {
						const budget = await tx.doc(BudgetDoc);
						budget.spent += message.usage.cost.total;
						budget.tokens += message.usage.totalTokens;
					}, context);
				},
			}),
		],
	});
	const Loop = defineTask<null, { phase: "tick" }, null>({
		name: "steward-loop",
		version: 1,
		initial: () => ({ phase: "tick" }),
		phases: {
			tick: async (_task, runtime, ctx) => {
				let event = "tick";
				let nextAt = now() + (def.schedule?.pollSeconds ?? 30) * 1000;
				let candidates: Candidate[] = [];
				try {
					if (!isDisabled()) {
						const polled = await pollCandidates();
						const counts = new Map<string, number>();
						candidates = polled.filter((candidate) => {
							const source = def.sources?.find(
								(entry) => entry.repo === candidate.repo,
							);
							const count = counts.get(candidate.repo) ?? 0;
							counts.set(candidate.repo, count + 1);
							return count < (source?.maxItems ?? Number.POSITIVE_INFINITY);
						});
					}
				} catch {
					audit(agent, { event: "scout-poll-failed" });
				}
				await runtime.commit(async (tx) => {
					const metadata = await tx.doc(StateDoc);
					const budget = await tx.doc(BudgetDoc);
					const state = { ...metadata, budget };
					const wasPaused = state.paused;
					const result = tick(state, {
						now: now(),
						disabled: isDisabled(),
						pollSeconds: def.schedule?.pollSeconds ?? 30,
						limits,
					});
					event = result.event;
					nextAt = result.again.nextAt;
					metadata.heartbeat = state.heartbeat;
					metadata.ticks = state.ticks;
					metadata.paused = state.paused;
					Object.assign(budget, state.budget);
					if (!state.paused) {
						const entries = candidates.flatMap((candidate) => {
							const source = def.sources?.find(
								(entry) => entry.repo === candidate.repo,
							);
							const result = eligibility(
								candidate,
								{
									trustedAuthors: source?.trustedAuthors,
									requiredLabels: source?.requiredLabels ?? source?.labels,
									excludedLabels: source?.exclude,
									maxAttempts:
										source?.maxAttempts ?? def.limits?.maxAttemptsPerItem,
									maxSize: source?.maxSize,
									maxAgeMs: source?.maxAgeMs,
								},
								now(),
							);
							return [
								{
									candidate,
									state: result.eligible
										? ("eligible" as const)
										: ("skipped" as const),
									reasons: result.reasons,
								},
							];
						});
						updateQueue(await tx.doc(QueueDoc), entries, now(), 30 * 86400000);
					}
					if (state.paused && !wasPaused)
						(await tx.doc(InboxDocument)).events.push(
							inboxEvent(agent, event, "", now()),
						);
					return {
						status: "sleeping",
						until: nextAt,
						checkpoint: { phase: "tick" },
					};
				}, ctx);
				audit(agent, {
					event,
					candidates: candidates.length,
					eligible: candidates.filter(
						(candidate) =>
							eligibility(
								candidate,
								{
									trustedAuthors: def.sources?.find(
										(source) => source.repo === candidate.repo,
									)?.trustedAuthors,
								},
								now(),
							).eligible,
					).length,
				});
				if (event !== "tick") await processes?.terminate();
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				ctx,
			);
		},
	});
	const registry = createRegistry();
	registry.install(Safety);
	const Anchor = defineTask<null, { phase: "wait" }, null>({
		name: "steward.conversation-anchor",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (_task, runtime, ctx) => {
				await runtime.commit(
					() => ({
						status: "sleeping",
						until: now() + 86400000,
						checkpoint: { phase: "wait" },
					}),
					ctx,
				);
			},
		},
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				ctx,
			);
		},
	});
	registry.install(
		defineExtension({ name: "steward.loop", tasks: [Loop, Anchor] }),
	);
	for (const extension of options.extensions ?? []) registry.install(extension);
	const model = def.models?.steward;
	if (!model && !options.models) throw Error("models.steward required");
	const baseModels =
		options.models ??
		(await createModelsFor(
			resolveProfile(def.profile),
			Object.values(def.models ?? {})
				.filter((m) => m !== "auto")
				.map(providerFor),
		));
	const storage =
		options.storage === "sqlite"
			? await openNodeSqliteStorage(join(agentDir(agent), "state.sqlite"))
			: await openNodeJsonlStorage(
					join(agentDir(agent), "state.jsonl"),
					context,
				);
	// Upstream treats beforeRequest exceptions as advisory; enforce safety at dispatch too.
	let budgetBlocked = false;
	const models = new Proxy(baseModels, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (
				[
					"stream",
					"streamSimple",
					"streamDeferred",
					"fetchDeferred",
					"complete",
					"completeSimple",
				].includes(String(property))
			)
				return (...args: unknown[]) => {
					if (isDisabled() || budgetBlocked)
						throw Error("model request disabled by safety policy");
					return value.apply(target, args);
				};
			return value.bind(target);
		},
	});
	harness = await Harness.open(
		storage,
		{
			models,
			registry,
			now,
			setTimer: options.setTimer,
			conversationCreated: async (tx, conversation) => {
				const state = await tx.doc(StateDoc);
				state.conversations[String(conversation.id)] = {
					id: randomUUID(),
					kind: "subagent",
					startedAt: now(),
				};
			},
			onReport: (_error, info) =>
				audit(agent, { event: "harness-error", type: info.type }),
		},
		context,
	);
	const configuredModel = model
		? {
				provider: providerFor(model),
				modelId: model.provider
					? model.model
					: model.model.split("/").slice(1).join("/"),
			}
		: undefined;
	const thinkingLevel = model?.thinking as ModelThinkingLevel | undefined;
	const root = await harness.root(context, {
		agent: {
			...(configuredModel ? { model: configuredModel } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			extensions: [Safety, ...(options.extensions ?? [])],
			tools,
		},
	});
	const currentAgent = await root.agent(context);
	if (
		configuredModel &&
		(currentAgent.model?.provider !== configuredModel.provider ||
			currentAgent.model.modelId !== configuredModel.modelId ||
			(thinkingLevel && currentAgent.thinkingLevel !== thinkingLevel))
	) {
		// root options apply only at creation; definition changes use an explicit durable configure.
		await root.configure(
			{ model: configuredModel, ...(thinkingLevel ? { thinkingLevel } : {}) },
			context,
		);
	}
	// root has a reserved numeric ID; do not rely on its value in the public API.
	await root.commit(async (tx) => {
		const state = await tx.doc(StateDoc);
		state.conversations[String(root.id)].kind = "steward";
		await tx.doc(BudgetDoc);
		await tx.doc(InboxDocument);
		await tx.doc(ChatDoc);
		await tx.doc(QueueDoc);
		let cursor: Cursor | undefined;
		let liveLoop = false;
		do {
			const page = await tx.scanTasks(
				{ kind: "steward-loop", conversationId: root.id },
				100,
				cursor,
			);
			liveLoop = page.items.some((task) => task.state.status !== "terminal");
			cursor = page.next;
		} while (cursor && !liveLoop);
		if (!liveLoop)
			await tx.createTask(Loop, null, {
				ownership: { kind: "conversation" },
				background: true,
			});
	}, context);

	await drainInbox(agent, async (events) => {
		await harness.commit(async (tx) => {
			const inbox = (await tx.doc(InboxDocument)).events;
			for (const event of events)
				if (!inbox.some((existing) => existing.id === event.id))
					inbox.push(event);
		}, context);
	});

	async function snapshot(): Promise<State> {
		const [metadata, budget, inbox, chat] = await Promise.all([
			harness.snapshot(StateDoc, context),
			harness.snapshot(BudgetDoc, context),
			harness.snapshot(InboxDocument, context),
			harness.snapshot(ChatDoc, context),
		]);
		if (!metadata || !budget || !inbox || !chat)
			throw Error("steward documents missing");
		return { ...metadata, budget, inbox: inbox.events, chat: chat.counters };
	}
	async function resolveId(id: string) {
		const state = await snapshot();
		const entry = Object.entries(state.conversations).find(
			([, meta]) => meta.id === id,
		);
		if (!entry)
			throw Object.assign(Error("conversation not found"), {
				code: "not_found",
			});
		return Number(entry[0]) as ConversationId;
	}
	async function tree() {
		const state = await snapshot();
		const graph = await harness.taskGraph(context);
		try {
			const indexed = await harness.commit(async (tx) => {
				const conversations: IndexedConversation[] = [];
				const childrenByTask = new Map<number, Set<number>>();
				let cursor: Cursor | undefined;
				do {
					const page = await tx.scanConversations({}, 200, cursor);
					for (const record of page.items) {
						const meta = state.conversations[String(record.id)];
						if (!meta) continue;
						let ownerTask: number | undefined;
						let ownerConversation: number | undefined;
						if (record.owner) {
							ownerTask = record.owner.taskId;
							// Use the paginated ownership index once per task, including terminal owners.
							let children = childrenByTask.get(ownerTask);
							if (!children) {
								children = await indexedChildren(tx, record.owner.taskId);
								childrenByTask.set(ownerTask, children);
							}
							if (!children.has(record.id))
								throw Error("ownership index inconsistent");
							ownerConversation = record.owner.conversationId;
						}
						conversations.push({
							key: record.id,
							...meta,
							ownerTask,
							ownerConversation,
						});
					}
					cursor = page.next;
				} while (cursor);
				return conversations;
			}, context);
			return buildTree(
				indexed,
				Object.values(graph.value.tasks).map((task) => ({
					key: task.id,
					conversation: task.conversationId,
					status: task.state.status,
					kind: task.kind,
					owner: task.owner,
				})),
				processes?.snapshot().holds,
			);
		} finally {
			graph.dispose();
		}
	}
	return {
		native: harness,
		root,
		context,
		snapshot,
		tree,
		start: () => harness.resume(),
		close: () => harness.close(context),
		async transcript(id: string) {
			const conversation = await harness.conversation(
				await resolveId(id),
				context,
			);
			if (!conversation) throw Error("conversation missing");
			const entries = [];
			let cursor: Cursor | undefined;
			do {
				const page = await conversation.entries(
					{ order: "ascending" },
					200,
					cursor,
					context,
				);
				entries.push(...page.items);
				cursor = page.next;
			} while (cursor);
			return entries;
		},
		async submit(
			id: string,
			body: string,
			requestId: string,
			whenBusy: "steer" | "followUp" | "reject",
			hash: string,
		) {
			const conversationId = await resolveId(id);
			const state = await snapshot();
			if (
				isDisabled() ||
				exhausted(state.budget, limits) ||
				processes?.fenced(state.conversations[String(conversationId)]?.item)
			)
				throw Object.assign(
					Error("agent unavailable: paused, budget exhausted, or fenced"),
					{ code: "unavailable" },
				);
			const key = `${id}:${requestId}`;
			await harness.commit(async (tx) => {
				const document = await tx.doc(StateDoc);
				const requests = document.requests;
				document.conversations[String(conversationId)].turnAborted = false;
				if (requests[key] && requests[key].hash !== hash)
					throw Object.assign(
						Error("requestId reused with different content"),
						{ code: "conflict" },
					);
				requests[key] ??= { hash, id: 0 };
			}, context);
			const conversation = await harness.conversation(conversationId, context);
			const submission = await conversation!.submit(
				{ type: "input", content: body, requestId, whenBusy },
				context,
			);
			await harness.commit(async (tx) => {
				(await tx.doc(StateDoc)).requests[key] = { hash, id: submission.id };
			}, context);
			return { id: String(submission.id) };
		},
		async abort(id: string) {
			const key = await resolveId(id);
			await (await harness.conversation(key, context))!.abort(context);
			await harness.commit(async (tx) => {
				(await tx.doc(StateDoc)).conversations[String(key)].turnAborted = true;
			}, context);
		},
		async pause() {
			pauseFile(agent);
			await harness.commit(async (tx) => {
				const state = await tx.doc(StateDoc);
				state.paused = true;
				(await tx.doc(InboxDocument)).events.push(
					inboxEvent(agent, "paused", "", now()),
				);
			}, context);
			await processes?.terminate();
			// Abort model/tool work, but not the background loop; never end a worker anchor via the tree abort route.
			for (const task of (await harness.inspect(context)).tasks)
				if (task.record.kind === "pi.generation")
					await harness.abortTask(task.record.id, context);
			audit(agent, { event: "paused" });
		},
		queue,
		async ack(id: string) {
			return harness.commit(
				async (tx) => acknowledge((await tx.doc(InboxDocument)).events, id),
				context,
			);
		},
		async rate(client: string) {
			if (!def.chat?.rateLimit) return 0;
			return harness.commit(async (tx) => {
				const state = await tx.doc(ChatDoc);
				const minute = Math.floor(now() / 60000),
					day = Math.floor(now() / 86400000);
				const count = state.counters[client] ?? {
					minute,
					day,
					minuteCount: 0,
					dayCount: 0,
				};
				if (count.minute !== minute) {
					count.minute = minute;
					count.minuteCount = 0;
				}
				if (count.day !== day) {
					count.day = day;
					count.dayCount = 0;
				}
				const config = def.chat?.rateLimit;
				const perMinute = Number(config?.perMinute ?? Infinity),
					perDay = Number(config?.perDay ?? Infinity);
				if (count.minuteCount >= perMinute)
					return 60 - (Math.floor(now() / 1000) % 60);
				if (count.dayCount >= perDay)
					return 86400 - (Math.floor(now() / 1000) % 86400);
				count.minuteCount++;
				count.dayCount++;
				state.counters[client] = count;
				return 0;
			}, context);
		},
		async create(
			kind: "chat" | "scout",
			idempotencyKey?: string,
			item?: string,
			idempotencyHash = kind,
		) {
			const requestKey = idempotencyKey
				? `conversation:${idempotencyKey}`
				: undefined;
			const existing = requestKey
				? (await snapshot()).requests[requestKey]
				: undefined;
			if (existing) {
				if (existing.hash !== idempotencyHash)
					throw Object.assign(
						Error("Idempotency-Key reused with different kind"),
						{
							code: "conflict",
						},
					);
				return String(existing.id);
			}
			const conversation = await harness.commit(async (tx) => {
				const anchor = await tx.createTask(Anchor, null, {
					conversationId: root.id,
					ownership: { kind: "conversation" },
					background: true,
				});
				return tx.createConversation({
					ownership: { kind: "task", taskId: anchor },
				});
			}, context);
			await harness.commit(async (tx) => {
				const metadata = (await tx.doc(StateDoc)).conversations[
					String(conversation.id)
				];
				metadata.kind = kind;
				metadata.item = item;
			}, context);
			const id = (await snapshot()).conversations[String(conversation.id)].id;
			if (requestKey)
				await harness.commit(async (tx) => {
					(await tx.doc(StateDoc)).requests[requestKey] = {
						hash: idempotencyHash,
						id,
					};
				}, context);
			return id;
		},
		async addInbox(type: string, target = "") {
			await harness.commit(async (tx) => {
				(await tx.doc(InboxDocument)).events.push(
					inboxEvent(agent, type, target, now()),
				);
			}, context);
		},
	};
}
export type StewardHarness = Awaited<ReturnType<typeof openHarness>>;
