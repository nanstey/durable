import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const forbidden = [
	["home path", ["", "home", "fabricated", "file"].join("/")],
	["user path", ["", "Users", "fabricated", "file"].join("/")],
	["email", ["operator", "private.invalid"].join("@")],
	["PAT", `ghp_${"X".repeat(36)}`],
	["OAuth", `gho_${"X".repeat(36)}`],
	["fine grained", `github_pat_${"X".repeat(40)}`],
	["provider key", `sk-${"X".repeat(40)}`],
	["Anthropic key", `sk-ant-${"X".repeat(40)}`],
	["AWS", `AKIA${"X".repeat(16)}`],
	["private key", ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
	["tailnet name", ["machine", "tailnet", "ts", "net"].join(".")],
	["CGNAT", [100, 127, 0, 1].join(".")],
];
for (const [label, text] of forbidden) {
	test(`hygiene rejects ${label} without echoing content`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "durable-hygiene-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "fixture.txt"), text);
		const result = spawnSync(
			process.execPath,
			[resolve("scripts/hygiene-scan.mjs"), root],
			{ encoding: "utf8", timeout: 5000 },
		);
		assert.equal(result.status, 1, result.stderr);
		assert.equal(result.stderr.includes(text), false);
	});
}
for (const [file, text, status] of [
	[".env", "PLACEHOLDER=value", 1],
	["profile.env", "PLACEHOLDER=value", 1],
	["examples/machine.yaml", "name: real-machine", 1],
	["examples/machine.yaml", "name: <machine-label>", 0],
	[
		"example.txt",
		"operator@example.invalid operator@example.com <console-host> <operator-login> acme/api",
		0,
	],
	["example.txt", [100, 128, 0, 1].join("."), 0],
] as const) {
	test(`hygiene fixture ${file}: ${status}`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "durable-hygiene-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), text);
		const result = spawnSync(
			process.execPath,
			[resolve("scripts/hygiene-scan.mjs"), root],
			{ encoding: "utf8", timeout: 5000 },
		);
		assert.equal(result.status, status, result.stderr);
	});
}
