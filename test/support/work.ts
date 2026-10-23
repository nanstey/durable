import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeDispatcher } from "../../src/dispatch/fake.ts";
import type { ProcessSpec } from "../../src/dispatch/types.ts";
import type { Containment } from "../../src/platform/containment.ts";
import { audit, setAuditIdentity } from "../../src/steward/audit.ts";
import type { PullRequest, WorkGithub } from "../../src/steward/github.ts";
import { prMarker } from "../../src/steward/github.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import { WorkerKindRegistry } from "../../src/workers/kind.ts";
import { PiSessionKind } from "../../src/workers/piSession.ts";
import { WorkerRegistry } from "../../src/workers/registry.ts";

class FakeWorkGithub implements WorkGithub {
	comments: Array<{ id: number; body: string }> = [];
	pulls: Array<
		PullRequest & {
			branch: string;
			marker: string;
			draft: boolean;
			labels: string[];
			footer?: string;
		}
	> = [];
	writes: string[] = [];
	private write(operation: string) {
		this.writes.push(operation);
		audit("agent", { event: "github-write", operation });
	}
	async addLabel() {
		this.write("add-label");
	}
	async removeLabel() {
		this.write("remove-label");
	}
	async createComment(_repo: string, _issue: number, body: string) {
		this.write("create-comment");
		const comment = { id: this.comments.length + 1, body };
		this.comments.push(comment);
		return comment;
	}
	async listComments() {
		return [...this.comments];
	}
	async updateComment(_repo: string, id: number, body: string) {
		this.write("update-comment");
		this.comments.find((comment) => comment.id === id)!.body = body;
	}
	async deleteComment(_repo: string, id: number) {
		this.write("delete-comment");
		this.comments = this.comments.filter((comment) => comment.id !== id);
	}
	async readIntake() {
		return "Trusted issue body, read through the GitHub seam.";
	}
	async readPr(_repo: string, number: number) {
		const pr = this.pulls.find((pr) => pr.number === number);
		if (!pr) throw Error("unknown fake PR");
		return pr;
	}
	async findDraftPr(input: { branch: string; marker: string }) {
		return this.pulls.find(
			(pr) =>
				pr.branch === input.branch &&
				pr.marker === input.marker &&
				pr.draft &&
				pr.labels.includes("durable/agent:agent"),
		);
	}
	async attributePr(_repo: string, number: number) {
		this.write("attribute-pr");
		(await this.readPr("", number)).footer =
			"Opened by durable agent agent for operator-login; not yet reviewed by a human.";
	}
	async commentOnce(input: { body: string }) {
		if (!this.comments.some((comment) => comment.body === input.body))
			await this.createComment("", 1, input.body);
	}
	open(branch: string) {
		this.write("create-draft-pr");
		const item = branch.split("/").at(-1)!;
		this.pulls.push({
			number: this.pulls.length + 1,
			branch,
			marker: prMarker("agent", item),
			draft: true,
			labels: ["durable/agent:agent"],
			state: "open",
		});
	}
}
class ReportingDispatcher extends FakeDispatcher {
	autoReport = false;
	launches: ProcessSpec[] = [];
	github: FakeWorkGithub;
	constructor(github: FakeWorkGithub) {
		super();
		this.github = github;
	}
	override async hostProcess(spec: ProcessSpec) {
		this.launches.push(spec);
		const handle = await super.hostProcess(spec);
		if (
			this.autoReport &&
			!this.github.pulls.some((pr) => pr.branch === spec.workspace.branch)
		)
			this.github.open(spec.workspace.branch);
		return handle;
	}
}
export function workDependencies(home: string, github = new FakeWorkGithub()) {
	setAuditIdentity("agent", "fixture", "operator-login");
	const dispatcher = new ReportingDispatcher(github);
	const kinds = new WorkerKindRegistry();
	kinds.register(new PiSessionKind(dispatcher, join(home, "launchers")));
	const workers = new WorkerRegistry();
	const containment: Containment = {
		confirmed: true,
		spawn: () => {
			throw Error("fake worker must not spawn a subprocess");
		},
		kill: async () => true,
		empty: async () => true,
	};
	const processes = new ProcessManager("agent", containment);
	const skillsRoot = join(home, "skills-root");
	for (const skill of ["idea-to-pr", "pr", "build"]) {
		const path = join(skillsRoot, "skills", skill);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "SKILL.md"), "# Fixture skill\n");
	}
	return { dispatcher, kinds, workers, processes, skillsRoot, github };
}
export const candidate = (number = 1) => ({
	ref: `acme/repo#${number}`,
	repo: "acme/repo",
	kind: "issue" as const,
	title: "Small trusted change",
	author: "operator-login",
	authorAssociation: "OWNER",
	labels: [],
	updatedAt: new Date().toISOString(),
});
