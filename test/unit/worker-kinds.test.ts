import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentDef,
	MachineCfg,
	WorkerKind,
} from "../../src/config/schema.ts";
import {
	assertRoleDispatchReady,
	effectiveKind,
} from "../../src/identity/skills.ts";

const pi = "pi-session";
const durable = "durable-conversation";
const cases: Array<
	[
		"linux" | "android",
		WorkerKind | undefined,
		WorkerKind | undefined,
		WorkerKind | undefined,
		boolean | undefined,
		WorkerKind,
		boolean,
	]
> = [
	["linux", undefined, undefined, undefined, false, pi, true],
	["linux", undefined, undefined, undefined, true, pi, true],
	["linux", pi, durable, undefined, true, durable, true],
	["linux", pi, durable, undefined, false, durable, false],
	["linux", durable, undefined, undefined, true, durable, true],
	["linux", durable, undefined, pi, true, pi, true],
	["linux", pi, undefined, durable, true, durable, true],
	["linux", pi, undefined, durable, false, durable, false],
	["android", undefined, undefined, undefined, undefined, durable, true],
	["android", undefined, pi, undefined, undefined, pi, true],
];
for (const [
	index,
	[os, globalKind, definitionKind, machineKind, enabled, expected, allowed],
] of cases.entries()) {
	test(`worker-kind truth table row ${index + 1}`, () => {
		const def: AgentDef = {
			profile: "work",
			workers: {
				kind: globalKind,
				roles: { worker: { kind: definitionKind } },
				durable:
					enabled === undefined
						? {}
						: { enabledRoles: enabled ? ["worker"] : [] },
			},
		};
		const machine: MachineCfg = {
			name: "fixture",
			agents: [],
			platform: { os },
			workers: { roles: { worker: { kind: machineKind, skills: [] } } },
		};
		assert.equal(effectiveKind(def, machine, "worker"), expected);
		if (allowed)
			assert.doesNotThrow(() =>
				assertRoleDispatchReady(def, machine, "worker", "missing-fixture"),
			);
		else
			assert.throws(
				() =>
					assertRoleDispatchReady(def, machine, "worker", "missing-fixture"),
				/role-not-enabled/,
			);
	});
}
test("default profile opt-in is limited to in-process roles", () => {
	const def: AgentDef = {
		profile: "default",
		workers: { kind: durable, durable: { enabledRoles: ["worker"] } },
	};
	const machine: MachineCfg = {
		name: "fixture",
		agents: [],
		profiles: { allowDefault: true },
		workers: { roles: { reviewer: { kind: pi, skills: [] } } },
	};
	assert.doesNotThrow(() => assertRoleDispatchReady(def, machine, "worker"));
	assert.doesNotThrow(() => assertRoleDispatchReady(def, machine, "steward"));
	assert.throws(
		() => assertRoleDispatchReady(def, machine, "reviewer"),
		/named profile/,
	);
});
