import {
	appendFileSync,
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { agentDir } from "./files.ts";

const credentials =
	/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?(?:-----END [\s\S]*?PRIVATE KEY-----|$))/g;
export function redact(value: unknown): unknown {
	if (typeof value === "string")
		return value.replace(credentials, "[redacted]");
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/token|secret|password|nonce|authorization|body|content/i.test(key)
					? "[redacted]"
					: redact(item),
			]),
		);
	return value;
}

export type AuditEvent = {
	at: number;
	agent: string;
	event: string;
	[key: string]: unknown;
};
const identities = new Map<string, { profile: string; login?: string }>();
export function setAuditIdentity(
	agent: string,
	profile: string,
	login?: string,
) {
	identities.set(agent, { profile, login });
}
export function audit(
	agent: string,
	event: { event: string; [key: string]: unknown },
) {
	const fd = openSync(join(agentDir(agent), "audit.jsonl"), "a", 0o600);
	try {
		// A single O_APPEND write cannot interleave with another writer's line.
		appendFileSync(
			fd,
			`${JSON.stringify(redact({ ts: Date.now(), at: Date.now(), agent, profile: identities.get(agent)?.profile ?? null, login: identities.get(agent)?.login ?? null, actor: "code", action: event.event, target: null, decision: null, reasons: [], sha: null, ...event }))}\n`,
		);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
export function readAudit(agent: string, since = 0): AuditEvent[] {
	try {
		return readFileSync(join(agentDir(agent), "audit.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as AuditEvent)
			.filter((event) => event.at >= since);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return [];
	}
}
export const logger = pino({
	base: undefined,
	redact: ["token", "secret", "authorization", "body", "content"],
});
