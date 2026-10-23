import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createApi } from "../../src/api/routes.ts";
import { createToken } from "../../src/api/tokens.ts";
import { FakeDispatcher } from "../../src/dispatch/fake.ts";
import { OrcaDispatcher } from "../../src/dispatch/orca.ts";
import { fixture, isolate } from "../support/harness.ts";

for (const adapter of ["orca", "fallback"])
	test(`conversation open API uses ${adapter} viewer and requires read scope`, async () => {
		const home = isolate();
		const { harness } = await fixture();
		const calls = join(home, "calls");
		const command = join(home, "orca-stub");
		writeFileSync(
			command,
			`#!${process.execPath}\nconst fs=require('node:fs'); const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');console.log(a[1]==='list'?'[]':JSON.stringify({id:'viewer'}));\n`,
		);
		chmodSync(command, 0o700);
		try {
			const id = (await harness.tree())[0].id;
			const app = createApi({
				agent: "agent",
				machine: "fixture",
				profile: "fixture",
				harness,
				definition: { profile: "fixture" },
				dispatcher:
					adapter === "orca"
						? new OrcaDispatcher(command)
						: new FakeDispatcher(),
				viewerWorkspace: { id: "viewer", path: home, branch: "" },
			});
			const read = createToken("agent", "read", ["read"]);
			const chat = createToken("agent", "chat", ["chat"]);
			assert.equal(
				(
					await app.request(`/v1/conversations/${id}/open`, {
						method: "POST",
						headers: { authorization: `Bearer ${chat}` },
					})
				).status,
				403,
			);
			const response = await app.request(`/v1/conversations/${id}/open`, {
				method: "POST",
				headers: { authorization: `Bearer ${read}` },
			});
			assert.equal(response.status, 200);
			if (adapter === "orca") {
				assert.deepEqual(await response.json(), {
					kind: "orca-terminal",
					handle: "viewer",
				});
				const args = readFileSync(calls, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				assert.deepEqual(args[0].slice(0, 2), ["terminal", "list"]);
				assert.ok(args[1].includes(`durable attach agent/${id}`));
			} else
				assert.deepEqual(await response.json(), {
					kind: "command",
					command: `durable attach agent/${id}`,
				});
		} finally {
			await harness.close();
		}
	});
