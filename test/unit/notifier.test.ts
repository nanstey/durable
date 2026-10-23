import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Notifier } from "../../src/notify/notifier.ts";
import { parkStale } from "../../src/notify/stale.ts";
import { redactedPayload } from "../../src/notify/types.ts";
import type {
	DesktopNotice,
	NotifySendNotifier,
} from "../../src/platform/notifier.ts";

function setup(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "durable-notify-"));
	const previous = process.env.DURABLE_HOME;
	process.env.DURABLE_HOME = root;
	t.after(() => {
		if (previous === undefined) delete process.env.DURABLE_HOME;
		else process.env.DURABLE_HOME = previous;
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}
class FakeDesktop implements NotifySendNotifier {
	readonly nonceSafe = true;
	notices: DesktopNotice[] = [];
	async notify(event: DesktopNotice) {
		this.notices.push(event);
	}
}
test("notifier de-duplicates, redacts inbox payloads, and caps reminders", async (t) => {
	setup(t);
	let now = Date.UTC(2026, 0, 1, 12, 0);
	const desktop = new FakeDesktop();
	const inbox: unknown[] = [];
	const notifier = new Notifier({
		agent: "a",
		now: () => now,
		dedupTtlMs: 1000,
		desktop,
		inbox: (event) => {
			inbox.push(event);
		},
		definition: {
			profile: "p",
			notify: {
				"approval-needed": {
					channels: ["desktop", "inbox"],
					reminders: { afterMinutes: 1, everyMinutes: 1, max: 2 },
				},
			},
		},
		machine: {
			name: "machine",
			agents: ["a"],
			channels: { desktop: { kind: "desktop" }, inbox: { kind: "inbox" } },
		},
	});
	assert.equal(
		await notifier.notify({
			agent: "a",
			event: "approval-needed",
			target: "https://example.invalid/p/1",
			nonce: "secret",
		}),
		"sent",
	);
	assert.equal(
		await notifier.notify({
			agent: "a",
			event: "approval-needed",
			target: "https://example.invalid/p/1",
			nonce: "secret",
		}),
		"deduplicated",
	);
	assert.equal(desktop.notices[0].nonce, "secret");
	assert.equal("nonce" in (inbox[0] as object), false);
	now += 60_000;
	await notifier.due();
	now += 60_000;
	await notifier.due();
	now += 60_000;
	await notifier.due();
	assert.equal(desktop.notices.length, 3);
	assert.deepEqual(
		redactedPayload({
			agent: "a",
			event: "digest",
			nonce: "secret",
			title: "only title",
		}),
		{ agent: "a", event: "digest", priority: "normal", title: "only title" },
	);
});
test("notifier holds quiet-hour notifications until delivery is allowed", async (t) => {
	setup(t);
	let now = Date.UTC(2026, 0, 1, 23, 0);
	const desktop = new FakeDesktop();
	const notifier = new Notifier({
		agent: "a",
		now: () => now,
		desktop,
		definition: {
			profile: "p",
			schedule: { quietHours: "22:00-08:00 UTC" },
			notify: { escalation: ["desktop"] },
		},
		machine: {
			name: "machine",
			agents: ["a"],
			channels: { desktop: { kind: "desktop" } },
		},
	});
	assert.equal(
		await notifier.notify({ agent: "a", event: "escalation" }),
		"held",
	);
	assert.equal(desktop.notices.length, 0);
	now = Date.UTC(2026, 0, 2, 8, 0);
	await notifier.due();
	assert.equal(desktop.notices.length, 1);
});
test("release nonce delivery bypasses unsafe channels, persistence, quiet-hour queues and dedup", async (t) => {
	setup(t);
	const desktop = new FakeDesktop();
	let inbox = 0;
	const options = {
		agent: "a",
		definition: {
			profile: "p",
			schedule: { quietHours: "00:00-00:00 UTC" },
			notify: { "approval-needed": ["desktop", "inbox", "github"] },
		},
		machine: {
			name: "machine",
			agents: ["a"],
			channels: {
				desktop: { kind: "desktop" as const },
				inbox: { kind: "inbox" as const },
				github: { kind: "github" as const, targetLogin: "operator-login" },
			},
		},
		inbox: () => {
			inbox++;
		},
	};
	const notifier = new Notifier({ ...options, desktop });
	assert.equal(await notifier.approvalNonce("item", "release-code"), true);
	assert.equal(desktop.notices[0].nonce, "release-code");
	assert.equal(inbox, 0);
	assert.equal(
		JSON.stringify(notifier.status()).includes("release-code"),
		false,
	);
	const unsafe = new Notifier({
		...options,
		desktop: {
			nonceSafe: false,
			notify: async () => {
				throw Error("unsafe backend must never receive a nonce");
			},
		},
	});
	assert.equal(await unsafe.approvalNonce("item", "release-code"), false);
});
test("stale items are parked without a privileged action", async () => {
	const calls: string[] = [];
	const stale = await parkStale(
		"a",
		{ id: "42", updatedAt: 0, target: "https://example.invalid/i/42" },
		1,
		{
			park: async () => {
				calls.push("park");
			},
			releaseClaim: async () => {
				calls.push("release");
			},
			stopWorkers: async () => {
				calls.push("stop");
			},
			comment: async () => {
				calls.push("comment");
			},
			notify: async (event) => {
				calls.push(event.event);
			},
		},
		86400000,
	);
	assert.equal(stale, true);
	assert.deepEqual(calls, ["stop", "release", "park", "comment", "escalation"]);
});
