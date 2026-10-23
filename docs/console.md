# Console

## Console: our own, from scratch

`dpi-playground` is the hub plus Vue web client in `disler/durable-pi`, roughly
6.6k lines including its SDK. It is experimental and built for that project's
demos. Durable does not reuse it because its panels, toolchain and trust model do
not fit ours. We write our own hub, client library and API; dpi projects are
inspiration only. _Inspired by `disler/durable-pi`._

## Local console

`durable console enable` installs and starts the user service. It binds only to
127.0.0.1. `durable console status` and `durable console disable` inspect and
stop it. The first enable creates private `console.yaml` and device registry
files below `~/.config/durable/console`, then creates scoped `console-local` daemon tokens.
The browser never receives those tokens: the hub injects them into its narrow
allowlisted daemon proxy.

The hub has registry, monitor, proxy, multiplexed stream and request guard
modules. It serves the no-build `web/` application. One SSE stream belongs to
each tab; subscriptions are capped at 20. The console can read agent state,
queue, inbox, audit and transcripts, send plain-text chat follow-ups or steers,
abort turns, pause agents, and interrupt/steer workers only when capabilities
report support. It cannot approve, resume, enroll, verify policy, access files,
run commands, or proxy arbitrary daemon routes.

All UI text is inert text. The server enforces same-origin Host/Origin, JSON
writes and a CSRF header, and sends a strict CSP. Narrow screens keep the same
controls in one column.

## PWA follow-up boundary

Push routes deliberately return 501. `console.yaml` defines `push.enabled:
false`; private versioned VAPID and subscription-store paths exist but are not
used. Slice 12b will generate keys with `durable console push-keys init`; its
private key is mode 0600 and `web-push` is loaded lazily as an optional
dependency. CSP already allows same-origin workers and manifests, but this slice
does not install either.
