# Slice 12a evidence

| Spec item | Status | Evidence |
| --- | --- | --- |
| Daemon-verified passkeys | Implemented | `src/approval/webauthn.ts` uses pinned `@simplewebauthn/server`; challenges are action/item/binding-bound, short-lived and consumed before verification. |
| Enrollment and key management | Implemented | `durable approval enroll|list|revoke`; first enrollment uses a short-lived TTY code. |
| Console conduit | Implemented | `web/app.js` asks for an explicit browser passkey gesture and `src/console/proxy.ts` forwards approval calls without a daemon bearer token. |
| Approval and release | Implemented | `src/api/routes.ts` derives current head SHA or hold epoch before issuing and again before accepting an assertion. |
| Live phone/desktop drill | Pending operator | Enroll a phone passkey over the configured HTTPS console; approve a human-approval PR from phone and desktop, resume a paused agent, verify a fixture policy, and record desktop/command audit notifications. Live phone passkey result: **pending operator**. |

## Threat model and recovery

Passkeys protect high-risk approval, hold release, and resume actions from bearer-token theft and console-only compromise. They do not protect against a same-OS-user attacker that can alter the daemon, a compromised console that misleads the operator, a stolen unlocked passkey device, or a compromised tailnet node. The signed daemon challenge binds the intended action and current item state; use the GitHub link to independently inspect the PR.

If a passkey is lost, run `durable approval list <agent>`, then `durable approval revoke <agent> <credential-id>` on the daemon machine and enroll a replacement with `durable approval enroll <agent>` at a TTY. Chat, steering and pause remain scoped, rate-limited and audited controls; they are not passkey approvals.

Android has no nonce-safe notification channel. With no enrolled passkey it must report approval as unavailable and direct the operator to merge in GitHub; it never exposes a notification nonce fallback.
