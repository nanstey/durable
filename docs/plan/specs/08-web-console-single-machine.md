# Spec 08 — Web console, single machine (localhost), interactive chat, PWA-ready

Objective: a web console on this machine, bound to loopback, that shows the machine's agents and lets the operator **chat interactively** (live transcripts, follow-ups, steers, abort a turn, start and resume conversations), pause agents and read the audit log, built as a viewer/controller over the daemon API with no new authority. Responsive layout. Approve, agent resume, enroll and policy verification are not here (spec 12a). The first release is designed so that PWA and Web Push are purely additive later (spec 12b).
Design refs: architecture D13 (console, PWA-ready), D14 (browser auth, later), D15 (credential classes; console never approves here), D16 (chat); program design §1 (`console/*`, `web/`), §2 (C1-C7, CH1-CH7), §3.6, §3.9, §5 (`console/*`, `api/chat`, `web` rows).
New in revision 2 (U2). Revision 5: the console has one set of capabilities for every browser client; the narrow-viewport layout is a responsive-design requirement, not a capability difference (Q19); no default chat rate limits (Q20). Revision 3: chat moved in from the phone slices (Q17), PWA-readiness added (Q16), build-minimal confirmed (Q15).
Depends on: spec 03 (API v1, tokens, chat guardrails), spec 04 (typed client, conversations, inbox, notifier); richer with specs 05-07 (queue, workers, gate); spec 09 adds the shadow tab content.

## Checklist

