import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { agentDir, loadJson, saveJson } from "../steward/files.ts";

export type Scope = "read" | "chat" | "pause";
export type TokenRecord = {
	hash: string;
	client: string;
	scopes: Scope[];
	createdAt: number;
	lastUsedAt?: number;
	expiresAt: number;
};
const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");
function transaction<T>(
	agent: string,
	change: (records: TokenRecord[]) => T,
): T {
	const path = join(agentDir(agent), "tokens.json");
	const release = lockfile.lockSync(path, { realpath: false });
	try {
		const records = loadJson<TokenRecord[]>(path, () => []);
		const result = change(records);
		saveJson(path, records);
		return result;
	} finally {
		release();
	}
}
export function createToken(
	agent: string,
	client: string,
	scopes: Scope[],
	expiresDays = 90,
	now = Date.now(),
) {
	if (
		!client ||
		client.length > 100 ||
		!Array.isArray(scopes) ||
		!scopes.length ||
		scopes.some((s) => !["read", "chat", "pause"].includes(s)) ||
		!Number.isFinite(expiresDays) ||
		expiresDays <= 0
	)
		throw Error("invalid token client, scopes, or expiry");
	const token = `dur_${randomBytes(32).toString("base64url")}`;
	transaction(agent, (records) => {
		records.push({
			hash: digest(token),
			client,
			scopes: [...new Set(scopes)],
			createdAt: now,
			expiresAt: now + expiresDays * 86400000,
		});
	});
	return token;
}
export function authenticate(
	agent: string,
	token: string | undefined,
	now = Date.now(),
): TokenRecord | undefined {
	if (!token || token.length > 512) return;
	const hash = Buffer.from(digest(token), "hex");
	return transaction(agent, (records) => {
		const record = records.find((candidate) => {
			const expected = Buffer.from(candidate.hash, "hex");
			return expected.length === hash.length && timingSafeEqual(expected, hash);
		});
		if (!record || record.expiresAt <= now) return;
		record.lastUsedAt = now;
		return structuredClone(record);
	});
}
export function tokenActive(agent: string, hash: string, now = Date.now()) {
	const records = loadJson<TokenRecord[]>(
		join(agentDir(agent), "tokens.json"),
		() => [],
	);
	return records.some(
		(record) => record.hash === hash && record.expiresAt > now,
	);
}
export function authorize(
	agent: string,
	token: string | undefined,
	scope: Scope,
) {
	const record = authenticate(agent, token);
	return record?.scopes.includes(scope) ? record : undefined;
}
export function listTokens(agent: string) {
	if (!existsSync(join(agentDir(agent), "tokens.json"))) return [];
	return transaction(agent, (records) =>
		records.map(({ hash, ...metadata }) => ({
			id: hash.slice(0, 12),
			...metadata,
		})),
	);
}
export function revokeToken(agent: string, id: string) {
	transaction(agent, (records) => {
		let index = /^[a-f0-9]{12}$/.test(id)
			? records.findIndex((record) => record.hash.startsWith(id))
			: -1;
		if (index < 0) {
			const matches = records
				.map((record, candidate) => ({ record, candidate }))
				.filter(({ record }) => record.client === id);
			if (matches.length !== 1)
				throw Error(
					matches.length
						? "token client is ambiguous; use --id"
						: "token id not found",
				);
			index = matches[0].candidate;
		}
		records.splice(index, 1);
	});
}
export function localToken(agent: string) {
	const path = join(agentDir(agent), "token");
	if (existsSync(path)) {
		chmodSync(path, 0o600);
		const token = readFileSync(path, "utf8").trim();
		if (authenticate(agent, token)) return token;
	}
	const token = createToken(agent, "local-cli", ["read", "chat", "pause"]);
	writeFileSync(path, `${token}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return token;
}
