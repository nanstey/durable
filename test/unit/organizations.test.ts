import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyOrganization,
	bundleFor,
	contentHash,
	issueOrganizationNonce,
	loadOrganization,
	materializeOrganization,
	receiveOrganizationBundle,
} from "../../src/config/organizations.ts";
import {
	validateAgent,
	validateOrganization,
} from "../../src/config/schema.ts";

test("organization schema rejects unknown keys and default documents", () => {
	assert.throws(() =>
		validateOrganization({
			name: "work",
			memberAgents: ["agent"],
			unknown: true,
		}),
	);
	assert.throws(() =>
		validateOrganization({ name: "default", memberAgents: ["agent"] }),
	);
	assert.equal(
		validateAgent({ profile: "fixture", organization: "work" }).organization,
		"work",
	);
});
test("default organization preserves an unmodified agent definition", () => {
	const def = validateAgent({ profile: "fixture", connectors: [] });
	const materialized = materializeOrganization("agent", def);
	assert.equal(materialized.name, "default");
	assert.equal(materialized.bundleHash, "default");
	assert.match(materialized.effectivePolicyHash, /^[a-f0-9]{64}$/);
});
test("organization approvals bind candidate bytes and cannot replay", () => {
	const root = mkdtempSync(join(tmpdir(), "durable-org-"));
	mkdirSync(join(root, "agents"));
	mkdirSync(join(root, "organizations"));
	writeFileSync(
		join(root, "organizations", "work.yaml"),
		"name: work\nmemberAgents: [agent]\n",
	);
	const oldAgents = process.env.DURABLE_AGENTS_DIR;
	const oldHome = process.env.DURABLE_HOME;
	process.env.DURABLE_AGENTS_DIR = join(root, "agents");
	process.env.DURABLE_HOME = join(root, "state");
	try {
		const hash = contentHash("name: work\nmemberAgents: [agent]\n");
		const code = issueOrganizationNonce("work", null, hash);
		assert.equal(applyOrganization("work", code).approval.contentHash, hash);
		assert.throws(() => applyOrganization("work", code));
	} finally {
		if (oldAgents === undefined) delete process.env.DURABLE_AGENTS_DIR;
		else process.env.DURABLE_AGENTS_DIR = oldAgents;
		if (oldHome === undefined) delete process.env.DURABLE_HOME;
		else process.env.DURABLE_HOME = oldHome;
	}
});
test("named organizations require an approved release and materialize policy ceilings", () => {
	const root = mkdtempSync(join(tmpdir(), "durable-org-"));
	mkdirSync(join(root, "agents"));
	mkdirSync(join(root, "organizations"));
	const bytes =
		"name: work\nmemberAgents: [agent]\nscope:\n  repos: [acme/safe]\nlimits:\n  maxConcurrentWorkers: 1\n";
	writeFileSync(join(root, "organizations", "work.yaml"), bytes);
	const oldAgents = process.env.DURABLE_AGENTS_DIR;
	const oldHome = process.env.DURABLE_HOME;
	process.env.DURABLE_AGENTS_DIR = join(root, "agents");
	process.env.DURABLE_HOME = join(root, "state");
	try {
		const def = validateAgent({
			profile: "fixture",
			organization: "work",
			scope: { repos: [{ slug: "acme/safe" }] },
			limits: { maxConcurrentWorkers: 1 },
		});
		assert.throws(() => materializeOrganization("agent", def), /approved/);
		const code = issueOrganizationNonce("work", null, contentHash(bytes));
		applyOrganization("work", code);
		const materialized = materializeOrganization("agent", def);
		assert.equal(materialized.definition.limits?.maxConcurrentWorkers, 1);
		assert.equal(materialized.policy?.name, "work");
		const hostile = validateAgent({
			profile: "fixture",
			organization: "work",
			scope: { repos: [{ slug: "acme/safe" }] },
			sources: [{ kind: "github-issues", repo: "acme/other" }],
		});
		assert.throws(() => materializeOrganization("agent", hostile), /source/);
	} finally {
		if (oldAgents === undefined) delete process.env.DURABLE_AGENTS_DIR;
		else process.env.DURABLE_AGENTS_DIR = oldAgents;
		if (oldHome === undefined) delete process.env.DURABLE_HOME;
		else process.env.DURABLE_HOME = oldHome;
	}
});
test("approved bundle transport converges offline members and rejects tampering", () => {
	const origin = mkdtempSync(join(tmpdir(), "durable-org-origin-"));
	const member = mkdtempSync(join(tmpdir(), "durable-org-member-"));
	for (const root of [origin, member]) mkdirSync(join(root, "agents"));
	mkdirSync(join(origin, "organizations"));
	const bytes = "name: work\nmemberAgents: [agent]\nmaxStaleAge: 60000\n";
	writeFileSync(join(origin, "organizations", "work.yaml"), bytes);
	const oldAgents = process.env.DURABLE_AGENTS_DIR;
	const oldHome = process.env.DURABLE_HOME;
	try {
		process.env.DURABLE_AGENTS_DIR = join(origin, "agents");
		process.env.DURABLE_HOME = join(origin, "state");
		const bundle = (() => {
			const code = issueOrganizationNonce("work", null, contentHash(bytes));
			applyOrganization("work", code);
			return bundleFor("work");
		})();
		process.env.DURABLE_AGENTS_DIR = join(member, "agents");
		process.env.DURABLE_HOME = join(member, "state");
		receiveOrganizationBundle(bundle);
		const definition = validateAgent({
			profile: "member",
			organization: "work",
		});
		const materialized = materializeOrganization("agent", definition);
		assert.equal(materialized.bundleHash, bundle.contentHash);
		assert.equal(
			materializeOrganization("agent", definition).bundleHash,
			bundle.contentHash,
		);
		receiveOrganizationBundle(bundle, 0);
		assert.throws(
			() => materializeOrganization("agent", definition),
			/stale; new work is blocked/,
		);
		assert.throws(
			() =>
				receiveOrganizationBundle({
					...bundle,
					bytes: `${bundle.bytes}# tampered\n`,
				}),
			/content hash mismatch/,
		);
	} finally {
		if (oldAgents === undefined) delete process.env.DURABLE_AGENTS_DIR;
		else process.env.DURABLE_AGENTS_DIR = oldAgents;
		if (oldHome === undefined) delete process.env.DURABLE_HOME;
		else process.env.DURABLE_HOME = oldHome;
	}
});
test("organization documents use the sibling of DURABLE_AGENTS_DIR", () => {
	const root = mkdtempSync(join(tmpdir(), "durable-org-"));
	mkdirSync(join(root, "agents"));
	mkdirSync(join(root, "organizations"));
	writeFileSync(
		join(root, "organizations", "work.yaml"),
		"name: work\nmemberAgents: [agent]\n",
	);
	const old = process.env.DURABLE_AGENTS_DIR;
	process.env.DURABLE_AGENTS_DIR = join(root, "agents");
	try {
		assert.equal(loadOrganization("work").name, "work");
	} finally {
		if (old === undefined) delete process.env.DURABLE_AGENTS_DIR;
		else process.env.DURABLE_AGENTS_DIR = old;
	}
});
