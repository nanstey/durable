# Slice 12a evidence

| Spec item | Status | Evidence |
| --- | --- | --- |
| Daemon-verified passkeys | Implemented | `src/approval/webauthn.ts` uses pinned `@simplewebauthn/server`; byte-preserving challenges are action/item/binding-bound, short-lived, single-use, capped, and tested in `test/unit/approval.test.ts`. |
| Enrollment and key management | Implemented | `durable approval enroll|list|revoke`; first enrollment uses a short-lived TTY code and additional enrollment starts with an existing-key assertion. |
| Console conduit | Implemented | `web/app.js` uses `credential.toJSON()` after an explicit gesture; `src/console/proxy.ts` forwards approval calls without a daemon bearer token. |
| Approval and release | Implemented | `src/api/routes.ts` derives current head SHA or hold epoch before issuing and again before accepting an assertion; bearer credentials are rejected. |
| Live phone/desktop drill | Pending operator | Enroll a phone passkey over the configured HTTPS console; approve a human-approval PR from phone and desktop, resume a paused agent, verify a fixture policy, and record desktop/command audit notifications. Live phone passkey result: **pending operator**. |

## Review remediation

| Finding | Status | Regression evidence |
| --- | --- | --- |
| H1 challenge encoding | Fixed | Stored challenge bytes equal browser options (`test/unit/approval.test.ts`). |
| H2 credential serialization | Fixed | Console source assertion in `test/unit/console.test.ts`. |
| H3 second-key authorization | Fixed | Existing key receives assertion ceremony before registration (`test/unit/approval.test.ts`). |
| H4 synced counters | Fixed | Relies on SimpleWebAuthn clone detection; no stricter local counter comparison. |
| H5 missing coverage | Fixed | `test/support/authenticator.ts` generates real ES256 credentials, COSE keys, authenticator data and signatures. `test/unit/webauthn-fixtures.test.ts` exercises registration/code expiry and single use, second-key proof, revoke, valid and zero-counter assertions, wrong origin/RP ID, replayed counter, reused/expired challenge, stale SHA/policy fingerprint, wrong item, revoked key, release cross-item/action replay and older hold epoch. `test/contract/webauthn.test.ts` covers the unauthenticated second-key route, all bearer scopes/header forms on approval routes, successful enrollment/resume audits and payload redaction. Live device drills remain separate. |
| M6 policy fingerprint | Fixed | `policyVerification()` supplies fingerprint and change data. |
| M7/M15 storage races | Fixed for nonce store | `ApprovalNonces` uses `proper-lockfile` around issue/consume. |
| M8 challenge abuse/enumeration | Fixed | Per-peer route limit, pending-challenge cap, and discoverable credentials avoid key-ID disclosure. |
| M9 notifications/audit | Fixed | Successful passkey enrollment, approval, release, resume and policy verification are audited and dispatched through the configured `passkey-approved` notifier rule; notifier failures are audited without changing the completed action. |
| M10 stale binding | Fixed | Bindings are re-derived before assertion and failures are audited. |
| M11 UI detail | Partially fixed | Approval cards render the available PR title, URL, SHA, reasons, verdict, risk and hold epoch through safe DOM text nodes; a browser DOM fixture matrix remains pending. |
| L12 resume state | Fixed | Resume challenges require the local paused marker. |
| L13 enrollment-code usability | Fixed | Enrollment code is retained until successful registration. |
| L14 credential metadata | Fixed | Enrollment persists authenticator device type, backup state and transports with the credential; `durable approval list` exposes the non-secret metadata. |

## Threat model and recovery

Passkeys protect high-risk approval, hold release, and resume actions from bearer-token theft and console-only compromise. They do not protect against a same-OS-user attacker that can alter the daemon, a compromised console that misleads the operator, a stolen unlocked passkey device, or a compromised tailnet node. The signed daemon challenge binds the intended action and current item state; use the GitHub link to independently inspect the PR.

If a passkey is lost, run `durable approval list <agent>`, then `durable approval revoke <agent> <credential-id>` on the daemon machine and enroll a replacement with `durable approval enroll <agent>` at a TTY. Chat, steering and pause remain scoped, rate-limited and audited controls; they are not passkey approvals.

Android has no nonce-safe notification channel. With no enrolled passkey it must report approval as unavailable and direct the operator to merge in GitHub; it never exposes a notification nonce fallback.
