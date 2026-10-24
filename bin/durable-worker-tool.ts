#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execa } from "execa";
import { workerFenced } from "../pi-extension/durable-worker-guard.ts";
import { blockedWorkerCommand } from "../src/guard/commands.ts";
import { checkWorkerClaim } from "../src/identity/claimFence.ts";
import { audit, setAuditIdentity } from "../src/steward/audit.ts";
import { prFooter, prMarker } from "../src/steward/github.ts";
import { disabled } from "../src/steward/killswitch.ts";

const [tool, executable, ...input] = process.argv.slice(2);
const agent = process.env.DURABLE_AGENT;
const item = process.env.DURABLE_ITEM;
const profile = process.env.DURABLE_PROFILE;
const login = process.env.DURABLE_LOGIN;
if (
	!agent ||
	!item ||
	!profile ||
	!login ||
	!executable ||
	!["gh", "git"].includes(tool ?? "")
)
	throw Error("worker identity unavailable");
setAuditIdentity(agent, profile, login);
if (workerFenced() || disabled(agent))
	throw Error("worker operation refused: item fenced or agent paused");
if (blockedWorkerCommand([tool, ...input].join(" ")))
	throw Error("protected worker command refused");
const args = [...input];
let operationIndex = 0;
if (tool === "git") {
	while (args[operationIndex]?.startsWith("-")) {
		operationIndex += ["-C", "-c", "--git-dir", "--work-tree"].includes(
			args[operationIndex],
		)
			? 2
			: 1;
	}
}
const operation = args[operationIndex];
if (tool === "git" && operation === "commit") {
	if (args.some((arg) => arg === "--author" || arg.startsWith("--author=")))
		throw Error("worker commits must use the manifest identity");
	args.push("--trailer", `Durable-Agent: ${agent}`);
}
if (tool === "git" && operation === "push") {
	const branch = process.env.DURABLE_BRANCH ?? `durable/${agent}/${item}`;
	const allowedFlags = new Set([
		"-u",
		"--set-upstream",
		"--porcelain",
		"--dry-run",
	]);
	const push = args.slice(operationIndex + 1);
	if (push.some((arg) => arg.startsWith("-") && !allowedFlags.has(arg)))
		throw Error("unsupported worker push option");
	const operands = push.filter((arg) => !arg.startsWith("-"));
	if (
		operands.length !== 2 ||
		operands[0] !== "origin" ||
		![branch, `HEAD:${branch}`, `HEAD:refs/heads/${branch}`].includes(
			operands[1],
		)
	)
		throw Error("push requires origin and only the explicit item branch");
}
if (tool === "gh" && args[0] === "pr" && args[1] === "create") {
	if (
		args.includes("--fill") ||
		args.includes("--fill-first") ||
		args.includes("--fill-verbose")
	)
		throw Error("draft PR requires an explicit body");
	let body = "";
	for (const flag of ["--body", "-b", "--body-file", "-F"]) {
		const at = args.indexOf(flag);
		if (at < 0) continue;
		const value = args[at + 1];
		if (!value || value === "-")
			throw Error("draft PR body must be supplied by value or file");
		body =
			flag === "--body" || flag === "-b" ? value : readFileSync(value, "utf8");
		args.splice(at, 2);
	}
	args.push(
		"--draft",
		"--head",
		process.env.DURABLE_BRANCH ?? `durable/${agent}/${item}`,
		"--label",
		`durable/agent:${agent}`,
		"--body",
		`${body}\n\n${prFooter(agent, login)}\n${prMarker(agent, item)}`,
	);
}
// Treat unknown gh commands as writes, rather than silently omitting an audit line.
const read =
	tool === "git"
		? operation !== "push"
		: ["view", "list", "status", "diff", "checks"].includes(args[1] ?? "") ||
			(args[0] === "api" &&
				!args.some((arg) =>
					[
						"-X",
						"--method",
						"-f",
						"-F",
						"--field",
						"--raw-field",
						"--input",
					].includes(arg),
				));
if (!read) await checkWorkerClaim(process.env);
if (!read)
	audit(agent, {
		event: "github-write-intent",
		item,
		tool,
		operation: args[0],
	});
const result = await execa(executable, args, {
	stdio: "inherit",
	reject: false,
	extendEnv: false,
	env: process.env,
});
if (!read)
	audit(agent, {
		event: "github-write",
		item,
		tool,
		operation: args[0],
		ok: result.exitCode === 0,
	});
process.exitCode = result.exitCode ?? 1;
