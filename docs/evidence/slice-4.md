# Slice 4 evidence

Implemented the typed API v1 client, reconnecting SSE reader, conversation APIs, Ink
`durable attach` viewer, and operator read/chat CLI commands. The viewer uses only
the typed client; its abort and composer controls are both token-scope and
capability gated. Conversation creation is durable and idempotent.

## Local validation

- `node --experimental-strip-types --test test/unit/client.test.ts test/contract/api.test.ts`
  passed: 93 tests.
- `pnpm check` is recorded with the final implementation below.

## Pending operator

- Attach from the steward machine and an Orca terminal; exercise select, follow-up,
  steer, abort, and detach safety in a real terminal.
- Desktop and command-hook notifications; GitHub notification to a second login.
- `agent-down` live drill with restart disabled.
