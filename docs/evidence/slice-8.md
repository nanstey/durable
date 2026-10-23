# Slice 8 console evidence

## Browser smoke

2026-10-23: `playwright-cli` loaded the hub against a faux daemon at
`http://127.0.0.1:4319/`, then resized it to 390 x 844. The page rendered the
online fleet device, steward tree, agent-detail, conversation, pause, and
new-conversation controls at both sizes. The only browser console error was the
expected missing favicon (404).

A live browser session against a real steward remains pending operator
configuration. It must cover follow-up, busy steer, abort, new and resumed
chat/scout conversations, pause, and capability-gated worker controls.

## Automated evidence

`test/unit/console.test.ts` (6 tests) checks loopback request guards, CSP
directives, CSRF refusal, proxy allowlisting and server-side token injection,
monitor mismatch state, mux subscription cap, vendored asset checksums,
same-origin static URLs, inert rendering source and token absence.
