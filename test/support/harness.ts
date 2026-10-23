import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { type HarnessConfig, openHarness } from "../../src/steward/harness.ts";

export function isolate() {
	const home = mkdtempSync(join(tmpdir(), "durable-test-"));
	process.env.DURABLE_HOME = home;
	delete process.env.DURABLE_DISABLED;
	return home;
}
export function fauxModels() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	faux.setResponses(
		Array.from({ length: 1000 }, () => fauxAssistantMessage("okay")),
	);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, faux };
}
export async function fixture(options: Partial<HarnessConfig> = {}) {
	const { models, faux } = fauxModels();
	const harness = await openHarness({
		agent: "agent",
		definition: {
			profile: "fixture",
			models: { steward: { provider: "faux", model: "one" } },
		},
		storage: "sqlite",
		models,
		...options,
	});
	return { harness, faux, models };
}
export async function eventually(
	check: () => boolean | Promise<boolean>,
	timeout = 5000,
) {
	const end = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() > end) throw Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
