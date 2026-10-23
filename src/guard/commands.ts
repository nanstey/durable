/** Shared worker guardrail command policy. It is deliberately not a sandbox. */
export const blockedWorkerCommandPatterns: ReadonlyArray<RegExp> = [
	/(?:^|[;&|]\s*)cd\s+(?:--\s+)?(?:['"]?(?:\/|~|\.\.(?:\/|\s|$)))/i,
];

const ghGlobalOptions = new Set([
	"--repo",
	"-R",
	"--hostname",
	"--help",
	"--version",
]);
const gitValueOptions = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
]);
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const forbiddenPrivilegeFlags = ["--" + "admin", "--" + "force"];

function tokens(command: string) {
	return command.split(/\s+/).filter(Boolean);
}
function executable(token: string) {
	return token.slice(token.lastIndexOf("/") + 1);
}
function ghBlocked(args: string[]) {
	let index = 0;
	while (args[index]?.startsWith("-")) {
		const option = args[index++];
		if (ghGlobalOptions.has(option) && !option.includes("=")) index++;
	}
	const group = args[index++];
	const operation = args[index];
	if (group === "pr" && operation === "merge") return true;
	if (group !== "api")
		return args.some((arg) => forbiddenPrivilegeFlags.includes(arg));
	const api = args.slice(index);
	const mutation = api.some((arg) => /(?:^|[^\w])mutation\b/i.test(arg));
	const method = api.find((arg, position) =>
		["-X", "--method"].includes(arg)
			? Boolean(api[position + 1])
			: arg.startsWith("-X") || arg.startsWith("--method="),
	);
	const methodValue = method?.startsWith("--method=")
		? method.slice("--method=".length)
		: method?.startsWith("-X") && method.length > 2
			? method.slice(2)
			: method
				? api[api.indexOf(method) + 1]
				: undefined;
	return (
		mutation ||
		api.some((arg) => /\/merge(?:$|[/?])/.test(arg)) ||
		(methodValue !== undefined &&
			mutatingMethods.has(methodValue.toUpperCase())) ||
		api.some((arg) =>
			/^(?:-f|-F|--field|--raw-field|--input)(?:=|.|$)/.test(arg),
		)
	);
}
function gitBlocked(args: string[]) {
	let index = 0;
	while (args[index]?.startsWith("-")) {
		const option = args[index++];
		if (gitValueOptions.has(option) && !option.includes("=")) index++;
	}
	const operation = args[index];
	return (
		["push", "merge", "rebase", "worktree", "switch", "checkout"].includes(
			operation,
		) ||
		(operation === "reset" && args.slice(index + 1).includes("--hard")) ||
		args.some((arg) =>
			forbiddenPrivilegeFlags.some(
				(flag) =>
					arg === flag ||
					arg.startsWith(`${flag}-with-lease`) ||
					arg.startsWith(`${flag}=`),
			),
		)
	);
}

/** Parse argv-like command text so global options and absolute shim bypasses cannot evade it. */
export function blockedWorkerCommand(command: string): boolean {
	if (blockedWorkerCommandPatterns.some((pattern) => pattern.test(command)))
		return true;
	const values = tokens(command);
	for (let index = 0; index < values.length; index++) {
		const tool = executable(values[index]);
		if (tool === "gh" && ghBlocked(values.slice(index + 1))) return true;
		if (tool === "git" && gitBlocked(values.slice(index + 1))) return true;
	}
	return false;
}
