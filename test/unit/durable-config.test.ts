import assert from "node:assert/strict";
import test from "node:test";
import { validateAgent } from "../../src/config/schema.ts";

test("durable item budgets are accepted as positive configuration limits", () => {
	const definition = validateAgent({
		profile: "fixture",
		limits: { maxTurns: 10, maxToolCalls: 20, tokenBudget: 1000 },
	});
	assert.deepEqual(definition.limits, {
		maxTurns: 10,
		maxToolCalls: 20,
		tokenBudget: 1000,
	});
	for (const name of ["maxTurns", "maxToolCalls", "tokenBudget"])
		assert.throws(() =>
			validateAgent({ profile: "fixture", limits: { [name]: -1 } }),
		);
});
