import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ResolvedProfile } from "./profiles.ts";

const dirs = [
	"auth-profiles",
	"secrets",
	"profile-meta",
	"extensions",
	"skills",
	"agents",
	"prompts",
	"npm",
	"vendor",
];
export function createDerivedPiDir(
	target: string,
	source: string,
	profile: ResolvedProfile,
): void {
	mkdirSync(target, { recursive: true, mode: 0o700 });
	chmodSync(target, 0o700);
	if (!derivedAuthSafe(target))
		throw new Error(
			"unsafe derived auth.json: remove credentials or file symlink before continuing",
		);
	writeFileSync(join(target, "settings.json"), "{}\n", { mode: 0o600 });
	writeFileSync(
		join(target, "auth-profiles.json"),
		`${JSON.stringify({ defaultProfile: profile.name })}\n`,
		{ mode: 0o600 },
	);
	for (const d of dirs) {
		const to = join(target, d);
		try {
			const stat = lstatSync(to);
			if (!stat.isSymbolicLink() || readlinkSync(to) !== join(source, d))
				throw new Error(`unexpected derived directory: ${d}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			symlinkSync(join(source, d), to, "dir");
		}
	}
}
export function derivedAuthSafe(dir: string): boolean {
	const path = join(dir, "auth.json");
	try {
		if (lstatSync(path).isSymbolicLink()) return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		return false;
	}
	try {
		return JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === "{}";
	} catch {
		return false;
	}
}
