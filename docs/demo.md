# Demo sandbox

Run `durable demo` (or `pnpm demo`) to start a credential-free local sandbox. It creates a temporary home, five loopback agent APIs, fake profile, API tokens, and a console registry. It never reads an existing Durable profile or contacts GitHub.

The console shows this seeded fleet:

| Organization | Agent | Seeded work state |
| --- | --- | --- |
| `acme-platform` | `acme-dispatch` | running worker item; approval pending |
| `acme-platform` | `acme-quality` | done reviewed item |
| `side-projects` | `side-lab` | waiting-followup item; organization and agent paused |
| `side-projects` | `side-research` | held item |
| `oss-maintenance` | `oss-triage` | reviewer-error item; approval pending |

Every agent has a steward plus seeded chat, scout, worker, and reviewer conversations, a fake worker PR, and a fake review. The console registry also contains one deliberately offline loopback device. Pending gates for `acme-dispatch` and `oss-triage` receive distinct approval codes, printed when the demo starts.

The command prints the environment exports needed in a second terminal. Run those exports, then try:

```sh
durable status --agent acme-dispatch
durable queue --agent acme-dispatch
durable inbox --agent side-lab
durable attach acme-dispatch/<printed-steward-id>
durable approve acme-dispatch 101 --code <printed-code>
durable approve oss-triage 105 --code <printed-code>
durable metrics --agent oss-triage
durable org list
durable connectors list --agent acme-dispatch
```

The console URL printed by the command shows the grouped fleet, conversation, and approval data. The API and console bind only to `127.0.0.1`.

Keep the first terminal open while using the demo. Press `Ctrl-C` there to stop both servers and remove the temporary sandbox.
