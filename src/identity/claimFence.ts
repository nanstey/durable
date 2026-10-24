import { execa } from "execa";
import {
	readClaim,
	type ClaimLeasePolicy,
	type ClaimTarget,
} from "../steward/claims.ts";
import { Github } from "../steward/github.ts";

/** The worker receives an immutable claim comment id, not permission to renew it. */
export async function checkWorkerClaim(env: NodeJS.ProcessEnv) {
	if (!env.DURABLE_CLAIM || !env.DURABLE_REAL_GH)
		throw Error("worker claim fence unavailable");
	const fence = JSON.parse(env.DURABLE_CLAIM) as {
		target: ClaimTarget;
		commentId?: number;
		policy: ClaimLeasePolicy;
		local?: boolean;
	};
	if (fence.local) return;
	if (!fence.commentId) throw Error("worker claim token missing");
	const github = new Github({
		agent: fence.target.agent,
		login: fence.target.login!,
		env,
		itemForIssue: () => undefined,
		processes: {
			launch: async (argv) => {
				const result = await execa(env.DURABLE_REAL_GH!, argv.slice(1), {
					env,
					extendEnv: false,
					reject: false,
					timeout: 10_000,
				});
				return {
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode ?? 1,
				};
			},
		},
	});
	const held = await readClaim(github, fence.target, undefined, fence.policy);
	if (held.state !== "won" || held.commentId !== fence.commentId)
		throw Error("claim lease lost");
}
