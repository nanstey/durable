import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

test("reopening keeps the stored conversation model until configure changes it", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-conversation-model-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const models = createModels();
	models.setProvider(
		fauxProvider({
			provider: "faux",
			models: [{ id: "first" }, { id: "second" }],
		}).provider,
	);
	const registry = createRegistry();
	const db = join(root, "state.sqlite");
	let harness = await Harness.open(
		await openNodeSqliteStorage(db),
		{ models, registry },
		context,
	);
	let conversation = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "first" } },
	});
	assert.equal((await conversation.agent(context)).model?.modelId, "first");
	await harness.close(context);
	harness = await Harness.open(
		await openNodeSqliteStorage(db),
		{ models, registry },
		context,
	);
	t.after(() => harness.close(context));
	conversation = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "second" } },
	});
	assert.equal((await conversation.agent(context)).model?.modelId, "first");
	await conversation.configure(
		{ model: { provider: "faux", modelId: "second" } },
		context,
	);
	assert.equal((await conversation.agent(context)).model?.modelId, "second");
});
