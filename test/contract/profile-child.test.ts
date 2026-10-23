import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModelsFor } from "../../src/identity/modelAuth.ts";
import { openHarness } from "../../src/steward/harness.ts";
import { queueInbox } from "../../src/steward/inbox.ts";
import { eventually, isolate } from "../support/harness.ts";

test("owned child inherits selected profile runtime and records provider/model provenance", async () => {
	const home = isolate();
	const dir = join(home, "copied-profile");
	mkdirSync(dir);
	const authFile = join(dir, "profile.json");
	const original = JSON.stringify({
		faux: { type: "api_key", key: "fabricated-only-for-offline-test" },
	});
	writeFileSync(authFile, original, { mode: 0o600 });
	const models = await createModelsFor(
		{
			name: "fixture",
			authFile,
			secretsFile: join(dir, "missing.env"),
			manifestFile: join(dir, "missing.json"),
			isDefault: false,
		},
		["faux"],
	);
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "profile-model" }],
	});
	models.registerNativeProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage("profile child answered")]);
	queueInbox("profile", "identity-failure");
	const harness = await openHarness({
		agent: "profile",
		definition: {
			profile: "fixture",
			models: { steward: { provider: "faux", model: "profile-model" } },
		},
		models,
		storage: "sqlite",
	});
	try {
		const id = await harness.create("scout");
		await harness.submit(id, "answer", "profile-request", "followUp", "hash");
		await eventually(async () =>
			(await harness.transcript(id)).some(
				(entry) => entry.kind === "pi.assistant",
			),
		);
		const entry = (await harness.transcript(id)).find(
			(item) => item.kind === "pi.assistant",
		)!;
		assert.ok(JSON.stringify(entry.model).includes('"provider":"faux"'));
		assert.ok(JSON.stringify(entry.model).includes('"model":"profile-model"'));
		assert.equal(readFileSync(authFile, "utf8"), original);
		assert.equal((await harness.snapshot()).inbox[0].type, "identity-failure");
	} finally {
		await harness.close();
	}
});
