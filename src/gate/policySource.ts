import {
	validateAutoMergePolicy,
	type AutoMergePolicy,
	type PolicyState,
} from "./policy.ts";
import type { ProtectedLocation } from "./hardPaths.ts";

export type RepoRef = { slug: string; base?: string };
export type PolicyResolution = {
	state: PolicyState;
	policy?: AutoMergePolicy;
	/** A steward-resolved trusted reference, never a PR/worktree ref. */
	ref: string;
	fingerprint: string;
};
export type ChangeSummary = { summary: string; from?: string; to?: string };

export interface RepoPolicySource {
	readonly kind: string;
	resolve(repo: RepoRef): Promise<PolicyResolution>;
	protectedLocations(repo: RepoRef): readonly ProtectedLocation[];
	describeChange(repo: RepoRef, since?: string): Promise<ChangeSummary>;
}

export class NonePolicySource implements RepoPolicySource {
	readonly kind = "none";
	async resolve(_repo: RepoRef): Promise<PolicyResolution> {
		return { state: "none", ref: "steward:none", fingerprint: "none" };
	}
	protectedLocations(_repo: RepoRef): readonly ProtectedLocation[] {
		return [];
	}
	async describeChange(
		_repo: RepoRef,
		_since?: string,
	): Promise<ChangeSummary> {
		return { summary: "No repository policy source is configured." };
	}
}

export type FixturePolicyScript = {
	resolution: PolicyResolution;
	protectedLocations?: readonly ProtectedLocation[];
	change?: ChangeSummary;
	/** Fixture evidence models the only two non-forgeable verification inputs. */
	verifiedBy?: "approval" | "github";
};

/** Test seam. It intentionally has no filesystem or GitHub input surface. */
export class FixturePolicySource implements RepoPolicySource {
	readonly kind = "fixture";
	private readonly scripts: Record<string, FixturePolicyScript>;
	constructor(scripts: Record<string, FixturePolicyScript>) {
		this.scripts = scripts;
		if (
			process.env.DURABLE_ALLOW_FIXTURE_SOURCE !== "1" &&
			process.env.NODE_ENV !== "test" &&
			process.env.NODE_TEST_CONTEXT !== "child-v8" &&
			!process.execArgv.includes("--test")
		)
			throw Error("fixture policy source is test-only");
	}
	private script(repo: RepoRef) {
		const script = this.scripts[repo.slug];
		if (!script) throw Error(`fixture policy script missing for ${repo.slug}`);
		if (
			script.resolution.state === "verified" &&
			script.verifiedBy !== "approval" &&
			script.verifiedBy !== "github"
		)
			throw Error(
				"fixture verified policy requires approval or GitHub evidence",
			);
		return script;
	}
	async resolve(repo: RepoRef): Promise<PolicyResolution> {
		const resolution = structuredClone(this.script(repo).resolution);
		if (resolution.policy)
			resolution.policy = validateAutoMergePolicy(resolution.policy);
		return resolution;
	}
	protectedLocations(repo: RepoRef): readonly ProtectedLocation[] {
		return this.script(repo).protectedLocations ?? [];
	}
	async describeChange(repo: RepoRef, since?: string): Promise<ChangeSummary> {
		const script = this.script(repo);
		return (
			script.change ?? {
				summary: `Fixture policy ${script.resolution.state}`,
				from: since,
				to: script.resolution.fingerprint,
			}
		);
	}
}

export function sourceFor(
	kind: string,
	fixtures?: Record<string, FixturePolicyScript>,
): RepoPolicySource {
	if (kind === "none") return new NonePolicySource();
	if (kind === "fixture") return new FixturePolicySource(fixtures ?? {});
	throw Error(`source kind not implemented: ${kind}`);
}
