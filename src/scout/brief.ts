import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
	item?: string;
	templatePath?: string;
}): string {
	if (!values.brief.trusted)
		throw Error("worker brief requires trusted scout output");
	const path =
		values.templatePath ??
		fileURLToPath(new URL("../../templates/worker-brief.md", import.meta.url));
	const replacements: Record<string, string> = {
		"{{brief}}": values.brief.text,
		"{{branch}}": values.branch,
		"{{agent}}": values.agent,
		"{{login}}": values.login,
		"{{item}}": values.item ?? "",
	};
	return readFileSync(path, "utf8").replace(
		/\{\{brief\}\}|\{\{branch\}\}|\{\{agent\}\}|\{\{login\}\}|\{\{item\}\}/g,
		(token) => replacements[token],
	);
}
