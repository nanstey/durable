export type ClaimComment = {
	id: number;
	body: string;
	login?: string;
	authorAssociation?: string;
};

/** Injectable GitHub surface. Production code can adapt gh or Octokit; tests never write GitHub. */
export interface ClaimGithub {
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
export type ClaimResult = {
	state: "won" | "lost";
	commentId?: number;
	winner?: string;
};
const marker =
	/^<!-- durable-claim agent=([^\s]+) lease=([^\s]+)(?: owner=([^\s]+))? -->$/;
const maxLeaseMs = 2 * 3600000;
function trustedComment(comment: ClaimComment, login?: string) {
	return (
		!login ||
		Boolean(comment.login?.toLowerCase() === login.toLowerCase()) ||
		["OWNER", "MEMBER", "COLLABORATOR"].includes(
			comment.authorAssociation?.toUpperCase() ?? "",
		)
	);
}

// fallow-ignore-next-line unused-export
export function claimMarker(
	agent: string,
	lease: string,
	owner?: string,
): string {
	return `<!-- durable-claim agent=${agent} lease=${lease}${owner ? ` owner=${owner}` : ""} -->`;
}
// fallow-ignore-next-line unused-export
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

/** GitHub is the arbitration record: after writing, read it back and lowest comment id wins. */
export async function claim(
	github: ClaimGithub,
	target: ClaimTarget,
	now = Date.now(),
): Promise<ClaimResult> {
	const lease = new Date(
		Math.min(Date.parse(target.lease), now + maxLeaseMs),
	).toISOString();
	const markerBody = claimMarker(target.agent, lease, target.owner);
	const existing = (await github.listComments(target.repo, target.issue))
		.filter((comment) => {
			const parsed = parseClaim(comment.body);
			return (
				trustedComment(comment, target.login) &&
				parsed &&
				Date.parse(parsed.lease) > now
			);
		})
		.sort((a, b) => a.id - b.id);
	const prior = existing.find((comment) => {
		const parsed = parseClaim(comment.body);
		return parsed?.agent === target.agent && parsed?.owner === target.owner;
	});
	if (prior && existing[0]?.id === prior.id) {
		await github.updateComment?.(
			target.repo,
			prior.id,
			markerBody,
			target.item,
		);
		return { state: "won", commentId: prior.id, winner: target.agent };
	}
	const own = await github.createComment(target.repo, target.issue, markerBody);
	const claims = (await github.listComments(target.repo, target.issue))
		.map((comment) => ({ comment, marker: parseClaim(comment.body) }))
		.filter(
			(
				entry,
			): entry is {
				comment: ClaimComment;
				marker: { agent: string; lease: string };
			} =>
				Boolean(
					entry.marker &&
						Date.parse(entry.marker.lease) > now &&
						(entry.comment.id === own.id ||
							trustedComment(entry.comment, target.login)),
				),
		)
		.sort((a, b) => a.comment.id - b.comment.id);
	const winner = claims[0];
	if (winner?.comment.id === own.id) {
		await github.addLabel(target.repo, target.issue, "durable/claimed");
		return { state: "won", commentId: own.id, winner: target.agent };
	}
	await github.deleteComment?.(target.repo, own.id, target.item);
	return { state: "lost", commentId: own.id, winner: winner?.marker.agent };
}

// fallow-ignore-next-line unused-export
export async function releaseClaim(
	github: ClaimGithub,
	target: Pick<ClaimTarget, "repo" | "issue">,
): Promise<void> {
	await github.removeLabel(target.repo, target.issue, "durable/claimed");
}
