// Spike (throwaway): Anthropic OAuth option 1 (host the transport) WITHOUT contacting Anthropic.
// A fabricated "sk-ant-oat" token and a loopback stub stand in for the API. Compares the request the
// steward's pi-durable Harness emits with the plain anthropic provider vs the shaped (wrapped) one.
// Needs @gotgenes/pi-anthropic-auth@3.4.2 in node_modules (loaded with jiti, which pi-coding-agent ships).
import http from "node:http";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
	createRegistry,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { createJiti } from "jiti";

const seen: any[] = [];
const sse = (e: string, d: object) =>
	`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		seen.push({
			url: req.url,
			headers: req.headers,
			body: JSON.parse(body || "{}"),
		});
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(
			sse("message_start", {
				type: "message_start",
				message: {
					id: "msg_stub",
					type: "message",
					role: "assistant",
					model: "stub",
					content: [],
					stop_reason: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}) +
				sse("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}) +
				sse("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "ok" },
				}) +
				sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
				sse("message_delta", {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 1 },
				}) +
				sse("message_stop", { type: "message_stop" }),
		);
	});
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const jiti = createJiti(import.meta.url);
const { createAnthropicOAuthStreamSimple } = await jiti.import<any>(
	"@gotgenes/pi-anthropic-auth/src/oauth-transport.ts",
);
const { resolveBuiltinAnthropicStreamSimple } = await jiti.import<any>(
	"@gotgenes/pi-anthropic-auth/src/host-transport.ts",
);

const FAKE = {
	anthropic: {
		type: "oauth",
		access: ["sk-ant-oat01", "FAKE-not-a-secret"].join("-"),
		refresh: "FAKE-refresh",
		expires: Date.now() + 864e5,
	},
};
const store = {
	read: async (id: string) => (FAKE as any)[id],
	list: async () => [{ providerId: "anthropic", type: "oauth" }],
	modify: async () => {
		throw new Error("guard: no refresh");
	},
	delete: async () => {},
};

function stubbed(p: any, streamSimple?: any) {
	return {
		...p,
		id: p.id,
		name: p.name,
		auth: p.auth,
		stream: p.stream.bind(p),
		getModels: () => p.getModels().map((m: any) => ({ ...m, baseUrl: base })),
		streamSimple: streamSimple ?? p.streamSimple.bind(p),
	};
}
async function run(label: string, provider: any) {
	const models = createModels({ credentials: store as any });
	models.setProvider(provider);
	const modelId = models.getModels("anthropic")[0].id;
	const h = await Harness.open(
		new MemoryStorage(),
		{ models, registry: createRegistry() },
		ctx,
	);
	const root = await h.root(ctx, {
		agent: { model: { provider: "anthropic", modelId } },
	});
	const s: any = await (
		await root.submit({ type: "input", content: "Reply with exactly: ok" }, ctx)
	).wait(ctx);
	const r = seen.at(-1);
	const sys = JSON.stringify(r?.body?.system ?? "");
	console.log(
		JSON.stringify({
			label,
			status: s.status,
			modelId,
			authHeader: String(
				r?.headers?.authorization ?? r?.headers?.["x-api-key"] ?? "",
			).replace(FAKE.anthropic.access, "<fake-oat>"),
			anthropicBeta: r?.headers?.["anthropic-beta"],
			userAgent: r?.headers?.["user-agent"],
			xApp: r?.headers?.["x-app"],
			systemHasBillingHeader: /x-anthropic-billing-header/i.test(sys),
			systemHasClaudeCodeIdentity: /Claude Code/.test(sys),
			systemPreview: sys.replace(/cch=[0-9a-f]+/g, "cch=<hash>").slice(0, 220),
		}),
	);
	await h.close(ctx);
}
const plain = anthropicProvider();
await run("plain-anthropic-provider", stubbed(plain));
const delegate = await resolveBuiltinAnthropicStreamSimple();
await run(
	"shaped-provider-override",
	stubbed(plain, createAnthropicOAuthStreamSimple(delegate)),
);
server.close();
process.exit(0);
