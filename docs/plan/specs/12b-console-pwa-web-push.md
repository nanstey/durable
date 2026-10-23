# Spec 12b — PWA and Web Push (follow-up; blocks nothing)

Objective: make the console an installable web app and add best-effort Web Push for decision events. This is purely additive on the slice 8/11 console: it adds a manifest, a service worker, a push subscription store and VAPID handling, and enables the reserved `/api/push/*` routes. No daemon, API v1 or notifier change is needed.
Design refs: architecture D10 (channels), D13 (PWA-ready first release), D14 (HTTPS via Tailscale Serve); program design §2 (C6, N1, N2), §5.
New in revision 3 (Q16): split out of the old spec 12.
Depends on: spec 11 (HTTPS console on the tailnet); the slice 1 spike result for iOS/Android PWA and Web Push. Nothing else depends on this slice.

## Checklist
1. **Additive-only guard:** before any change, run the slice 8 PWA-readiness tests (same-origin relative URLs, CSP with `worker-src 'self'` and `manifest-src 'self'`, reserved `/api/push/*` returning 501, `push.enabled: false`) and record them as the baseline; they must still pass at the end. A test asserts this slice modifies no file under `api/`, `steward/` or `notify/` (additive-only check in the PR checklist).
2. **PWA:** `web/manifest.webmanifest`, icons, `web/sw.js` caching the **static shell only** (never API responses, transcripts or any authenticated data; versioned cache; clean-up on update), install flow documented (iOS 16.4+: Add to Home Screen; Android install prompt). Acceptance: manifest/service-worker tests; offline shows an "offline" shell and no stale data.
3. **VAPID and subscription store:** `durable console push-keys init` generates a VAPID key pair into `~/.config/durable/console/vapid.json` (0600, `version: 1`); subject from `console.yaml push.subject` (machine-local mailto placeholder); `push-subscriptions.json` (0600) holds endpoints and keys; `push.enabled: true` switches the feature on. Acceptance: file modes; keys never printed; schema tests.
4. **Push routes (same guard, allowlisted user):** `/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/test`. Acceptance: guard/CSRF tests; subscriptions limited per user; unsubscribe on 404/410 from the push service.
5. **Sender:** `console/push.ts` (lazy optional `web-push`): subscribes to each daemon's `inbox` SSE frames and sends pushes for `approval-needed`, `escalation`, `budget-stop`, `agent-down` and device-offline. Payload: agent label, event, PR number or short id; **no nonce, no body text, no secrets**. Honors the notifier's quiet hours and de-dup keys (the console de-dups by inbox event id). Acceptance: stub push endpoint tests; payload redaction test; dedup test; missing `web-push` module degrades to inbox-only with a clear status.
6. **Tap handling:** a notification opens the console at the relevant item (approvals inbox if 12a shipped, else the agent view). Acceptance: service-worker click test.
7. **Docs:** requirements (HTTPS via Tailscale Serve, outbound internet from the console host, iOS installed-app requirement), privacy note (payloads transit the browser vendor's push service, encrypted to the browser), how to remove subscriptions and rotate VAPID keys, fallback when push does not work (inbox badge, GitHub mobile to a different login).
8. **Live:** install on a phone, subscribe, trigger `approval-needed` and `escalation` test events, confirm latency and payload; test with the console host offline (no push, no harm).

## Risk controls
- No authenticated data in service-worker caches. No secrets, nonces or message bodies in push payloads.
- The feature is off by default (`push.enabled: false`).
- If iOS or the chosen browser cannot receive pushes, the slice can stop after item 2 (install only) or be dropped; no other slice is affected.

## Out of scope
Approvals from a notification action, inbound action buttons, third-party push services (ntfy etc.), background sync of conversations.

## Done when
Additive-only checks and baseline tests pass; live phone test recorded (or the user drops push after the spike); user decides whether to keep it.
