import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApprovalNonces } from "../approval/nonce.ts";
import type { AgentDef } from "../config/schema.ts";
import type { WorkerDispatcher, Workspace } from "../dispatch/types.ts";
import { audit, readAudit } from "../steward/audit.ts";
import {
	isStartableConversationKind,
	startableConversationKinds,
} from "../steward/conversations.ts";
import type { StewardHarness } from "../steward/harness.ts";
import type { ProcessManager } from "../steward/procs.ts";
import type { WorkerRegistry } from "../workers/registry.ts";
import { type ApiEnv, auth } from "./auth.ts";
import { ApiError, bodyHash, validateMessage } from "./chat.ts";
import { events } from "./sse.ts";
import { tokenActive } from "./tokens.ts";
import type { Device, MessageRequest } from "./types.ts";

export function createApi(opts: {
	agent: string;
	machine: string;
	profile: string;
	harness: StewardHarness;
	definition: AgentDef;
	startedAt?: number;
	workers?: WorkerRegistry;
	processes?: ProcessManager;
	nonces?: ApprovalNonces;
	deliverNonce?: (item: string, code: string) => Promise<boolean>;
	dispatcher?: WorkerDispatcher;
	viewerWorkspace?: Workspace;
}) {
	const app = new Hono<ApiEnv>();
	const { harness } = opts;
	const startedAt = opts.startedAt ?? Date.now();
	const max = opts.definition.chat?.maxMessageBytes ?? 1048576;
	async function tree() {
		const durable = await harness.tree();
		const parentId =
			durable.find((node) => node.kind === "steward")?.id ?? null;
		const holds = opts.processes?.snapshot().holds ?? {};
		return [
			...durable,
			...(opts.workers ? await opts.workers.tree(parentId) : []),
		].map((node) =>
			node.item && holds[node.item]
				? {
						...node,
						status:
							holds[node.item].state === "held"
								? ("held" as const)
								: ("holding" as const),
					}
				: node,
		);
	}
	app.use("*", auth(opts.agent));
	app.use(
		"*",
		bodyLimit({
			maxSize: max * 6 + 4096,
			onError: (c) =>
				c.json(
					{
						error: { code: "invalid", message: "request exceeds byte ceiling" },
					},
					400,
				),
		}),
	);
	app.onError((error, c) => {
		const code =
			error instanceof ApiError
				? error.code
				: ((error as { code?: string }).code ??
					(error.name === "ConversationBusy" ? "busy" : "internal"));
		const status =
			error instanceof ApiError
				? error.status
				: code === "not_found"
					? 404
					: code === "conflict" || code === "busy"
						? 409
						: code === "unavailable"
							? 503
							: 500;
		if (status === 500) audit(opts.agent, { event: "api-error" });
		return c.json(
			{
				error: {
					code,
					message: status === 500 ? "internal error" : error.message,
				},
			},
			status as 400,
		);
	});
	app.notFound((c) =>
		c.json({ error: { code: "not_found", message: "route not found" } }, 404),
	);
	app.get("/healthz", (c) => c.json({ ok: true }));
	app.get("/v1/device", async (c) => {
		const device: Device = {
			apiVersion: "v1",
			durableVersion: "0.0.0",
			uid: (await harness.snapshot()).uid,
			machine: opts.machine,
			agent: opts.agent,
			profile: opts.profile,
			scopeSummary: c.get("actor").scopes,
			capabilities: {
				tree: true,
				startableKinds: Array.from(
					opts.definition.chat?.startableKinds ?? startableConversationKinds,
				),
			},
			startedAt,
		};
		return c.json(device);
	});
	app.get("/v1/sessions", async (c) => c.json(await tree()));
	app.get("/v1/conversations", async (c) => {
		const kind = c.req.query("kind");
		const item = c.req.query("item");
		if (kind && !startableConversationKinds.includes(kind as "chat" | "scout"))
			throw new ApiError("invalid", "kind must be chat or scout");
		const nodes = (await tree()).filter(
			(node) => (!kind || node.kind === kind) && (!item || node.item === item),
		);
		return c.json({ nodes });
	});
	app.post("/v1/conversations", async (c) => {
		let body: { kind?: unknown; item?: unknown; name?: unknown };
		try {
			body = await c.req.json();
		} catch {
			throw new ApiError("invalid", "JSON object required");
		}
		if (
			typeof body.kind !== "string" ||
			!isStartableConversationKind(
				body.kind,
				opts.definition.chat?.startableKinds,
			)
		)
			throw new ApiError("invalid", "conversation kind is not startable");
		if (body.item !== undefined && typeof body.item !== "string")
			throw new ApiError("invalid", "item must be a string");
		if (body.name !== undefined && typeof body.name !== "string")
			throw new ApiError("invalid", "name must be a string");
		const idempotency = c.req.header("idempotency-key");
		if (!idempotency || idempotency.length > 200)
			throw new ApiError("invalid", "Idempotency-Key required");
		const kind = body.kind as "chat" | "scout";
		const item = body.item as string | undefined;
		if (kind === "scout" && !item)
			throw new ApiError("invalid", "scout conversations require an item");
		const id = await harness.create(
			kind,
			idempotency,
			item,
			JSON.stringify(body),
		);
		audit(opts.agent, {
			event: "conversation-created",
			kind,
			conversationId: id,
			client: c.get("actor").client,
		});
		return c.json({ id, kind }, 201);
	});
	app.get("/v1/budget", async (c) => c.json((await harness.snapshot()).budget));
	app.get("/v1/queue", async (c) => c.json({ items: await harness.queue() }));
	app.get("/v1/workers", async (c) =>
		c.json({ workers: (await opts.workers?.list()) ?? [] }),
	);
	app.get("/v1/workers/events", (c) =>
		events(c, "workers", async () => ({
			nodes: opts.workers ? await opts.workers.tree(null) : [],
			workers: (await opts.workers?.list()) ?? [],
		})),
	);
	app.get("/v1/workers/:id/transcript", async (c) => {
		if (!opts.workers) throw new ApiError("not_found", "worker not found", 404);
		return c.json(await opts.workers.transcript(c.req.param("id")));
	});
	app.post("/v1/workers/:id/steer", async (c) => {
		if (!opts.workers) throw new ApiError("not_found", "worker not found", 404);
		const body = validateMessage(await c.req.json(), max);
		try {
			await opts.workers.steer(c.req.param("id"), body);
		} catch (error) {
			if ((error as { code?: string }).code === "not_supported")
				throw new ApiError("not_supported", "steer not supported", 501);
			throw error;
		}
		audit(opts.agent, {
			event: "worker-steer",
			actor: "human",
			client: c.get("actor").client,
			workerId: c.req.param("id"),
			bytes: Buffer.byteLength(body),
			sha256: bodyHash(body),
		});
		return c.json({ steered: true }, 202);
	});
	app.post("/v1/workers/:id/interrupt", async (c) => {
		if (!opts.workers) throw new ApiError("not_found", "worker not found", 404);
		const value = (await c.req.json()) as { mode?: unknown };
		if (value.mode !== "soft" && value.mode !== "hard")
			throw new ApiError("invalid", "mode must be soft or hard");
		if (harness.workRuntime)
			await harness.interruptWorker(c.req.param("id"), value.mode);
		else await opts.workers.interrupt(c.req.param("id"), value.mode);
		audit(opts.agent, {
			event: "worker-interrupt",
			actor: "human",
			client: c.get("actor").client,
			workerId: c.req.param("id"),
			mode: value.mode,
		});
		return c.json({ interrupted: true }, 202);
	});
	app.post("/v1/items/:id/retry", async (c) => {
		await harness.requestWork(c.req.param("id"));
		return c.json({ queued: true }, 202);
	});
	app.get("/v1/items", async (c) => c.json(await harness.workItems()));
	app.post("/v1/workers/stop", async (c) => {
		await harness.workRuntime?.stop("stopped");
		return c.json({ stopped: true });
	});
	async function requireItem(id: string) {
		const item = (await harness.workItems()).items[id];
		if (!item || !harness.workRuntime || !opts.processes)
			throw new ApiError("not_found", "work item not found", 404);
		return item;
	}
	app.get("/v1/items/:id/hold", async (c) => {
		await requireItem(c.req.param("id"));
		return c.json(
			opts.processes!.snapshot().holds[c.req.param("id")] ?? {
				state: "released",
			},
		);
	});
	app.post("/v1/items/:id/hold", async (c) => {
		const item = c.req.param("id");
		await requireItem(item);
		const actor = c.get("actor");
		// Fence is synchronously committed by hold() before this acknowledgement.
		void harness
			.workRuntime!.hold(item, actor.client, "api")
			.catch(() => audit(opts.agent, { event: "hold-failed", item }));
		return c.json({ state: opts.processes!.snapshot().holds[item].state }, 202);
	});
	app.post("/v1/items/:id/hold/verify", async (c) => {
		const item = await requireItem(c.req.param("id"));
		return c.json(
			await opts.processes!.verifyHold(
				item.id,
				item.attempts.at(-1)?.worker?.process.workspace.path,
			),
		);
	});
	app.post("/v1/items/:id/release/request", async (c) => {
		const item = c.req.param("id");
		await requireItem(item);
		const hold = opts.processes!.snapshot().holds[item];
		if (!hold || !opts.nonces || !opts.deliverNonce)
			throw new ApiError("invalid", "item has no releasable hold");
		const code = opts.nonces.issue("release", item, hold.holdEpoch);
		if (!(await opts.deliverNonce(item, code)))
			throw new ApiError(
				"unavailable",
				"configure a nonce-safe desktop or command approval channel",
				503,
			);
		return c.json({ requested: true }, 202);
	});
	app.post("/v1/items/:id/release", async (c) => {
		const item = c.req.param("id");
		await requireItem(item);
		let value: { code?: unknown } = {};
		try {
			value = (await c.req.json()) as { code?: unknown };
		} catch {
			/* Invalid bodies are treated as invalid credentials. */
		}
		const hold = opts.processes!.snapshot().holds[item];
		if (
			!hold ||
			hold.state !== "held" ||
			typeof value.code !== "string" ||
			value.code.length > 256 ||
			!opts.nonces?.verify("release", item, hold.holdEpoch, value.code)
		)
			throw new ApiError(
				"forbidden",
				"invalid or expired release credential",
				403,
			);
		await harness.releaseItem(item, hold.holdEpoch);
		return c.json({ released: true });
	});
	app.post("/v1/conversations/:id/open", async (c) => {
		const selected = await node(c.req.param("id"));
		const workspace =
			selected.source === "dispatcher" && opts.workers
				? (await opts.workers.get(selected.id)).handle.job.workspace
				: undefined;
		return c.json(
			harness.workRuntime
				? await harness.openConversation(selected.id, workspace)
				: opts.dispatcher && opts.viewerWorkspace
					? await opts.dispatcher.openViewer(opts.viewerWorkspace, {
							title: `durable:${opts.agent}/${selected.id}`,
							command: `durable attach ${opts.agent}/${selected.id}`,
						})
					: {
							kind: "command",
							command: `durable attach ${opts.agent}/${selected.id}`,
						},
		);
	});
	app.get("/v1/inbox", async (c) => c.json((await harness.snapshot()).inbox));
	app.post("/v1/inbox/:id/ack", async (c) => {
		if (!(await harness.ack(c.req.param("id"))))
			throw new ApiError("not_found", "inbox event not found", 404);
		return c.json({ acked: true });
	});
	app.get("/v1/audit", (c) => {
		const raw = c.req.query("since");
		const since = raw ? (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)) : 0;
		if (!Number.isFinite(since))
			throw new ApiError(
				"invalid",
				"since must be epoch milliseconds or an ISO date",
			);
		return c.json(readAudit(opts.agent, since));
	});
	app.post("/v1/pause", async (c) => {
		await harness.pause();
		return c.json({ paused: true });
	});
	async function node(id: string) {
		const found = (await tree()).find((candidate) => candidate.id === id);
		if (!found) throw new ApiError("not_found", "conversation not found", 404);
		return found;
	}
	async function mainId() {
		const steward = (await tree()).find((node) => node.kind === "steward");
		if (!steward)
			throw new ApiError(
				"unavailable",
				"steward conversation unavailable",
				503,
			);
		return steward.id;
	}
	async function snapshot(id: string | undefined, hash: string) {
		if (!tokenActive(opts.agent, hash))
			throw new ApiError(
				"unauthorized",
				"stream token expired or revoked",
				401,
			);
		const state = await harness.snapshot();
		return {
			nodes: await tree(),
			paused: state.paused,
			heartbeat: state.heartbeat,
			budget: state.budget,
			inbox: state.inbox,
			queue: await harness.queue(),
			...(id ? { entries: await harness.transcript(id) } : {}),
		};
	}
	app.get("/v1/events", (c) =>
		events(c, "steward", () => snapshot(undefined, c.get("actor").hash)),
	);
	app.get("/v1/tasks", async (c) =>
		c.json(
			(await harness.native.inspect(harness.context)).tasks.map(
				(task) => task.record,
			),
		),
	);
	for (const base of ["/v1/conversations", "/v1/sessions"]) {
		app.get(`${base}/:id`, async (c) => c.json(await node(c.req.param("id"))));
		app.get(`${base}/:id/tasks`, async (c) => {
			const id = c.req.param("id");
			await node(id);
			const key = Object.entries((await harness.snapshot()).conversations).find(
				([, meta]) => meta.id === id,
			)?.[0];
			return c.json(
				(await harness.native.inspect(harness.context)).tasks
					.filter((task) => String(task.record.conversationId) === key)
					.map((task) => task.record),
			);
		});
		app.get(`${base}/:id/transcript`, async (c) => {
			const id = c.req.param("id");
			const selected = await node(id);
			const format = c.req.query("format") ?? "json";
			if (!["json", "markdown"].includes(format))
				throw new ApiError("invalid", "format must be json or markdown");
			if (selected.source === "dispatcher") {
				if (!opts.workers)
					throw new ApiError("not_found", "worker not found", 404);
				const entries = await opts.workers.transcript(id);
				return format === "json" ? c.json(entries) : c.text(entries.join("\n"));
			}
			const entries = await harness.transcript(id);
			return format === "json"
				? c.json(entries)
				: c.text(
						entries
							.map(
								(entry) =>
									`## ${entry.kind}\n\n${JSON.stringify(entry.model ?? entry.data ?? "")}\n`,
							)
							.join("\n"),
					);
		});
		app.get(`${base}/:id/events`, async (c) => {
			const id = c.req.param("id");
			await node(id);
			return events(c, id, () => snapshot(id, c.get("actor").hash));
		});
		app.post(`${base}/:id/abort`, async (c) => {
			const id = c.req.param("id");
			const selected = await node(id);
			if (!selected.capabilities.interrupt)
				throw new ApiError("not_supported", "abort not supported", 501);
			if (selected.source === "dispatcher") {
				if (!opts.workers)
					throw new ApiError("not_found", "worker not found", 404);
				if (harness.workRuntime) await harness.interruptWorker(id, "soft");
				else await opts.workers.interrupt(id, "soft");
			} else await harness.abort(id);
			audit(opts.agent, {
				event: "abort-turn",
				actor: "human",
				client: c.get("actor").client,
				conversationId: id,
			});
			return c.json({ aborted: true }, 202);
		});
	}
	let admission = Promise.resolve();
	for (const path of [
		"/v1/messages",
		"/v1/conversations/:id/messages",
		"/v1/sessions/:id/messages",
	]) {
		app.post(path, async (c) => {
			let value: unknown;
			try {
				value = await c.req.json();
			} catch {
				throw new ApiError("invalid", "JSON object required");
			}
			const body = validateMessage(value, max);
			const input = value as MessageRequest;
			if (
				typeof input.requestId !== "string" ||
				!input.requestId.trim() ||
				input.requestId.length > 200 ||
				!["steer", "followUp", "reject"].includes(input.whenBusy)
			)
				throw new ApiError(
					"invalid",
					"requestId and whenBusy (steer|followUp|reject) required",
				);
			const id = c.req.param("id") ?? (await mainId());
			const selected = await node(id);
			if (!selected.capabilities.steer)
				throw new ApiError("not_supported", "messages not supported", 501);
			const actor = c.get("actor");
			const previous = admission;
			let release: () => void = () => {};
			admission = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				const key = `${id}:${input.requestId}`;
				if (!(await harness.snapshot()).requests[key]) {
					const retry = await harness.rate(actor.client);
					if (retry) {
						c.header("Retry-After", String(retry));
						throw new ApiError(
							"rate_limited",
							"opt-in chat limit reached",
							429,
						);
					}
				}
				audit(opts.agent, {
					event: "message",
					actor: "human",
					via: c.req.header("x-durable-via") === "console" ? "console" : "cli",
					client: actor.client,
					conversationId: id,
					bytes: Buffer.byteLength(body),
					sha256: bodyHash(body),
				});
				return c.json(
					await harness.submit(
						id,
						body,
						input.requestId,
						input.whenBusy,
						bodyHash(body),
					),
					202,
				);
			} finally {
				release();
			}
		});
	}
	app.get("/v1/transcript", async (c) =>
		c.json(await harness.transcript(await mainId())),
	);
	return app;
}
