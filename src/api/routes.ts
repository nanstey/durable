import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import type { ApprovalNonces } from "../approval/nonce.ts";
import type { ApprovalAction, ApprovalWebAuthn } from "../approval/webauthn.ts";
import { verifyNonce } from "../gate/approval.ts";
import type { AgentDef } from "../config/schema.ts";
import {
	bundleFor,
	materializeOrganization,
	organizationVersionState,
	receiveOrganizationBundle,
	type OrganizationBundle,
} from "../config/organizations.ts";
import type { WorkerDispatcher, Workspace } from "../dispatch/types.ts";
import { collectMetrics } from "../metrics/collect.ts";
import { groupOutcomes } from "../improve/group.ts";
import { audit, readAudit } from "../steward/audit.ts";
import { agentDir } from "../steward/files.ts";
import { resumeApproved } from "../steward/killswitch.ts";
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
import { peerAllowed, type PeerCheck } from "./net.ts";
import type { Device, MessageRequest } from "./types.ts";

export function createApi(opts: {
	agent: string;
	machine: string;
	profile: string;
	organization?: { id: string; bundleHash: string };
	harness: StewardHarness;
	definition: AgentDef;
	startedAt?: number;
	workers?: WorkerRegistry;
	processes?: ProcessManager;
	nonces?: ApprovalNonces;
	webauthn?: ApprovalWebAuthn;
	deliverNonce?: (item: string, code: string) => Promise<boolean>;
	notifyPasskey?: (action: ApprovalAction, item: string) => Promise<void>;
	dispatcher?: WorkerDispatcher;
	viewerWorkspace?: Workspace;
	peerCheck?: { mode: PeerCheck; allowedPeers: string[] };
}) {
	const app = new Hono<ApiEnv>();
	const { harness } = opts;
	const startedAt = opts.startedAt ?? Date.now();
	const approvalRequestAt = new Map<string, number>();
	const passkeyChallengeRequests = new Map<
		string,
		{ count: number; since: number }
	>();
	const approvalRequestWindowMs = 60_000;
	if (opts.peerCheck && opts.peerCheck.mode !== "off")
		app.use("*", async (c, next) => {
			if (c.req.path === "/healthz") return next();
			const address = getConnInfo(c).remote.address ?? "";
			try {
				if (!(await peerAllowed(address, opts.peerCheck?.allowedPeers ?? []))) {
					audit(opts.agent, { event: "peer-check-denied" });
					return c.json(
						{ error: { code: "forbidden", message: "tailnet peer refused" } },
						403,
					);
				}
			} catch {
				if (opts.peerCheck?.mode === "required")
					return c.json(
						{
							error: {
								code: "unavailable",
								message: "tailnet peer check unavailable",
							},
						},
						503,
					);
				audit(opts.agent, { event: "peer-check-unavailable" });
			}
			return next();
		});
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
						: code === "rate_limited"
							? 429
							: code === "unavailable"
								? 503
								: code === "not-enrolled" || code === "not_supported"
									? 501
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
			organization: {
				...(opts.organization ?? { id: "default", bundleHash: "default" }),
				versionState: organizationVersionState(
					opts.organization?.id ?? "default",
				),
			},
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
	app.get("/v1/organizations/:name/bundle", (c) => {
		const name = c.req.param("name");
		if ((opts.organization?.id ?? "default") !== name)
			throw new ApiError("not_found", "organization not found", 404);
		return c.json(bundleFor(name));
	});
	app.post("/v1/organizations/:name/bundle", async (c) => {
		const name = c.req.param("name");
		if ((opts.organization?.id ?? "default") !== name)
			throw new ApiError("not_found", "organization not found", 404);
		let bundle: OrganizationBundle;
		try {
			bundle = (await c.req.json()) as OrganizationBundle;
			if (bundle.approval?.organization !== name)
				throw Error("organization name mismatch");
			receiveOrganizationBundle(bundle);
			materializeOrganization(opts.agent, opts.definition);
		} catch {
			throw new ApiError(
				"invalid",
				"invalid approved organization bundle",
				400,
			);
		}
		audit(opts.agent, {
			event: "organization-bundle-received",
			organization: name,
			bundleHash: bundle.contentHash,
		});
		return c.json({
			organization: name,
			bundleHash: bundle.contentHash,
			versionState: organizationVersionState(name),
		});
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
	app.get("/v1/metrics", async (c) => {
		const now = Date.now();
		const maximumRange = 90 * 24 * 60 * 60 * 1000;
		const parseTime = (value: string | undefined, fallback: number) => {
			if (!value) return fallback;
			const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
			if (!Number.isFinite(parsed))
				throw new ApiError(
					"invalid",
					"since and until must be dates or epoch milliseconds",
				);
			return parsed;
		};
		const until = parseTime(c.req.query("until"), now);
		const since = parseTime(
			c.req.query("since"),
			until - 30 * 24 * 60 * 60 * 1000,
		);
		if (since > until || until - since > maximumRange)
			throw new ApiError(
				"invalid",
				"metrics range must be ordered and at most 90 days",
			);
		const organization = opts.organization?.id ?? "default";
		if (
			c.req.query("organization") &&
			c.req.query("organization") !== organization
		)
			throw new ApiError("not_found", "organization not found", 404);
		return c.json(
			collectMetrics(await harness.workItems(), readAudit(opts.agent, since), {
				agent: opts.agent,
				organization,
				since,
				until,
				repo: c.req.query("repo"),
			}),
		);
	});
	app.get("/v1/improvements", async (c) => {
		const now = Date.now();
		const since = now - 30 * 24 * 60 * 60 * 1000;
		const work = await harness.workItems();
		const metrics = collectMetrics(work, readAudit(opts.agent, since), {
			agent: opts.agent,
			organization: opts.organization?.id ?? "default",
			since,
			until: now,
			repo: c.req.query("repo"),
		});
		const enabled = new Map(
			(opts.definition.scope?.repos ?? []).map((repo) => [
				repo.slug,
				repo.pipeline?.improve ?? { enabled: false },
			]),
		);
		return c.json({
			patterns: groupOutcomes(work, metrics).map((pattern) => ({
				...pattern,
				optIn: enabled.get(pattern.repo) ?? { enabled: false },
			})),
		});
	});
	app.get("/v1/gate/report", async (c) => {
		const reports = Object.values((await harness.workItems()).items).flatMap(
			(item) => {
				const gate = item.gate;
				return gate?.report
					? [
							{
								item: item.id,
								repo: item.repo,
								pr: gate.pr,
								report: gate.report,
							},
						]
					: [];
			},
		);
		return c.json({ reports });
	});
	app.get("/v1/gate/:item", async (c) => {
		const item = (await harness.workItems()).items[c.req.param("item")];
		if (!item?.gate) throw new ApiError("not_found", "gate not found", 404);
		return c.json(item.gate);
	});
	app.post("/v1/gate/:item/approve/request", async (c) => {
		const item = (await harness.workItems()).items[c.req.param("item")];
		const last = approvalRequestAt.get(c.req.param("item"));
		if (last !== undefined && Date.now() - last < approvalRequestWindowMs)
			throw new ApiError(
				"rate_limited",
				"approval request already sent recently",
				429,
			);
		if (
			!item?.gate ||
			item.gate.state !== "waiting-approval" ||
			!opts.nonces ||
			!opts.deliverNonce
		)
			throw new ApiError("invalid", "item has no active approval task", 400);
		const code = opts.nonces.issue("approve", item.id, item.gate.sha);
		if (!(await opts.deliverNonce(item.id, code)))
			throw new ApiError(
				"unavailable",
				"configure a nonce-safe desktop or command approval channel",
				503,
			);
		approvalRequestAt.set(item.id, Date.now());
		audit(opts.agent, {
			event: "approval-nonce-requested",
			item: item.id,
			sha: item.gate.sha,
			actor: c.get("actor").client,
		});
		return c.json({ requested: true }, 202);
	});
	app.post("/v1/approvals/nonce", async (c) => {
		let value: { item?: unknown; code?: unknown; action?: unknown } = {};
		try {
			value = (await c.req.json()) as {
				item?: unknown;
				code?: unknown;
				action?: unknown;
			};
		} catch {
			/* Treated as an invalid credential below. */
		}
		const item =
			typeof value.item === "string"
				? (await harness.workItems()).items[value.item]
				: undefined;
		const spec = value.action === "approve-spec";
		const binding =
			spec && item?.spec
				? {
						action: "approve-spec" as const,
						item: item.id,
						pr: item.spec.pr,
						sha: item.spec.sha,
					}
				: item?.gate
					? { action: "approve" as const, item: item.id, sha: item.gate.sha }
					: undefined;
		if (
			!binding ||
			typeof value.code !== "string" ||
			value.code.length > 256 ||
			!opts.nonces ||
			!verifyNonce(opts.nonces, binding, value.code)
		)
			throw new ApiError(
				"forbidden",
				"invalid or expired approval credential",
				403,
			);
		if (!harness.workRuntime)
			throw new ApiError("unavailable", "work runtime unavailable", 503);
		if (!item)
			throw new ApiError("forbidden", "invalid approval credential", 403);
		if (spec) {
			if (!item.spec)
				throw new ApiError("forbidden", "invalid approval credential", 403);
			await harness.workRuntime.approveSpec(
				item.id,
				item.spec.pr,
				item.spec.sha,
			);
		} else {
			if (!item.gate)
				throw new ApiError("forbidden", "invalid approval credential", 403);
			await harness.workRuntime.approveGate(item.id, item.gate.sha);
		}
		audit(opts.agent, {
			event: spec ? "spec-approval-nonce" : "approval-nonce",
			item: item.id,
			sha: binding.sha,
		});
		return c.json({ approved: true });
	});
	async function passkeyBinding(action: ApprovalAction, item: string) {
		if (action === "enroll") return { item: opts.agent, binding: "enroll" };
		if (action === "resume") {
			if (!existsSync(join(agentDir(opts.agent), "disabled")))
				throw new ApiError("invalid", "agent is not paused", 400);
			return { item: opts.agent, binding: "resume" };
		}
		if (action === "approve") {
			const work = (await harness.workItems()).items[item];
			if (!work?.gate || work.gate.state !== "waiting-approval")
				throw new ApiError("invalid", "item has no active approval task", 400);
			return { item: work.id, binding: work.gate.sha };
		}
		if (action === "release") {
			const hold = opts.processes?.snapshot().holds[item];
			if (!hold || hold.state !== "held")
				throw new ApiError("invalid", "item has no releasable hold", 400);
			return { item, binding: hold.holdEpoch };
		}
		if (!harness.workRuntime)
			throw new ApiError("unavailable", "work runtime unavailable", 503);
		try {
			const policy = await harness.workRuntime.policyVerification(item);
			return {
				item,
				binding: policy.fingerprint,
				change: policy.change,
			};
		} catch (error) {
			const code = (error as { code?: string }).code;
			throw new ApiError(
				code === "not_found" ? "not_found" : "unavailable",
				error instanceof Error ? error.message : "policy source unavailable",
				code === "not_found" ? 404 : 503,
			);
		}
	}
	app.post("/v1/approvals/challenge", async (c) => {
		if (!opts.webauthn)
			throw new ApiError("not-enrolled", "passkeys are not configured", 501);
		const value = (await c.req.json()) as {
			action?: unknown;
			item?: unknown;
			enrollmentCode?: unknown;
		};
		if (
			!(
				["approve", "resume", "enroll", "verify-policy", "release"] as string[]
			).includes(String(value.action)) ||
			typeof value.item !== "string"
		)
			throw new ApiError("invalid", "action and item are required", 400);
		const address = getConnInfo(c).remote.address ?? "unknown";
		const now = Date.now();
		const attempts = passkeyChallengeRequests.get(address);
		const window =
			attempts && now - attempts.since < approvalRequestWindowMs
				? attempts
				: { count: 0, since: now };
		if (++window.count > 10)
			throw new ApiError("rate_limited", "too many passkey challenges", 429);
		passkeyChallengeRequests.set(address, window);
		const action = value.action as ApprovalAction;
		let target: Awaited<ReturnType<typeof passkeyBinding>>;
		try {
			target = await passkeyBinding(action, value.item);
			const issued = await opts.webauthn.options(
				action,
				target.item,
				target.binding,
				typeof value.enrollmentCode === "string"
					? value.enrollmentCode
					: undefined,
			);
			return c.json({
				challengeId: issued.id,
				kind: issued.kind,
				publicKey: issued.options,
				action,
				item: target.item,
				binding: target.binding,
				...(action === "verify-policy" ? { change: target.change } : {}),
			});
		} catch (error) {
			audit(opts.agent, { event: "passkey-refused", action, item: value.item });
			throw error;
		}
	});
	app.post("/v1/approvals/assert", async (c) => {
		if (!opts.webauthn)
			throw new ApiError("not-enrolled", "passkeys are not configured", 501);
		const value = (await c.req.json()) as {
			action?: unknown;
			item?: unknown;
			challengeId?: unknown;
			kind?: unknown;
			response?: never;
		};
		if (
			!(
				["approve", "resume", "enroll", "verify-policy", "release"] as string[]
			).includes(String(value.action)) ||
			typeof value.item !== "string" ||
			typeof value.challengeId !== "string" ||
			!value.response
		)
			throw new ApiError(
				"invalid",
				"action, item, challengeId and response are required",
				400,
			);
		const action = value.action as ApprovalAction;
		const target = await passkeyBinding(action, value.item);
		try {
			if (action === "enroll") {
				if (value.kind === "assertion") {
					const issued = await opts.webauthn.verifyEnrollmentAssertion(
						value.challengeId,
						value.response as never,
					);
					return c.json({
						approved: false,
						challengeId: issued.id,
						kind: issued.kind,
						publicKey: issued.options,
						action,
						item: target.item,
					});
				}
				if (value.kind !== "registration")
					throw new ApiError(
						"invalid",
						"enrollment response kind is required",
						400,
					);
				await opts.webauthn.verifyEnrollment(
					value.challengeId,
					value.response as never,
				);
			} else
				await opts.webauthn.verifyAssertion(
					value.challengeId,
					action,
					target.item,
					target.binding,
					value.response as never,
				);
		} catch (error) {
			audit(opts.agent, {
				event: "passkey-refused",
				action,
				item: target.item,
			});
			throw error;
		}
		if (action === "approve")
			await harness.workRuntime?.approveGate(
				target.item,
				String(target.binding),
			);
		if (action === "release")
			await harness.releaseItem(target.item, Number(target.binding));
		if (action === "resume") resumeApproved(opts.agent, "passkey");
		if (action === "verify-policy")
			try {
				await harness.workRuntime?.verifyPolicy(
					target.item,
					String(target.binding),
				);
			} catch (error) {
				audit(opts.agent, {
					event: "passkey-refused",
					action,
					item: target.item,
				});
				throw error;
			}
		audit(opts.agent, {
			event: action === "enroll" ? "passkey-enrolled" : "passkey-approved",
			action,
			item: target.item,
			binding: target.binding,
		});
		try {
			await opts.notifyPasskey?.(action, target.item);
		} catch {
			audit(opts.agent, { event: "notify-failed", action, item: target.item });
		}
		return c.json({ approved: true });
	});
	app.post("/v1/resume", () => {
		throw new ApiError("forbidden", "resume requires a passkey assertion", 403);
	});
	app.post("/v1/policy/:repo/verify", () => {
		throw new ApiError(
			"forbidden",
			"policy verification requires a passkey assertion",
			403,
		);
	});
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
