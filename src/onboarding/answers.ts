import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { assertProfileName } from "../config/schema.ts";

export type OnboardAnswers = {
	profile: string;
	github?: "pending" | "bind";
	providers?: string[];
	anthropicOAuth?: boolean;
};

const allowed = new Set(["profile", "github", "providers", "anthropicOAuth"]);
const secretName = /^(?:token|secret|password|credential|api[_-]?key|auth)$/i;
const secretValue =
	/(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9]{12,}|bearer\s+)/i;

function rejectSecrets(value: unknown, path = "answers"): void {
	if (typeof value === "string" && secretValue.test(value))
		throw Error(`${path} must not contain credentials`);
	if (Array.isArray(value))
		for (const [index, item] of value.entries())
			rejectSecrets(item, `${path}[${index}]`);
	if (value && typeof value === "object")
		for (const [key, item] of Object.entries(value)) {
			if (secretName.test(key)) throw Error(`${path}.${key} is not permitted`);
			rejectSecrets(item, `${path}.${key}`);
		}
}

export function validateAnswers(value: unknown): OnboardAnswers {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("answers must be a plain object");
	rejectSecrets(value);
	for (const key of Object.keys(value))
		if (!allowed.has(key)) throw Error(`unknown answers key: ${key}`);
	const answers = value as Record<string, unknown>;
	if (typeof answers.profile !== "string")
		throw Error("answers.profile is required");
	assertProfileName(answers.profile);
	if (answers.profile === "default")
		throw Error("answers.profile must be a named profile");
	if (
		answers.github !== undefined &&
		!["pending", "bind"].includes(String(answers.github))
	)
		throw Error("answers.github must be pending or bind");
	if (
		answers.providers !== undefined &&
		(!Array.isArray(answers.providers) ||
			answers.providers.some(
				(item) => typeof item !== "string" || !/^[a-z0-9._-]+$/i.test(item),
			))
	)
		throw Error("answers.providers must be provider names");
	if (
		answers.anthropicOAuth !== undefined &&
		typeof answers.anthropicOAuth !== "boolean"
	)
		throw Error("answers.anthropicOAuth must be true or false");
	if (
		answers.providers?.includes("anthropic") &&
		answers.anthropicOAuth !== true
	)
		throw Error("Anthropic OAuth requires answers.anthropicOAuth: true");
	return {
		profile: answers.profile,
		github: answers.github as OnboardAnswers["github"],
		providers: answers.providers as string[] | undefined,
		anthropicOAuth: answers.anthropicOAuth as boolean | undefined,
	};
}

export function readAnswers(path: string): OnboardAnswers {
	return validateAnswers(parse(readFileSync(path, "utf8")));
}
