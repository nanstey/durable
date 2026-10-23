export type ClaimComment = { id: number; body: string };

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
}
export type ClaimTarget = {
	repo: string;
	issue: number;
	agent: string;
	lease: string;
};
export type ClaimResult = {
	state: "won" | "lost";
	commentId?: number;
	winner?: string;
};
const marker = /^<!-- durable-claim agent=([^\s]+) lease=([^\s]+) -->$/;

// fallow-ignore-next-line unused-export
export function claimMarker(agent: string, lease: string): string {
	return `<!-- durable-claim agent=${agent} lease=${lease} -->`;
}
// fallow-ignore-next-line unused-export
export function parseClaim(
	body: string,
): { agent: string; lease: string } | undefined {
	const result = marker.exec(body.trim());
	return result ? { agent: result[1], lease: result[2] } : undefined;
}

/** GitHub is the arbitration record: after writing, read it back and lowest comment id wins. */
export async function claim(
	github: ClaimGithub,
	target: ClaimTarget,
): Promise<ClaimResult> {
	await github.addLabel(target.repo, target.issue, "durable/claimed");
	const own = await github.createComment(
		target.repo,
		target.issue,
		claimMarker(target.agent, target.lease),
	);
	const claims = (await github.listComments(target.repo, target.issue))
		.map((comment) => ({ comment, marker: parseClaim(comment.body) }))
		.filter(
			(
				entry,
			): entry is {
				comment: ClaimComment;
				marker: { agent: string; lease: string };
			} => Boolean(entry.marker),
		)
		.sort((a, b) => a.comment.id - b.comment.id);
	const winner = claims[0];
	if (winner?.comment.id === own.id)
		return { state: "won", commentId: own.id, winner: target.agent };
	await github.removeLabel(target.repo, target.issue, "durable/claimed");
	return { state: "lost", commentId: own.id, winner: winner?.marker.agent };
}

// fallow-ignore-next-line unused-export
export async function releaseClaim(
	github: ClaimGithub,
	target: Pick<ClaimTarget, "repo" | "issue">,
): Promise<void> {
	await github.removeLabel(target.repo, target.issue, "durable/claimed");
}
