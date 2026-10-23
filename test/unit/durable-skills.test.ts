import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { durableSkillSections } from "../../src/workers/durable/skills.ts";

async function skillRoot() {
	const root = await mkdtemp(join(tmpdir(), "durable-skills-"));
	await mkdir(join(root, "skills", "small"), { recursive: true });
	return root;
}

test("durable skills inline only allowlisted SKILL.md text", async () => {
	const root = await skillRoot();
	try {
		await writeFile(
			join(root, "skills", "small", "SKILL.md"),
			"# Small\nUse files.",
		);
		assert.match(
			await durableSkillSections(root, ["small"]),
			/Allowlisted skill: small[\s\S]*Use files/,
		);
		assert.equal(await durableSkillSections(root), "");
		await assert.rejects(() => durableSkillSections(root, ["../small"]));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("durable skills reject runtime-dependent workflows", async () => {
	const root = await skillRoot();
	try {
		await writeFile(
			join(root, "skills", "small", "SKILL.md"),
			"Delegate this to a subagent before continuing.",
		);
		await assert.rejects(
			() => durableSkillSections(root, ["small"]),
			/subagent, codemode, or helper scripts/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
