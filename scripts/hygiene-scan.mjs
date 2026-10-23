import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if ([".git", "node_modules"].includes(entry.name)) return [];
		const path = join(dir, entry.name);
		return entry.isDirectory()
			? walk(path)
			: entry.isFile()
				? [relative(root, path)]
				: [];
	});
}
const files = process.argv[2]
	? walk(root)
	: execFileSync(
			"git",
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, encoding: "utf8" },
		)
			.split("\0")
			.filter(Boolean);
const allowPath = join(root, "scripts/hygiene-allow.txt");
const allowed = new Set();
if (existsSync(allowPath)) {
	for (const line of readFileSync(allowPath, "utf8").split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		const [path, reason] = line.split(/\s+#\s+/, 2);
		if (!reason) throw new Error("hygiene exceptions require a reason");
		allowed.add(path);
	}
}
const patterns = [
	["home path", /\/(?:home|Users)\/[A-Za-z0-9._-]+/],
	[
		"token",
		/(?:gh[pou]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})/,
	],
	["private key", /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/],
	[
		"tailnet",
		/[A-Za-z0-9.-]+\.ts\.net|\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})\b/,
	],
];
let failed = false;
for (const file of new Set(files)) {
	if (allowed.has(file) || file === "scripts/hygiene-allow.txt") continue;
	const path = join(root, file);
	if (!existsSync(path) || !lstatSync(path).isFile()) continue;
	const data = readFileSync(path, "utf8");
	const reasons = [];
	if (/(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.env)$/.test(file))
		reasons.push("env file");
	for (const [label, pattern] of patterns)
		if (pattern.test(data)) reasons.push(label);
	for (const email of data.match(
		/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
	) ?? []) {
		if (email !== "git@github.com" && !/@example\.(?:invalid|com)$/.test(email))
			reasons.push("email");
	}
	if (/examples\/.*(?:machine|console)/.test(file)) {
		for (const line of data.split("\n")) {
			const match =
				/^\s*(?:host|hostname|name|rpId|tailnetAddress):\s*["']?([^\s"'#]+)/.exec(
					line,
				);
			if (
				match &&
				!match[1].startsWith("<") &&
				!["loopback", "localhost"].includes(match[1])
			)
				reasons.push("non-placeholder host");
		}
	}
	if (reasons.length) {
		// Report locations and categories only, never matching credential contents.
		console.error(
			`hygiene failure: ${file}: ${[...new Set(reasons)].join(", ")}`,
		);
		failed = true;
	}
}
process.exitCode = failed ? 1 : 0;
