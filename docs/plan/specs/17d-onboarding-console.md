# Spec 17d — Onboarding: console client

Objective: add the same three-stage onboarding flow to the console after the CLI is proven, reusing one daemon-side onboarding plan/diff/apply API. The browser remains a controller with no credential custody and no direct configuration-file authority.

Design refs: product review W14 and decision 35; architecture D13-D16 and D24; program design §2, §3.5-3.6; specs 08 and 17a-17c.

Depends on: specs 08 and 17a-17c. The CLI remains the complete first deliverable and is the recovery path if the console is unavailable.

## Checklist

1. **Typed onboarding API:** expose authenticated, allowlisted daemon routes to create/read a non-secret onboarding plan, validate answers, render a diff, apply an idempotent stage, read progress and run doctor/re-check. The API accepts neither credentials nor arbitrary paths and returns no tokens, secrets or profile credential contents. Acceptance: route/scope/schema/no-secret response tests pass.
2. **Console flow:** add a three-stage, accessible view matching CLI choices: Start a profile, Create an organization, Create an agent. Present recommended defaults as explicit selections, show progress/resume state and make every planned file diff reviewable before apply. Use numbered/text labels, keyboard operation, visible validation and no hover-only control. Acceptance: keyboard, screen-reader-label and narrow-viewport browser tests pass.
3. **Credential handoffs:** the console only explains and launches/prints the local Pi, `pi-secret` or supported GitHub device-flow handoff. It has no password/token field and cannot display credential state beyond non-secret doctor results. Anthropic OAuth acknowledgement is explicit and uses the same API field as CLI. Acceptance: DOM and route tests prove token-like input is rejected and never rendered.
4. **Parity and concurrency:** use the same plan/state/diff/apply contract as CLI. Detect plan hash or progress changes made by another client and require reload/review rather than overwriting. A console restart, browser close or network interruption leaves resumable state only; no partial stage is represented as complete. Acceptance: CLI-to-console and console-to-CLI parity, conflict and interrupted-request tests pass.
5. **Demo path and installer boundary:** expose the fake-only demo sandbox with a conspicuous no-real-credentials boundary. Keep the skills-repo installer out of the flow; it may link to CLI or console documentation only. Acceptance: demo isolation and no-installer-autostart tests pass.
6. **Security and docs:** retain console CSP, inert rendering, Host/Origin/CSRF and route allowlist protections. Document client equivalence, credential handoffs, diff review, resume/recovery and browser limitations. Acceptance: hostile text/XSS, CSRF and token-never-in-browser tests pass.

## Risk controls

- The daemon owns validation, diffing, progress and writes; the console cannot directly edit definitions, organizations or machine files.
- No browser receives a GitHub token, model credential, profile secret or approval nonce.
- Console choices do not gain approval, merge, policy-verification or service authority beyond the existing guarded API.
- Closing the console is safe; CLI can resume every stage.

## Out of scope

A browser-only credential login, arbitrary configuration editing, onboarding existing fleets in bulk, a public-internet flow, and replacing `durable onboard`.

## Done when

CLI and console pass the same onboarding contract tests; browser accessibility/security tests pass; an operator can resume a CLI-created plan in the console (and vice versa) without a credential reaching the browser.
