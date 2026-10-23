// fallow-ignore-file unused-file
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candidate } from "../sources/types.ts";

export type ScoutBrief = { text: string; trusted: boolean };

/** Scout output is accepted only for code-validated trusted authors. */
export function createScoutBrief(
	candidate: Candidate,
	trusted: boolean,
	scoutText: string,
): ScoutBrief {
	if (!trusted) throw Error("untrusted author cannot create a worker brief");
	const task = [candidate.title, scoutText.trim()].filter(Boolean).join("\n\n");
	return { text: task, trusted: true };
}

export function assembleWorkerBrief(values: {
	brief: ScoutBrief;
	branch: string;
	agent: string;
	login: string;
	templatePath?: string;
}): string {
	if (!values.brief.trusted)
		throw Error("worker brief requires trusted scout output");
	const path = values.templatePath ?? resolve("templates/worker-brief.md");
	return readFileSync(path, "utf8")
		.replaceAll("{{brief}}", values.brief.text)
		.replaceAll("{{branch}}", values.branch)
		.replaceAll("{{agent}}", values.agent)
		.replaceAll("{{login}}", values.login);
}
