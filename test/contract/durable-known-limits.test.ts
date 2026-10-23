import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	assertCommand,
	DurableFileTools,
} from "../../src/workers/durable/tools.ts";
import { durableRig } from "../support/durable.ts";
import { eventually } from "../support/harness.ts";

const shellCall = (command: string) =>
	fauxAssistantMessage(fauxToolCall("bash", { command }), {
		stopReason: "toolUse",
	});
const node = (script: string) => `node -e '${script.replaceAll("'", "'\\''")}'`;

test("enforced file guard rejects absolute/traversal, symlink directories and symlinks into .git; ordinary guarded shell commands are refused", async () => {
	const rig = await durableRig();
	try {
		const tools = new DurableFileTools(rig.checkout);
		mkdirSync(join(rig.checkout, ".git", "nested"));
		writeFileSync(join(rig.checkout, ".git", "nested", "secret"), "no");
		symlinkSync(rig.home, join(rig.checkout, "outside"));
		symlinkSync(join(rig.checkout, ".git"), join(rig.checkout, "git-alias"));
		symlinkSync(
			join(rig.checkout, ".git", "nested", "secret"),
			join(rig.checkout, "secret-alias"),
		);
		for (const path of [
			"../escape",
			join(rig.home, "escape"),
			"outside/escape",
			".git/nested/secret",
			"git-alias/nested/secret",
			"secret-alias",
		])
			for (const operation of [
				() => tools.read(path),
				() => tools.write(path, "no"),
				() => tools.edit(path, "no", "changed"),
			])
				await assert.rejects(operation);
		for (const command of [
			"cd /",
			"cd ..",
			"cd ../elsewhere",
			"git push origin main",
			"git merge main",
			"git rebase main",
			"git reset --hard HEAD",
			"git switch main",
			"git checkout main",
			"git worktree add ../new",
			"gh pr merge 1",
			"gh repo edit --admin",
			"git fetch --force",
		])
			assert.throws(() => assertCommand(command), /refused/);
		rig.faux.setResponses([shellCall("cd /"), fauxAssistantMessage("blocked")]);
		rig.harness.start();
		await eventually(async () =>
			(await rig.harness.tree()).some((n) => n.kind === "worker-durable"),
		);
		const id = (await rig.harness.tree()).find(
			(n) => n.kind === "worker-durable",
		)!.id;
		await eventually(async () =>
			JSON.stringify(await rig.harness.transcript(id)).includes("blocked"),
		);
		assert.equal(
			rig.processes.commands.length,
			0,
			"beforeTool refuses the shell invocation",
		);
	} finally {
		await rig.harness.close();
	}
});

test("known limits: interpreter, worktree script and absolute credential-file reads ARE possible; direct git push via interpreter is not prevented", async () => {
	const rig = await durableRig();
	const interpreterWrite = join(rig.home, "interpreter-outside");
	const scriptWrite = join(rig.home, "script-outside");
	const credentialRead = join(rig.home, "credential-read");
	const credentials = join(rig.home, "fabricated-credentials.json");
	writeFileSync(credentials, JSON.stringify({ token: "fixture-local-only" }));
	writeFileSync(
		join(rig.checkout, "outside.cjs"),
		`require("node:fs").writeFileSync(${JSON.stringify(scriptWrite)}, "outside access");`,
	);
	const readAndPush = `const fs=require("node:fs"); const cp=require("node:child_process"); const token=JSON.parse(fs.readFileSync(${JSON.stringify(credentials)},"utf8")).token; fs.writeFileSync(${JSON.stringify(credentialRead)},token); cp.execFileSync("git",["-C",${JSON.stringify(rig.checkout)},"-c","core.hooksPath=/dev/null","push",${JSON.stringify(rig.remote)},"HEAD:refs/heads/unguarded"],{env:{...process.env,GH_TOKEN:token}});`;
	rig.faux.setResponses([
		shellCall(
			node(
				`require("node:fs").writeFileSync(${JSON.stringify(interpreterWrite)},"outside access")`,
			),
		),
		shellCall("node outside.cjs"),
		shellCall(node(readAndPush)),
		fauxAssistantMessage("known limits observed"),
	]);
	try {
		rig.harness.start();
		await eventually(() => existsSync(credentialRead));
		await eventually(async () =>
			Boolean(await rig.github.remoteHead("acme/repo", "unguarded")),
		);
		assert.equal(readFileSync(interpreterWrite, "utf8"), "outside access");
		assert.equal(readFileSync(scriptWrite, "utf8"), "outside access");
		assert.equal(readFileSync(credentialRead, "utf8"), "fixture-local-only");
		assert.equal(
			rig.pushes(),
			0,
			"this deliberately bypassed the supported code-owned push tool",
		);
		assert.match(
			readFileSync("docs/evidence/slice-6c.md", "utf8"),
			/not a sandbox/,
		);
		assert.match(
			readFileSync(
				"docs/plan/specs/06c-durable-conversation-workers.md",
				"utf8",
			),
			/not prevented/,
		);
	} finally {
		await rig.harness.close();
	}
});
