export type ProtectedLocation = { path?: string } | string;

const OWNER_PATHS = new Set([
	"CODEOWNERS",
	".github/CODEOWNERS",
	"docs/CODEOWNERS",
]);

/** Paths which are never eligible for an automatic merge. */
export function isHardPath(
	path: string,
	protectedLocations: readonly ProtectedLocation[] = [],
): boolean {
	if (OWNER_PATHS.has(path) || path.startsWith(".github/")) return true;
	return protectedLocations.some((location) =>
		typeof location === "string" ? location === path : location.path === path,
	);
}
