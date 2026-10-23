export type Candidate = {
	ref: string;
	kind: "issue" | "pull-request" | "file";
	repo: string;
	title: string;
	author: string;
	authorAssociation?: string;
	labels: string[];
	updatedAt: string;
	bodyRef?: string;
	url?: string;
	state?: string;
	attempts?: number;
	/** Source-declared or validated judge size; numeric source size remains for eligibility caps. */
	size?: number | "small" | "medium" | "large";
};

export interface Source {
	poll(): Promise<Candidate[]>;
}
