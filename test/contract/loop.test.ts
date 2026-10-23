import assert from "node:assert/strict";
import test from "node:test";
import { readAudit } from "../../src/steward/audit.ts";
import { eventually, fixture, isolate } from "../support/harness.ts";

test("native repeat loop ticks twice on fake clock and commits heartbeat without a model request", async () => {
	isolate();
	let now = 1000;
	const timers = new Set<{ at: number; callback: () => void }>();
	const { harness } = await fixture({
		now: () => now,
		definition: {
			profile: "fixture",
			schedule: { pollSeconds: 1 },
			models: { steward: { provider: "faux", model: "one" } },
		},
		setTimer(callback, delay) {
			const timer = { at: now + delay, callback };
			timers.add(timer);
			return () => {
				timers.delete(timer);
			};
		},
	});
	try {
		harness.start();
		await eventually(async () => (await harness.snapshot()).ticks === 1);
		now = 2000;
		for (const timer of [...timers])
			if (timer.at <= now) {
				timers.delete(timer);
				timer.callback();
			}
		await eventually(async () => (await harness.snapshot()).ticks === 2);
		assert.equal((await harness.snapshot()).heartbeat, 2000);
		await harness.pause();
		now = 3000;
		for (const timer of [...timers])
			if (timer.at <= now) {
				timers.delete(timer);
				timer.callback();
			}
		await eventually(() =>
			readAudit("agent").some((event) => event.event === "paused"),
		);
		assert.equal((await harness.snapshot()).ticks, 2);
	} finally {
		await harness.close();
	}
});
test("native budget stop blocks input and records a persisted inbox transition", async () => {
	isolate();
	const { harness } = await fixture({
		definition: {
			profile: "fixture",
			limits: { dailyTokens: 0 },
			models: { steward: { provider: "faux", model: "one" } },
		},
	});
	try {
		harness.start();
		await eventually(async () => (await harness.snapshot()).budget.stopped);
		const id = (await harness.tree())[0].id;
		await assert.rejects(
			harness.submit(id, "hi", "budget", "followUp", "hash"),
			/budget exhausted/,
		);
		assert.equal((await harness.snapshot()).inbox[0].type, "budget-stop");
		assert.equal((await harness.snapshot()).ticks, 0);
	} finally {
		await harness.close();
	}
});
