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

Use `durable org list` and `durable org show <name>` to inspect local policy metadata. `durable org apply <name> --code <nonce>` requires a one-time approval credential bound to the organization name, previous content hash, and candidate content hash. The resulting release stores only policy bytes, hashes, and approval metadata; it contains no credentials.

`durable org sync <name>` reports the operator-managed synchronization state. Operators may distribute approved bundles through fleet links when available, or synchronize the plain files with their own tooling. A receiving machine validates bytes, hash, approval, and schema before materializing its local effective policy. Local profile names resolve only after that materialization.

Invalid local policy, an invalid bundle, or materialization drift preserves the last valid materialization and blocks new work. Recover by restoring a valid approved file or bundle, then re-run doctor. Offline fleet transport and multi-machine stale-age operation remain pending the fleet-link implementation.
