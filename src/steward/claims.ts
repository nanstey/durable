export type ClaimComment = {
	id: number;
	body: string;
	login?: string;
	authorAssociation?: string;
	/** GitHub server timestamp, used to bound a marker's holder-supplied lease. */
	updatedAt?: string;
};

/** Injectable GitHub surface. Production code can adapt gh or Octokit; tests never write GitHub. */
export interface ClaimGithub {
	/** Fresh GitHub HTTP Date, never the workstation wall clock. */
	serverNow?(repo: string): Promise<number>;
	addLabel(repo: string, issue: number, label: string): Promise<void>;
	removeLabel(repo: string, issue: number, label: string): Promise<void>;
	createComment(
		repo: string,
		issue: number,
		body: string,
	): Promise<ClaimComment>;
	listComments(repo: string, issue: number): Promise<ClaimComment[]>;
	deleteComment?(repo: string, commentId: number, item?: string): Promise<void>;
	updateComment?(
		repo: string,
		commentId: number,
		body: string,
		item?: string,
	): Promise<void>;
}
export type ClaimTarget = {
	repo: string;
	issue: number;
	agent: string;
	lease: string;
	item?: string;
	owner?: string;
	/** GitHub login for the profile that owns Durable's claim comments. */
	login?: string;
};
export type ClaimLeasePolicy = {
	durationMs: number;
	graceMs: number;
};
export const defaultClaimLeasePolicy: ClaimLeasePolicy = {
	durationMs: 2 * 60 * 60 * 1000,
	graceMs: 5 * 60 * 1000,
};
export type ClaimResult = {
	state: "won" | "lost";
	commentId?: number;
	winner?: string;
};
const marker =
	/^<!-- durable-claim agent=([^\s]+) lease=([^\s]+)(?: owner=([^\s]+))? -->$/;
function trustedComment(comment: ClaimComment, login?: string) {
	return (
		!login ||
		Boolean(comment.login?.toLowerCase() === login.toLowerCase()) ||
		["OWNER", "MEMBER", "COLLABORATOR"].includes(
			comment.authorAssociation?.toUpperCase() ?? "",
		)
	);
}
function activeLease(
	lease: string,
	comment: ClaimComment,
	now: number,
	policy: ClaimLeasePolicy,
) {
	const requestedExpiry = Date.parse(lease);
	if (!Number.isFinite(requestedExpiry)) return false;
	const updatedAt = Date.parse(comment.updatedAt ?? "");
	// A marker is untrusted input. When GitHub supplies its server timestamp, it
	// cannot extend a lease past one configured duration from that timestamp.
	const expiresAt = Number.isFinite(updatedAt)
		? Math.min(requestedExpiry, updatedAt + policy.durationMs)
		: requestedExpiry;
	return expiresAt + policy.graceMs > now;
}
function ownsClaim(
	claim: { agent: string; owner?: string },
	target: ClaimTarget,
) {
	return claim.agent === target.agent && claim.owner === target.owner;
}
function policyWithDefaults(
	policy?: Partial<ClaimLeasePolicy>,
): ClaimLeasePolicy {
	return {
		durationMs: policy?.durationMs ?? defaultClaimLeasePolicy.durationMs,
		graceMs: policy?.graceMs ?? defaultClaimLeasePolicy.graceMs,
	};
}

export function claimMarker(
	agent: string,
	lease: string,
	owner?: string,
): string {
	return `<!-- durable-claim agent=${agent} lease=${lease}${owner ? ` owner=${owner}` : ""} -->`;
}
export function parseClaim(
	body: string,
): { agent: string; lease: string; owner?: string } | undefined {
	const result = marker.exec(body.trim());
	return result
		? {
				agent: result[1],
				lease: result[2],
				...(result[3] ? { owner: result[3] } : {}),
			}
		: undefined;
}

/** Re-read GitHub before every action; production expiry uses GitHub's clock. */
export async function readClaim(
	github: ClaimGithub,
	target: ClaimTarget,
	now = Date.now(),
	policy?: Partial<ClaimLeasePolicy>,
): Promise<ClaimResult> {
	const options = policyWithDefaults(policy);
	now = (await github.serverNow?.(target.repo)) ?? now;
	const winner = (await github.listComments(target.repo, target.issue))
		.map((comment) => ({ comment, marker: parseClaim(comment.body) }))
		.filter(
			(
				entry,
			): entry is {
				comment: ClaimComment;
				marker: { agent: string; lease: string; owner?: string };
			} =>
				Boolean(
					entry.marker &&
						trustedComment(entry.comment, target.login) &&
						activeLease(entry.marker.lease, entry.comment, now, options),
				),
		)
		.sort((a, b) => a.comment.id - b.comment.id)[0];
	if (!winner) return { state: "lost" };
	return {
		state: ownsClaim(winner.marker, target) ? "won" : "lost",
		commentId: winner.comment.id,
		winner: winner.marker.agent,
	};
}

/** GitHub is the arbitration record: after writing, world-read again and lowest comment id wins. */
export async function claim(
	github: ClaimGithub,
	target: ClaimTarget,
	now = Date.now(),
	policy?: Partial<ClaimLeasePolicy>,
): Promise<ClaimResult> {
	const options = policyWithDefaults(policy);
	const serverNow = await github.serverNow?.(target.repo);
	now = serverNow ?? now;
	const requestedLease =
		serverNow === undefined
			? Date.parse(target.lease)
			: now + options.durationMs;
	const lease = new Date(
		Math.min(
			Number.isFinite(requestedLease)
				? requestedLease
				: now + options.durationMs,
			now + options.durationMs,
		),
	).toISOString();
	const markerBody = claimMarker(target.agent, lease, target.owner);
	const before = await readClaim(github, target, now, options);
	if (before.state === "won" && before.commentId !== undefined) {
		await github.updateComment?.(
			target.repo,
			before.commentId,
			markerBody,
			target.item,
		);
		return { ...before, winner: target.agent };
	}
	const own = await github.createComment(target.repo, target.issue, markerBody);
	const after = await readClaim(github, target, now, options);
	if (after.state === "won" && after.commentId === own.id) {
		await github.addLabel(target.repo, target.issue, "durable/claimed");
		return after;
	}
	if (github.deleteComment)
		try {
			await github.deleteComment(target.repo, own.id, target.item);
		} catch {
			// A transient delete must not leave a competing marker for a full lease.
			await github.deleteComment(target.repo, own.id, target.item);
		}
	return { state: "lost", commentId: own.id, winner: after.winner };
}

// fallow-ignore-next-line unused-export
export async function releaseClaim(
	github: ClaimGithub,
	target: Pick<ClaimTarget, "repo" | "issue">,
): Promise<void> {
	await github.removeLabel(target.repo, target.issue, "durable/claimed");
}
