import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.DURABLE_HOME = mkdtempSync(join(tmpdir(), "durable-state-"));

import { validateMessage } from "../../src/api/chat.ts";
import { authorize, createToken } from "../../src/api/tokens.ts";
import { unitText } from "../../src/platform/service/systemdUser.ts";
import { addMessage, openState, saveState } from "../../src/steward/state.ts";

test("tokens are hashed and enforce scopes", () => {
	const token = createToken("a", "test", ["read"]);
	assert.ok(authorize("a", token, "read"));
	assert.equal(authorize("a", token, "chat"), undefined);
	const durableHome = process.env.DURABLE_HOME;
	assert.ok(durableHome);
	const raw = readFileSync(join(durableHome, "agents/a/tokens.json"), "utf8");
	assert.equal(raw.includes(token), false);
});
test("chat screening and ceiling", () => {
	assert.equal(validateMessage({ body: "hello", requestId: "x" }), "hello");
	assert.throws(() =>
		validateMessage({
			body: ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
			requestId: "x",
		}),
	);
	assert.throws(() =>
		validateMessage({ body: "x".repeat(1048577), requestId: "x" }),
	);
});
test("state survives reopen and message ids persist", () => {
	const s = openState("a");
	const m = addMessage(s, "steward", "hi");
	saveState("a", s);
	assert.equal(openState("a").messages[0].id, m.id);
});
test("unit contains control group kill mode", () =>
	assert.match(unitText(), /KillMode=control-group/));
