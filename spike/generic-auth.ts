// Spike (throwaway): generic provider reuse through one profile file, inside a pi-durable Harness.
// Run in a temp dir; <profileCopy> is a COPY of a Pi auth file. The store is wrapped read-only so an
// OAuth refresh (which runs inside modify()) can never rotate a refresh token shared with live sessions.
//   node generic-auth.ts <profileCopy> <db>
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [profile, db] = process.argv.slice(2);
const { AuthStorage } = await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js")).href);
const inner = AuthStorage.create(profile);
const readOnly = {
  read: (id: string, o?: any) => inner.read(id, o),
  list: (o?: any) => inner.list(o),
  modify: async (id: string) => { throw new Error(`spike guard: modify(${id}) refused (would refresh/rotate)`); },
  delete: async (id: string) => { throw new Error(`spike guard: delete(${id}) refused`); },
};

async function ask(label: string, models: any, model: { provider: string; modelId: string }) {
  const harness = await Harness.open(await openNodeSqliteStorage(db), { models, registry: createRegistry(), onReport: (e: any, i: any) => console.log("REPORT", i?.type, String(e?.message ?? e).slice(0, 300)) } as any, ctx);
  const conv = await harness.root(ctx, { agent: { model } });
  console.log("opened+root", label); const t0 = Date.now();
  const sub = await conv.submit({ type: "input", content: "Reply with exactly: ok", requestId: `${label}-${Date.now()}` }, ctx);
  console.log("submitted", sub.id); const s: any = await sub.wait(ctx);
  const ans: any = s.status === "done" ? await conv.commit((tx: any) => tx.entry(AssistantEntry, s.answer), ctx) : undefined;
  const text = (ans?.model ?? []).flatMap((m: any) => m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  console.log(JSON.stringify({ label, provider: model.provider, model: model.modelId, status: s.status, reason: s.reason, error: s.answer?.errorMessage?.slice(0, 200), text: text?.slice(0, 40), ms: Date.now() - t0 }));
  await harness.close(ctx);
}

// A: plain pi-ai Models with the profile store (what D2 describes, minus the removed AuthStorage export)
const models = createModels({ credentials: readOnly as any });
models.setProvider(openaiCodexProvider());
models.setProvider(openrouterProvider());
await ask("codex-oauth", models, { provider: "openai-codex", modelId: "gpt-5.6-luna" });
await ask("openrouter", models, { provider: "openrouter", modelId: "~openai/gpt-mini-latest" });

// B: the public pi-coding-agent path: ModelRuntime (implements pi-ai Models) over the same store
const runtime = await ModelRuntime.create({ credentials: readOnly as any, modelsPath: null, refreshOnCreate: false });
console.log("ModelRuntime providers:", runtime.getProviders().length, "checkAuth(openrouter):", JSON.stringify(await runtime.checkAuth("openrouter")).slice(0, 120));
await ask("runtime-openrouter", runtime, { provider: "openrouter", modelId: "~openai/gpt-mini-latest" });
console.log("END"); setTimeout(() => { console.log("still alive after 3s: handles", (process as any)._getActiveHandles().map((h: any) => h.constructor.name).join(",")); process.exit(0); }, 3000).unref?.();
