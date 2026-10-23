import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { ApprovalNonces } from "../approval/nonce.ts";
import { agentDir, loadJson, saveJson } from "../steward/files.ts";
import { agentsDir, durableHome } from "./paths.ts";
import {
	type AgentDef,
	type OrganizationDef,
	validateOrganization,
} from "./schema.ts";
import { loadYaml } from "./load.ts";

export type OrganizationRelease = {
	organization: string;
	parentHash: string | null;
	contentHash: string;
	publisher: string;
	approvedAt: number;
};
export type OrganizationBundle = {
	bytes: string;
	contentHash: string;
	approval: OrganizationRelease;
};
export type EffectiveOrganization = {
	name: string;
	bundleHash: string;
	effectivePolicyHash: string;
	policy: OrganizationDef | undefined;
};

export function organizationsDir() {
	return join(dirname(agentsDir()), "organizations");
}
export function organizationPath(name: string) {
	assertOrganizationName(name);
	return join(organizationsDir(), `${name}.yaml`);
}
export function assertOrganizationName(name: string) {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
		name === "." ||
		name === ".."
	)
		throw Error("organization must be a simple name");
}
export function contentHash(bytes: string | Buffer) {
	return createHash("sha256").update(bytes).digest("hex");
}
export function loadOrganization(name: string): OrganizationDef {
	const path = organizationPath(name);
	if (!existsSync(path))
		throw Error(`organization document not found: ${name}`);
	const org = validateOrganization(loadYaml(path));
	if (org.name !== name)
		throw Error("organization document name does not match filename");
	return org;
}
export function listOrganizations() {
	if (!existsSync(organizationsDir())) return [];
	return readdirSync(organizationsDir(), { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/.test(entry.name),
		)
		.map((entry) => basename(entry.name, ".yaml"))
		.sort();
}
function releasesPath(name: string) {
	return join(durableHome(), "organizations", name, "release.json");
}
function bundlePath(name: string) {
	return join(durableHome(), "organizations", name, "bundle.json");
}
export function releaseFor(name: string): OrganizationRelease | undefined {
	assertOrganizationName(name);
	return loadJson<OrganizationRelease | undefined>(
		releasesPath(name),
		() => undefined,
	);
}
export function issueOrganizationNonce(
	name: string,
	parentHash: string | null,
	candidateHash: string,
) {
	assertOrganizationName(name);
	return new ApprovalNonces(`org-${name}`).issue(
		"organization-apply",
		name,
		`${parentHash ?? "none"}:${candidateHash}`,
	);
}
/** Approve local bytes only. Network receivers must call verifyBundle before materializing. */
export function applyOrganization(
	name: string,
	code: string,
	publisher = "local-operator",
) {
	const path = organizationPath(name);
	const bytes = readFileSync(path, "utf8");
	const org = loadOrganization(name);
	const hash = contentHash(bytes);
	const previous = releaseFor(name);
	const parentHash = previous?.contentHash ?? null;
	if (
		!new ApprovalNonces(`org-${name}`).verify(
			"organization-apply",
			name,
			`${parentHash ?? "none"}:${hash}`,
			code,
		)
	)
		throw Error(
			"organization apply requires a fresh approval nonce bound to name, parent hash, and content hash",
		);
	const approval: OrganizationRelease = {
		organization: name,
		parentHash,
		contentHash: hash,
		publisher,
		approvedAt: Date.now(),
	};
	mkdirSync(dirname(releasesPath(name)), { recursive: true, mode: 0o700 });
	saveJson(releasesPath(name), approval);
	saveJson(bundlePath(name), {
		bytes,
		contentHash: hash,
		approval,
	} satisfies OrganizationBundle);
	return {
		approval,
		organization: org,
		diff: organizationDiff(previous, hash),
	};
}
export function verifyBundle(bundle: OrganizationBundle): OrganizationDef {
	if (
		contentHash(bundle.bytes) !== bundle.contentHash ||
		bundle.approval.contentHash !== bundle.contentHash
	)
		throw Error("organization bundle content hash mismatch");
	if (bundle.approval.organization === "default")
		throw Error("default organization cannot be bundled");
	const org = validateOrganization(loadYamlFromBytes(bundle.bytes));
	if (org.name !== bundle.approval.organization)
		throw Error("organization bundle name mismatch");
	return org;
}
function loadYamlFromBytes(bytes: string) {
	return parse(bytes, { uniqueKeys: true });
}
export function materializeOrganization(
	agent: string,
	def: AgentDef,
	bundle?: OrganizationBundle,
): EffectiveOrganization {
	const name = def.organization ?? "default";
	if (name === "default")
		return {
			name,
			bundleHash: "default",
			effectivePolicyHash: contentHash(stringify(def)),
			policy: undefined,
		};
	const org = bundle ? verifyBundle(bundle) : loadOrganization(name);
	if (!org.memberAgents.includes(agent))
		throw Error("agent is not an organization member");
	const bytes = bundle?.bytes ?? readFileSync(organizationPath(name), "utf8");
	const effective = effectiveOrganization(def, org);
	const result = {
		name,
		bundleHash: contentHash(bytes),
		effectivePolicyHash: contentHash(stringify(effective)),
		policy: org,
	};
	saveJson(join(agentDir(agent), "organization.json"), result);
	return result;
}
export function effectiveOrganization(
	def: AgentDef,
	org: OrganizationDef,
): AgentDef {
	const repos = def.scope?.repos ?? [];
	const allowedRepos = new Set(org.scope?.repos ?? []);
	if (allowedRepos.size && repos.some((repo) => !allowedRepos.has(repo.slug)))
		throw Error(
			"agent scope contains a repository outside organization policy",
		);
	for (const connector of def.connectors ?? []) {
		const ceiling = org.connectors?.find(
			(candidate) => candidate.id === connector.id,
		);
		if (!ceiling)
			throw Error(`connector ${connector.id} is outside organization policy`);
		for (const tool of connector.tools) {
			const allowed = ceiling.tools.find(
				(candidate) => candidate.id === tool.id,
			);
			if (
				!allowed ||
				allowed.access !== tool.access ||
				(tool.access === "write" && allowed.write !== true)
			)
				throw Error(
					`connector tool ${connector.id}/${tool.id} loosens organization policy`,
				);
		}
	}
	for (const [key, limit] of Object.entries(def.limits ?? {})) {
		const ceiling = org.limits?.[key];
		if (ceiling !== undefined && limit > ceiling)
			throw Error(`limit ${key} exceeds organization ceiling`);
	}
	return def;
}
function organizationDiff(
	previous: OrganizationRelease | undefined,
	content: string,
) {
	return previous
		? { from: previous.contentHash, to: content }
		: { from: null, to: content };
}
