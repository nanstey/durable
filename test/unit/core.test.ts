import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { effectiveKind } from "../../src/identity/doctor.ts";
import { buildAgentEnv } from "../../src/identity/env.ts";
import { resolveProfile } from "../../src/identity/profiles.ts";

test("durable shell excludes secrets", (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-"));
	const previous = process.env.DURABLE_HOME;
	process.env.DURABLE_HOME = join(root, "state");
	t.after(() => {
		if (previous === undefined) delete process.env.DURABLE_HOME;
		else process.env.DURABLE_HOME = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const p = resolveProfile("work", root);
	mkdirSync(join(root, "secrets"), { recursive: true });
	writeFileSync(
		p.secretsFile,
		"GH_TOKEN=x\nANTHROPIC_API_KEY=y\nFOO_SECRET=z\n",
	);
	const e = buildAgentEnv(p, "durable-shell", {
		agent: "a",
		parent: { GH_TOKEN: "bad", OPENAI_API_KEY: "bad", PATH: "/bin" },
	});
	for (const k of [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"FOO_SECRET",
		"DURABLE_HOME",
		"PI_CODING_AGENT_DIR",
	])
		assert.equal(e[k], undefined);
	assert.equal(e.DURABLE_WORKER, "1");
});
test("worker kind precedence and enablement shape", () => {
	const d = {
		profile: "work",
		workers: {
			kind: "pi-session" as const,
			roles: { worker: { kind: "durable-conversation" as const } },
			durable: { enabledRoles: ["worker"] },
		},
	};
	const m = {
		name: "m",
		agents: ["a"],
		workers: { roles: { worker: { kind: "pi-session" as const } } },
	};
	assert.equal(effectiveKind(d, m, "worker"), "pi-session");
});
test("package pins", async () => {
	const p = JSON.parse(
		await import("node:fs/promises").then((x) =>
			x.readFile("package.json", "utf8"),
		),
	);
	assert.equal(p.engines.node, ">=22.19.0");
	for (const n of [
		"@earendil-works/pi-durable",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/chord",
	])
		assert.equal(p.dependencies[n], "1.4.0");
});
