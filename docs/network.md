# Tailnet networking

Durable daemons listen on loopback by default. To expose a daemon only on a tailnet, set `network.bind: tailnet` in `machine.yaml`, provide `network.allowedPeers` (normally `tag:durable-console`), and keep the loopback listener for local CLI use. Durable resolves the Tailscale address or uses `network.tailnetAddress`; it never uses `0.0.0.0`.

Use `network.peerCheck: required` on hosts with the Tailscale CLI. Each tailnet request must pass `tailscale whois --json` and match `allowedPeers`, as well as present a scoped bearer token. On Android use `optional` only when the CLI is unavailable; ACLs and the token remain required.

Create these tags in the tailnet policy: `tag:durable-daemon` on daemon hosts and `tag:durable-console` on console hosts. Permit console to daemon ports, and operator devices to console HTTPS. Do not permit daemon-to-daemon traffic or phones to daemon ports. Run `durable doctor <agent> --acl` to print the policy starting point; it never changes policy.

Serve the loopback console over tailnet HTTPS with `durable console serve`, then run the printed `tailscale serve --bg https` command. Never add `funnel`: Durable rejects it. Add the Serve hostname and permitted `Tailscale-User-Login` values to `console.yaml`; non-GET browser calls require that identity plus same-origin and CSRF checks.
