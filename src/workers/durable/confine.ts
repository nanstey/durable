import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function assertInside(root: string, path: string): void {
	const fromRoot = relative(root, path);
	if (
		fromRoot === ".." ||
		fromRoot.startsWith(`..${sep}`) ||
		isAbsolute(fromRoot)
	)
		throw Error("file path escapes the worktree");
	if (fromRoot === ".git" || fromRoot.startsWith(`.git${sep}`))
		throw Error("file path enters .git");
}

/** File-tool realpath checks are enforced; bash remains an advisory guardrail. */
export async function confinedPath(
	worktree: string,
	path: string,
): Promise<string> {
	if (isAbsolute(path))
		throw Error("file path must be relative to the worktree");
	const root = await realpath(worktree);
	const candidate = resolve(root, path);
	if (candidate === root) throw Error("file path must name a worktree file");
	assertInside(root, candidate);
	assertInside(root, await realpath(resolve(candidate, "..")));
	try {
		if ((await lstat(candidate)).isSymbolicLink())
			assertInside(root, await realpath(candidate));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return candidate;
}
