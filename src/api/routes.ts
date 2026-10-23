import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AgentDef } from "../config/schema.ts";
import { audit, readAudit } from "../steward/audit.ts";
import type { StewardHarness } from "../steward/harness.ts";
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
}) {
	const app = new Hono<ApiEnv>();
	const { harness } = opts;
	const startedAt = opts.startedAt ?? Date.now();
	const max = opts.definition.chat?.maxMessageBytes ?? 1048576;
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
			capabilities: { tree: true, startableKinds: [] },
			startedAt,
		};
		return c.json(device);
	});
	app.get("/v1/sessions", async (c) => c.json(await harness.tree()));
	app.get("/v1/conversations", async (c) =>
		c.json({ nodes: await harness.tree() }),
	);
	app.get("/v1/budget", async (c) => c.json((await harness.snapshot()).budget));
	app.get("/v1/queue", async (c) => c.json({ items: await harness.queue() }));
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
		const found = (await harness.tree()).find(
			(candidate) => candidate.id === id,
		);
		if (!found) throw new ApiError("not_found", "conversation not found", 404);
		return found;
	}
	async function mainId() {
		return (await harness.tree()).find((n) => n.kind === "steward")!.id;
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
			nodes: await harness.tree(),
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
			await node(id);
			const format = c.req.query("format") ?? "json";
			if (!["json", "markdown"].includes(format))
				throw new ApiError("invalid", "format must be json or markdown");
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
			await harness.abort(id);
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