1. **Decision record (Q15, revised by U3):** `docs/console.md` section "Console: our own, from scratch": what `dpi-playground` is (the hub + Vue web client in `disler/durable-pi`, about 6.6k lines with its SDK, experimental, built for that project's demos), why we do not reuse it (panels and toolchain we do not want, different trust model), and the decision: we write our own hub, client library and API; the dpi-* projects are inspiration only. A one-line "Inspired by" reference is the only mention; no code, no vendored files, no attribution obligations.
2. **Hub server** `console/{main,monitor,proxy,mux,guard,registry,routes}.ts`, written from scratch (ideas only: token-injecting proxy, one multiplexed SSE stream per tab, device status states):
   - `registry.ts`: devices from `~/.config/durable/console/devices.yaml` (mode 600). Seeded with the local machine's agents (reads `machine.yaml`; creates per-agent tokens with `durable token create --client console-local --scopes read,chat,pause`).
   - `monitor.ts`: status machine `checking -> online | offline | unauthorized | mismatch | incompatible`, backoff offline 1 s -> 30 s, human-fixable states 30 s or explicit check.
   - `proxy.ts`: REST proxy that **injects the daemon token server-side**; **route allowlist**: reads, `messages`, `abort`, conversations list/start, worker transcript/steer/interrupt, `pause`, inbox ack, and nothing else. No fs, shell, config, token, approval or passthrough routes (C2).
   - `mux.ts`: one SSE connection per browser tab; `PUT /api/stream/:id {subs}` with keys `<device>/agent/<aid>`, `<device>/steward`, `<device>/worker/<id>`; 20-key cap; `hello`, `fault`, `disconnected` frames.
   - `guard.ts`: Host allowlist, same-origin Origin check, JSON-only writes, CSRF header token (C4).
3. **Listener:** loopback (or unix socket) only. Systemd user unit `units/durable-console.service`; `durable console enable|status|disable` (installed and enabled by the CLI, never started by the skills-repo installer). Acceptance: bind test; installer test.
4. **Front end** `web/`, **no build step**: `index.html`, `app.js`, `views/*.js`, `style.css`, vendored `preact` + `htm` with `SHA256SUMS` verified by a test. CSP on every response: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'` (the worker/manifest directives are already present for 12b).
5. **Views:**
   - Fleet: machine -> agents with status, last tick, budget, kill-switch/pause state, dispatcher flags, inbox badge.
   - Agent: scout queue (reasons), claims, workers (with the capability badges the daemon reports), PRs and gate state, shadow tab shell, audit viewer, inbox read/ack.
   - **Conversation tree (revision 7):** machine -> agent -> a live tree of the steward, chat threads, scout conversations, Pi-session workers and durable child conversations (parent -> child) from `GET /v1/conversations?tree=true` and the `tree` frames, with status badges and per-node capabilities; selecting a node opens its transcript; "Open in Orca" is shown only when the daemon reports a viewer command (the console cannot call Orca itself, so it displays the `durable attach ...` command or the machine's `durable open` action).
   - **Chat (interactive):** live transcript for the steward `main`, chat threads, scout conversations and workers; composer with **follow-up** (default) and **steer** (when busy); **abort** the current turn; **new conversation** dialog offering only the kinds the daemon allows (`chat`, `scout`; a scout needs an item); **resume** any existing chat/scout conversation from a list; worker panes show a steer box only when the adapter reports `steer: true` and always offer interrupt; reviewer panes are view-only. Errors from the daemon (`invalid credential-like-content`, `501 not_supported`, and `429 rate_limited` with a countdown **only if the agent opted into a rate limit**) are shown inline and are not retried automatically.
   - Controls: pause per agent and interrupt per worker (confirm dialogs). **No agent resume, approve, enroll or policy trust** in this slice.
6. **Inert rendering (C3):** all conversation, issue, PR, audit and inbox text is created with `textContent`/text nodes, `white-space: pre-wrap`; no markdown, no `innerHTML`, no auto-links (a `github.com` URL gets an explicit "open" button with `rel="noopener noreferrer"`). Chat input is sent as plain text only (C7). Acceptance: headless DOM tests with hostile fixtures.
7. **Responsive layout (same capabilities at every size):** single column below 700 px, tap targets >= 44 px, composer pinned to the bottom, no hover-only controls, works one-handed. Acceptance: browser smoke at a phone viewport.
8. **PWA-readiness (Q16) — additive-later checklist:**
   - all URLs same-origin and relative (a test crawls the index and static assets and asserts it);
   - the CSP above (test asserts `worker-src` and `manifest-src` present, no inline script/style);
   - `Secure` cookie attribute applied when the request arrived over HTTPS (only used if any cookie exists; the design prefers header-based CSRF tokens);
   - routes `/api/push/*` reserved and answering `501 not-enabled`;
   - `console.yaml` schema already has `push: {enabled: false, subject: <mailto placeholder>}`; paths `vapid.json` and `push-subscriptions.json` (0600, `version: 1`) and their schemas are defined but nothing writes them yet;
   - the notifier's `console` channel and the `inbox` SSE frames already carry every event a push would need (no daemon change in 12b);
   - the decision on VAPID handling is recorded in `docs/console.md`: keys generated by `durable console push-keys init` (12b), private key 0600, `web-push` imported lazily as an optional dependency.
9. **Tests:** guard/proxy/mux unit tests; **token-never-in-browser** grep test; route-allowlist test; status-machine test with two stub daemons on different ports; CSP header test; `SHA256SUMS` test; chat UI tests (follow-up vs steer button states, abort, capability-gated steer, 429 countdown, screening error); PWA-readiness tests (item 8); browser smoke with `playwright-cli` against a faux daemon and the real steward (recorded in the PR; not in CI).
10. **Docs:** `docs/operator.md` section "console" (optional, not a hub; what chat can and cannot do; guardrails); `docs/console.md` (console modules, `web/`, unit); the thin skills-repo skill needs no change.

## Risk controls

- Console holds scoped daemon tokens only (`read`, `chat`, `pause`); it cannot approve, resume an agent, enroll or trust a policy.
- Chat is bounded by the daemon, not the console: credential screening, audit, a 1 MiB sanity ceiling, fixed tool set, enqueue-only `request_*` tools, plus the per-agent budgets and the kill switch (D16); no default rate limits, rate limiting is opt-in (Q20). A steer cannot bypass the gate, budgets or kill switch.
- No Funnel, no non-loopback listener in this slice.
- Untrusted text is inert; CSP forbids inline and remote script; third-party front-end libraries are pinned with checksums.
- Closing or killing the console never stops an agent; the CLI keeps working.
- No arbitrary shell/file access: the proxy route allowlist is the enforcement point and has its own test.

## Out of scope

Multi-machine registry and tailnet (spec 11), approvals/agent resume/enroll/policy verification (spec 12a), PWA manifest/service worker/Web Push implementation (spec 12b), session creation beyond `chat`/`scout`, starting workers or reviewers, model picking, state editing, directory browsing.

## Done when

CI green; smoke recorded; user has used the console for a day on one machine and chatted with an agent; PWA-readiness tests pass.
