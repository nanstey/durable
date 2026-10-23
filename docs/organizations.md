# Organizations

An organization is an optional non-secret policy boundary. Definitions without `organization` use the in-memory `default` organization and keep their existing behavior.

Put a named policy in `organizations/<name>.yaml` beside the agent definitions directory. The default location is `~/.config/durable/organizations/`; if `DURABLE_AGENTS_DIR` is set, Durable uses its sibling `organizations/` directory. Documents name members and may cap repositories, limits, notifications, pipeline stages, tools, and connector read/write access. Profiles and credentials are not valid organization fields.

```yaml
name: work
memberAgents: [api-agent]
scope:
  repos: [acme/api]
limits:
  maxConcurrentWorkers: 1
connectors:
  - id: issue-search
    provider: fake
    connection: work
    tools:
      - id: search
        access: read
```

Use `durable org list` and `durable org show <name>` to inspect local policy metadata. `durable org apply <name> --code <nonce>` requires a one-time approval credential bound to the organization name, previous content hash, and candidate content hash. Named agents start only when the local file exactly matches that approved hash; Durable writes immutable materialization metadata without the agent's profile or credentials. The resulting release stores only policy bytes, hashes, and approval metadata; it contains no credentials.

`durable org pause <name>` fences new work for local members of that organization only. `durable org resume <name>` removes that fence. It does not affect global or per-agent pauses and cannot release a held item.

`durable org sync <name>` reports operator-managed synchronization when no transport argument is supplied. To pull from an origin daemon, run `durable org sync <name> --from <daemon-url>` and provide that daemon's read token on standard input. To push an approved origin bundle to a member daemon, run `durable org sync <name> --to <daemon-url>` and provide a `sync`-scoped member token on standard input. The daemon API transports only the canonical approved bytes, content hash, and approval record; it never writes the received policy into `organizations/`.

A receiver verifies bytes, hash, approval, and schema before storing a received bundle and materializing local member definitions. Local profile names resolve only after that materialization. Received bundles remain usable while offline until `maxStaleAge`; then new work is blocked while fenced work can finish. Device, console fleet, and SSE snapshots expose only organization ID, bundle hash, and version state (`current`, `updating`, `stale`, `invalid`, or `unreachable`), not policy bodies or credentials. An invalid local policy, unapproved file, bad bundle, materialization drift, or stale received bundle blocks new named-agent start. Recover by restoring a valid approved bundle or file and re-run doctor.
