# API v1

The steward listens only on `127.0.0.1`. All `/v1` routes need `Authorization: Bearer <token>`; `/healthz` does not. Tokens have `read`, `chat`, or `pause` scopes and are stored only as SHA-256 hashes.

`GET /v1/device`, sessions, transcript, inbox, audit, budget, and `GET /v1/conversations?tree=true` require `read`. `GET /v1/events` is SSE and emits `hello`, `snapshot`, then deltas. `POST /v1/messages` requires `chat`, a `requestId`, and plain text. `POST /v1/pause` requires `pause`. Approval, resume, enrollment, and policy verification have no bearer-token route.

Messages are capped at 1 MiB, screen credential-like text, and audit only their metadata and hash.
