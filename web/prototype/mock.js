// PROTOTYPE mock data shaped like the Durable console API. Fixed "now" keeps screenshots stable.
export const NOW = Date.parse("2026-10-24T18:01:00Z");
const m = (min) => NOW - min * 60000;

export const devices = [
	{ id: "demo-machine", status: "online", checkedAt: m(0), version: "0.0.0", agent: "demo", org: "demo-org", scopes: ["read", "steer", "pause", "approve"], budget: { day: "2026-10-24", spent: 4.82, cap: 20, tokens: 412000, stopped: false }, paused: false, inbox: 3 },
	{ id: "laptop-termux", status: "online", checkedAt: m(1), version: "0.0.0", agent: "demo", org: "demo-org", scopes: ["read", "steer"], budget: { day: "2026-10-24", spent: 19.4, cap: 20, tokens: 1800000, stopped: false }, paused: true, inbox: 0 },
	{ id: "build-box", status: "offline", checkedAt: m(47), version: "0.0.0", agent: "demo", org: "demo-org", scopes: ["read"], budget: { day: "2026-10-24", spent: 0, cap: 20, tokens: 0, stopped: false }, paused: false, inbox: 1 },
];

// Conversation tree. kind: steward|chat|scout|worker|reviewer. status: running|idle|waiting-followup|held|holding|done|interrupted|error
export const nodes = [
	{ id: "st-1", parentId: null, kind: "steward", status: "idle", item: null, startedAt: m(380), caps: { attach: true, steer: true, interrupt: false } },
	{ id: "sc-7", parentId: "st-1", kind: "scout", status: "done", item: "#98 flaky retry test", startedAt: m(120), caps: { attach: true } },
	{ id: "wk-101", parentId: "st-1", kind: "worker", status: "running", item: "#101 add retry backoff", startedAt: m(64), caps: { attach: true, steer: true, interrupt: true } },
	{ id: "rv-101", parentId: "wk-101", kind: "reviewer", status: "done", item: "#101 review", startedAt: m(12), caps: { attach: true } },
	{ id: "wk-103", parentId: "st-1", kind: "worker", status: "held", item: "#103 migrate config loader", startedAt: m(200), caps: { attach: true, steer: true, interrupt: true } },
	{ id: "wk-104", parentId: "st-1", kind: "worker", status: "error", item: "#104 bump deps", startedAt: m(30), caps: { attach: true } },
	{ id: "ch-2", parentId: null, kind: "chat", status: "waiting-followup", item: null, name: "Triage planning", startedAt: m(50), caps: { attach: true, steer: true, interrupt: true } },
];

// Work items / queue. gate.state: waiting-approval|passed|failing|none. outcome: held|merged|stopped|parked|null
export const items = [
	{ id: 101, title: "Add retry backoff to connector client", repo: "durable/demo-repository", pr: 412, sha: "9f3c2ab", attempts: 1, outcome: null, gate: { state: "waiting-approval", reasons: ["Touches network retry policy", "Diff +184 −22 in 6 files"] }, review: { verdict: "approved", notes: "Tests cover jitter bounds; no secrets touched." }, ci: "passing", createdAt: m(95) },
	{ id: 103, title: "Migrate config loader to typebox", repo: "durable/demo-repository", pr: 409, sha: "41de7c0", attempts: 2, outcome: "held", gate: { state: "none", reasons: [] }, review: null, ci: "pending", createdAt: m(260) },
	{ id: 104, title: "Bump dependencies", repo: "durable/demo-repository", pr: null, sha: null, attempts: 3, outcome: "stopped", gate: { state: "failing", reasons: ["Lockfile conflict"] }, review: null, ci: "failing", createdAt: m(40) },
	{ id: 98, title: "Fix flaky retry test", repo: "durable/demo-repository", pr: 398, sha: "ab12f90", attempts: 1, outcome: "merged", gate: { state: "passed", reasons: [] }, review: { verdict: "approved" }, ci: "passing", createdAt: m(700) },
	{ id: 107, title: "Document org policy bundle", repo: "durable/demo-repository", pr: null, sha: null, attempts: 0, outcome: null, gate: { state: "none", reasons: [] }, review: null, ci: null, createdAt: m(15), queued: true },
	{ id: 108, title: "Improve metrics empty states", repo: "durable/demo-repository", pr: null, sha: null, attempts: 0, outcome: "parked", gate: { state: "none", reasons: [] }, review: null, ci: null, createdAt: m(10), queued: true },
];

export const inbox = [
	{ id: "i1", level: "approval", text: "PR #412 is waiting for your passkey approval.", at: m(11), read: false },
	{ id: "i2", level: "warn", text: "Worker wk-104 stopped after 3 failed attempts (lockfile conflict).", at: m(26), read: false },
	{ id: "i3", level: "info", text: "Item #98 merged. Cycle time 41 min.", at: m(212), read: false },
	{ id: "i4", level: "info", text: "Budget at 97% on laptop-termux; agent paused.", at: m(300), read: true },
];

export const metrics = {
	window: "30d",
	prsOpened: 38, prsMerged: 31, autonomy: 0.82, cycleTimeMs: 41 * 60000, costPerPr: 0.64,
	// daily PRs merged and spend over 30 days
	merged: [0,1,0,2,1,1,0,0,2,1,1,2,0,1,1,3,1,0,0,2,1,1,2,1,0,1,2,1,1,3],
	spend: [2.1,3.4,1.2,5.6,4.4,3.9,0.8,0.5,6.1,4.0,3.3,5.2,1.9,3.1,4.2,7.8,3.6,1.1,0.9,5.5,4.1,3.8,5.9,3.2,1.7,3.5,5.1,4.6,4.0,4.82],
};

export const transcript = [
	{ role: "user", at: m(70), text: "Pick up #101. Retry backoff should use full jitter and cap at 30s." },
	{ role: "agent", at: m(69), text: "On it. I'll read `src/connectors/client.ts`, then add a `backoff()` helper with tests." },
	{ role: "tool", at: m(68), name: "read", arg: "src/connectors/client.ts", result: "212 lines" },
	{ role: "tool", at: m(60), name: "edit", arg: "src/connectors/backoff.ts", result: "+48 −0" },
	{ role: "agent", at: m(58), text: "Added helper:\n\n```ts\nexport function backoff(attempt: number, cap = 30_000) {\n  const ceil = Math.min(cap, 250 * 2 ** attempt);\n  return Math.random() * ceil;\n}\n```\n\nNow wiring it into `request()` and writing tests." },
	{ role: "tool", at: m(52), name: "bash", arg: "node --test test/unit/backoff.test.ts", result: "12 passed" },
	{ role: "steer", at: m(44), text: "Also log each retry at debug level, no payloads." },
	{ role: "agent", at: m(43), text: "Done. Retries log `attempt`, `delayMs`, and `status` only. Opening a draft PR." },
	{ role: "system", at: m(41), text: "Draft PR #412 opened · CI passing · review approved" },
];

export const connectors = [
	{ id: "github", kind: "GitHub", status: "ok", detail: "durable/demo-repository" },
	{ id: "linear", kind: "Linear", status: "ok", detail: "DUR team" },
	{ id: "slack", kind: "Slack", status: "degraded", detail: "rate limited, retry in 40s" },
];

export const org = { name: "demo-org", policy: "bundle v7", members: 3, pausedAll: false };

export const fmtAgo = (t) => { const s = Math.round((NOW - t) / 60000); return s <= 0 ? "now" : s < 60 ? `${s}m` : `${Math.round(s / 60)}h`; };
export const money = (n) => `$${n.toFixed(2)}`;
