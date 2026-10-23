# Slice 4b notifier evidence

Date: 2026-10-23. Scope: spec 04 checklist items 4–10.

## Executed

- `pnpm install --frozen-lockfile`
- `node --experimental-strip-types --test test/unit/notifier.test.ts` — 3 passed
- `pnpm check`
- `pnpm hygiene`

The unit tests cover durable deduplication before delivery (including restart
replay), nonce-free inbox payloads, bounded reminders, quiet-hour holding and
later delivery, and stale-item parking without privileged actions.

## Pending operator

The following require an operator profile, desktop session or a second GitHub
login and were not run with credentials: `notify-send` desktop delivery,
operator command-hook delivery, GitHub notification to a second login, and the
systemd failure drill with restart disabled. The installed failure unit calls
`durable notify --event agent-down --agent %i`; this command reads local
configuration and notifier state and does not require a living steward process.
