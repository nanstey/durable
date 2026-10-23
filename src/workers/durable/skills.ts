import { readFile } from "node:fs/promises";
import { join } from "node:path";

const maxSkillBytes = 32 * 1024;
const validSkillName = /^[A-Za-z0-9._-]+$/;
const unsupportedWorkflow =
	/\b(?:sub-?agents?|code[- ]?mode|helper scripts?|scripts?\/)\b/i;

function skillPath(piDir: string, name: string): string {
	if (!validSkillName.test(name) || name === "." || name === "..")
		throw Error(`durable skill name is invalid: ${name}`);
	return join(piDir, "skills", name, "SKILL.md");
}

/** Durable workers consume only allowlisted SKILL.md text, never skill runtime files. */
export async function durableSkillSections(
	piDir: string | undefined,
	skills: readonly string[] = [],
): Promise<string> {
	if (skills.length === 0) return "";
	if (!piDir) throw Error("durable skills require the generated Pi directory");
	const sections: string[] = [];
	for (const name of skills) {
		const body = await readFile(skillPath(piDir, name), "utf8");
		if (Buffer.byteLength(body) > maxSkillBytes)
			throw Error(`durable skill ${name} exceeds ${maxSkillBytes} byte limit`);
		if (unsupportedWorkflow.test(body))
			throw Error(
				`durable skill ${name} requires subagent, codemode, or helper scripts; use a Pi-session worker`,
			);
		sections.push(`## Allowlisted skill: ${name}\n\n${body}`);
	}
	return `\n\n${sections.join("\n\n")}`;
}
