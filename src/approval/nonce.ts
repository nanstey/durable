import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir, loadJson, saveJson } from "../steward/files.ts";

type NonceRecord = { hash: string; expiresAt: number };
/** Approval credentials are action-, item- and epoch-bound, hashed at rest and consumed once. */
export class ApprovalNonces {
	private readonly path: string;
	private readonly agent: string;
	private readonly now: () => number;
	constructor(agent: string, now = Date.now) {
		this.agent = agent;
		this.now = now;
		this.path = join(agentDir(agent), "approval", "nonces.json");
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
	}
	private digest(
		action: string,
		item: string,
		binding: string | number,
		code: string,
	) {
		return createHash("sha256")
			.update(JSON.stringify([code, this.agent, action, item, binding]))
			.digest("hex");
	}
	issue(action: string, item: string, binding: string | number): string {
		const code = randomBytes(24).toString("base64url");
		const records = loadJson<Record<string, NonceRecord>>(
			this.path,
			() => ({}),
		);
		for (const [key, value] of Object.entries(records))
			if (value.expiresAt <= this.now()) delete records[key];
		records[JSON.stringify([action, item, binding])] = {
			hash: this.digest(action, item, binding, code),
			expiresAt: this.now() + 5 * 60000,
		};
		saveJson(this.path, records);
		return code;
	}
	verify(
		action: string,
		item: string,
		binding: string | number,
		code: string,
	): boolean {
		const records = loadJson<Record<string, NonceRecord>>(
			this.path,
			() => ({}),
		);
		const key = JSON.stringify([action, item, binding]);
		const record = records[key];
		const actual = Buffer.from(this.digest(action, item, binding, code), "hex");
		if (
			!record ||
			record.expiresAt <= this.now() ||
			!timingSafeEqual(Buffer.from(record.hash, "hex"), actual)
		)
			return false;
		delete records[key];
		saveJson(this.path, records);
		return true;
	}
}
