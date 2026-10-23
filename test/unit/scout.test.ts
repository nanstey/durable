import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyJudgment } from "../../src/scout/judge.ts";
import { GitHubIssuesSource } from "../../src/sources/githubIssues.ts";
import { GitHubPrsSource } from "../../src/sources/githubPrs.ts";
import { LocalFilesSource } from "../../src/sources/localFiles.ts";
import type { Candidate } from "../../src/sources/types.ts";

const candidate: Candidate = {
	ref: "org/repo#1",
	kind: "issue",
	repo: "org/repo",
	title: "item",
	author: "member",
	authorAssociation: "MEMBER",
	labels: ["ready"],
	updatedAt: "2026-01-01T00:00:00Z",
};
test("GitHub sources map fixtures and never invoke a write command", async () => {
	const calls: string[][] = [];
	const run = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "api") return "4999";
		return JSON.stringify([
			{
				number: 1,
				title: "item",
				author: { login: "member" },
				authorAssociation: "MEMBER",
				labels: [{ name: args[0] === "pr" ? "durable/agent:agent" : "ready" }],
				updatedAt: candidate.updatedAt,
				url: "https://example.invalid/1",
				state: "OPEN",
				mergeStateStatus: "BEHIND",
				reviewDecision: "CHANGES_REQUESTED",
				statusCheckRollup: [{ conclusion: "FAILURE" }],
			},
		]);
	};
	const issues = await new GitHubIssuesSource({ repo: "org/repo", run }).poll();
	const prs = await new GitHubPrsSource({
		repo: "org/repo",
		login: "member",
		agentId: "agent",
		run,
	}).poll();
	assert.equal(issues[0].bodyRef, "github:org/repo#1");
	assert.deepEqual(prs[0].labels.slice(-3), [
		"durable/needs:failing-checks",
		"durable/needs:changes-requested",
		"durable/needs:behind-base",
	]);
	assert.ok(
		calls.every(
			(args) => !["label", "edit", "comment", "close"].includes(args[0]),
		),
	);
});
test("local source accepts ready front matter and rejects a symlink escape", async () => {
	const root = await mkdtemp(join(tmpdir(), "durable-scout-"));
	const outside = await mkdtemp(join(tmpdir(), "durable-outside-"));
	try {
		await mkdir(join(root, "items"));
		await writeFile(
			join(root, "items", "ready.md"),
			"---\nstatus: ready\npriority: 1\nsize: 2\n---\nbody",
		);
		await writeFile(
			join(outside, "escape.md"),
			"---\nstatus: ready\n---\nbody",
		);
		await symlink(join(outside, "escape.md"), join(root, "items", "escape.md"));
		const entries = await new LocalFilesSource({
			repo: "org/repo",
			checkout: root,
			pattern: "items/*.md",
			readyValue: "ready",
		}).poll();
		assert.deepEqual(
			entries.map((entry) => entry.ref),
			["org/repo:items/ready.md"],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
test("judge only demotes eligible code decisions and failures do not alter them", async () => {
	assert.deepEqual(
		await applyJudgment(candidate, "eligible", [], async () => ({
			actionable: "yes",
			risk: "high",
			size: "small",
		})),
		{ state: "needs-human", reasons: ["judge:high-risk"] },
	);
	assert.deepEqual(
		await applyJudgment(candidate, "eligible", [], async () => {
			throw Error("offline");
		}),
		{ state: "eligible", reasons: [] },
	);
});
