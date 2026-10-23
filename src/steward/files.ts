import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { durableHome } from "../config/paths.ts";
import { assertProfileName } from "../config/schema.ts";

export function agentDir(agent: string) {
	assertProfileName(agent);
	const dir = join(durableHome(), "agents", agent);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Atomic, durable replace, including the directory entry. Never used for profile auth. */
export function saveJson(path: string, value: unknown) {
	const temp = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	const dir = openSync(dirname(path), "r");
	try {
		fsyncSync(dir);
	} finally {
		closeSync(dir);
	}
}

export function loadJson<T>(path: string, initial: () => T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return initial();
	}
}
