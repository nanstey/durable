# Demo sandbox

Run `durable demo` (or `pnpm demo`) to start a credential-free local sandbox. It creates a temporary home, agent definition, loopback machine configuration, fake profile, API token, and console registry. It never reads an existing Durable profile or contacts GitHub.

The command prints the environment exports needed in a second terminal. Run those exports, then try:

```sh
durable status
durable queue
durable inbox
durable attach demo/<printed-steward-id>
durable approve demo 101 --code <printed-code>
durable metrics
durable org list
durable connectors list
```

The seeded issue has a fake worker draft PR, an approved fake review, and a gate awaiting human approval. The console URL printed by the command shows the fleet, conversation, and approval data. The API and console bind only to `127.0.0.1`.

Keep the first terminal open while using the demo. Press `Ctrl-C` there to stop both servers and remove the temporary sandbox.
