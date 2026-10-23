import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** File-tool containment is enforced; bash remains an advisory guardrail. */
export async function confinedPath(
	worktree: string,
	path: string,
): Promise<string> {
	if (isAbsolute(path))
		throw Error("file path must be relative to the worktree");
	const root = await realpath(worktree);
	const candidate = resolve(root, path);
	if (candidate === root || !candidate.startsWith(`${root}${sep}`))
		throw Error("file path escapes the worktree");
	const parent = await realpath(resolve(candidate, ".."));
	if (
		relative(root, parent).startsWith("..") ||
		parent === resolve(root, ".git")
	)
		throw Error("file path escapes the worktree or enters .git");
	try {
		const stat = await lstat(candidate);
		if (stat.isSymbolicLink()) {
			const target = await realpath(candidate);
			if (target === root || !target.startsWith(`${root}${sep}`))
				throw Error("symlink escapes the worktree");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (
		candidate === resolve(root, ".git") ||
		candidate.startsWith(`${resolve(root, ".git")}${sep}`)
	)
		throw Error("file path enters .git");
	return candidate;
}
