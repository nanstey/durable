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
	size?: number;
};

export interface Source {
	poll(): Promise<Candidate[]>;
}
