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
	return protectedLocations.some((location) => {
		const protectedPath =
			typeof location === "string" ? location : location.path;
		if (!protectedPath) return false;
		const expression = protectedPath
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replaceAll("*", "[^/]*");
		return new RegExp(
			`^${expression}${protectedPath.endsWith("/") ? ".*" : ""}$`,
		).test(path);
	});
}
