# Daemon API v1

The Hono API binds a literal loopback address only (`127.0.0.1` by default).
Other binds fail with an “available from slice 11” diagnostic. `/healthz` is
public. `/v1` requests require `Authorization: Bearer <token>` (or
`X-Durable-Token` for a proxy), except hold release, which requires an approval
nonce and rejects either bearer header. Supplying both headers is rejected.
Client types are exported from `src/api/types.ts`.

## Routes and authority

| Method and path | Scope | Response/effect |
| --- | --- | --- |
| GET `/healthz` | none | `{ok:true}` |
| GET `/v1/device` | read | API/package version, persistent UID, machine, agent, profile name, granted scopes, capabilities, process start time |
| GET `/v1/sessions` | read | Conversation nodes |
| GET `/v1/conversations?tree=true` | read | `{nodes:[...]}` |
| GET `/v1/conversations/<id>` | read | One node; unknown IDs return 404 |
| GET `/v1/conversations/<id>/transcript?format=json\|markdown` | read | Native committed entries, or plain Markdown text |
| GET `/v1/conversations/<id>/events` | read | Conversation SSE |
| GET `/v1/conversations/<id>/tasks` | read | Native task records for that conversation |
| POST `/v1/conversations/<id>/messages` | chat | Admit a screened input, return `{id}` with 202 |
| POST `/v1/conversations/<id>/abort` | chat | Abort the current turn, not a background attempt; node waits for follow-up |
| GET `/v1/events` | read | Steward SSE |
| GET `/v1/tasks` | read | Native live task records |
| GET `/v1/audit?since=<epoch-ms-or-ISO-date>` | read | Redacted audit records |
| GET `/v1/inbox` | read | Notice metadata, never bodies, secrets or nonces |
| POST `/v1/inbox/<id>/ack` | read | Persist acknowledgement |
| GET `/v1/budget` | read | UTC-day usage and stopped state |
| POST `/v1/pause` | pause | Write disabled state, abort model work, terminate containment |
| GET `/v1/items` | read | Persistent work items, attempts and PR state; no credentials |
| GET `/v1/items/<item>/hold` | read | Current holding/held fence and verification instructions |
| POST `/v1/items/<item>/hold` | pause | Fence immediately; return 202 while draining to held |
| POST `/v1/items/<item>/hold/verify` | pause | Containment proof where supported; advisory process inspection otherwise |
| POST `/v1/items/<item>/release/request` | pause | Deliver a release nonce to safe channels; never return it |
| POST `/v1/items/<item>/release` | nonce only | `{code}`; action/item/hold-epoch bound, single-use, five-minute expiry; bearer headers forbidden |
| POST `/v1/items/<item>/retry` | chat | Enqueue explicit retry; current eligibility, holds and budgets still apply |
| POST `/v1/conversations/<id>/open` | read | Orca viewer handle or command fallback |
| GET `/v1/workers` | read | Kind, capabilities, liveness and suspected human-session advisory |
| GET `/v1/workers/events` | read | Worker SSE |
| GET `/v1/workers/<id>/transcript` | read | Worker transcript frames |
| POST `/v1/workers/<id>/steer` | chat | Screened `{body}`; 501 when unsupported |
| POST `/v1/workers/<id>/interrupt` | pause | `{mode: soft\|hard}`; intentional cancellation never automatically resumes |
| POST `/v1/workers/stop` | pause | Stop workers with outcome stopped; keep the steward running |

`/v1/sessions/<id>/{transcript,events,tasks,messages,abort}` are aliases of the
conversation routes. `/v1/transcript` and `/v1/messages` target the main
conversation. Node IDs are opaque, persisted UUIDs. The tree uses pi-durable's
ownership index and task graph, including terminal owners. Nodes contain parent,
kind, status, source, optional item/owner task, start time and capabilities.
Steward, chat and scout conversations are representable; externally starting
chat/scout threads belongs to the client/conversation slice, so
`capabilities.startableKinds` is empty here. Dispatcher-sourced nodes arrive with
workers. Reviewer nodes never advertise steering.

No bearer scope authorizes approve, agent resume, enrollment, policy verification
or hold release. Those POST paths reject bearer authorization with 403; only
hold release has an implemented nonce-authorized route. There is no token-display endpoint,
shell, file-browser, configuration or arbitrary passthrough route.

## Message contract

```json
{"body":"Explain the current status","requestId":"client-unique-id","whenBusy":"followUp"}
```

`body` must be a non-empty string. `requestId` is required (up to 200 characters).
`whenBusy` is required and is `steer`, `followUp` or `reject`.
Only these three fields are accepted: no role, attachments, HTML or tool-call
fields. Text that resembles markup is still text; clients must render it inertly.
JSON transport is bounded before parsing; decoded text defaults to a **1 MiB
UTF-8 byte ceiling**, configured through `chat.maxMessageBytes`.

GitHub token prefixes, `sk-` keys, private-key headers, cloud keys, Slack tokens,
JWTs, secret assignments and long high-entropy strings are rejected with 400:
`{"error":{"code":"invalid","message":"credential-like-content"}}`.
Screening is a heuristic, not proof that arbitrary text contains no secret.

There is no default chat rate limit. `chat.rateLimit.perMinute` and `perDay` opt
in to persisted per-client UTC windows. A full window returns 429 with
`Retry-After` seconds. Budgets and the kill switch still apply without a rate
limit. Each message audits actor, via, token client, conversation ID, byte count
and SHA-256; message content lives only in the native transcript.

Admission is serialized. A conversation-scoped request ID has a committed content
hash before native submission. Repeating the same request returns the original
submission ID; changing its text returns 409 `conflict`. Native submission
idempotency also covers a crash between admission and receipt persistence.

## Streaming

Each SSE connection emits JSON in `data:` frames:

1. `hello {apiVersion,scope,serverTime}`;
2. `snapshot {state}`;
3. `delta {state}` and `tree {upsert,remove}` frames as committed state changes.

A comment `: ping` is sent every 15 seconds. Reconnect gets a fresh snapshot;
there is no replay cursor. Publication polls committed state at 250 ms intervals.
A viewer more than 2 MiB behind, including in-flight writes, is disconnected.
Closing a stream never stops a task or conversation. Expired or revoked tokens
also disconnect existing streams on the next publication check.

Errors use `{error:{code,message}}`. Codes are `unauthorized` (401), `forbidden`
(403), `not_found` (404), `invalid` (400), `busy`/`conflict` (409), `rate_limited`
(429), `not_supported` (501), `unavailable` (503), and `internal` (500). Internal
exception text is not exposed. Invalid tokens return 401; valid tokens with the
wrong scope return 403.

See [token administration](operator.md#api-access-and-tokens) and
[daemon operation](daemon.md).
