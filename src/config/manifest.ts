import { readFileSync } from "node:fs";
import { type ProfileManifest, validateManifest } from "./schema.ts";

/** Metadata only; parser errors must not echo an accidentally pasted credential. */
export function loadManifest(path: string): ProfileManifest {
	try {
		return validateManifest(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error(
			"invalid or unreadable profile manifest; initialize it and fill in GitHub/git identity",
		);
	}
}
