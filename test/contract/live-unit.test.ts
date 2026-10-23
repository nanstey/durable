import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { execa } from "execa";
import { recursivelyEmpty } from "../../src/platform/systemdContainment.ts";
import { eventually } from "../support/harness.ts";
import { liveContainment } from "../support/live.ts";

test("real user service KillMode control-group removes direct tool children after main SIGKILL", {
	skip: !liveContainment,
	timeout: 10000,
}, async () => {
	const unit = `durable-unit-test-${randomUUID()}`;
	const ctl = (args: string[]) =>
		execa("systemctl", ["--user", ...args], { reject: false, timeout: 3000 });
	try {
		await execa(
			"systemd-run",
			[
				"--user",
				"--collect",
				"--quiet",
				"--unit",
				unit,
				"--property=KillMode=control-group",
				"/bin/sh",
				"-c",
				"sleep 300 & sleep 300; wait",
			],
			{ timeout: 3000 },
		);
		let group = "";
		await eventually(async () => {
			group = (
				await ctl(["show", unit, "--property=ControlGroup", "--value"])
			).stdout.trim();
			return Boolean(
				group &&
					existsSync(`/sys/fs/cgroup${group}/cgroup.procs`) &&
					readFileSync(`/sys/fs/cgroup${group}/cgroup.procs`, "utf8")
						.trim()
						.split("\n").length >= 3,
			);
		});
		const pids = readFileSync(`/sys/fs/cgroup${group}/cgroup.procs`, "utf8")
			.trim()
			.split("\n");
		assert.equal(
			(await ctl(["kill", "--kill-whom=main", "--signal=KILL", unit])).exitCode,
			0,
		);
		await eventually(
			() =>
				!existsSync(`/sys/fs/cgroup${group}/cgroup.events`) ||
				recursivelyEmpty(
					readFileSync(`/sys/fs/cgroup${group}/cgroup.events`, "utf8"),
				),
		);
		for (const pid of pids) assert.equal(existsSync(`/proc/${pid}`), false);
	} finally {
		await ctl(["stop", unit]);
		await ctl(["reset-failed", unit]);
	}
});
