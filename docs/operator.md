# Operator guide

An agent definition names a profile; machine assignment stays in `machine.yaml`. Initialize a non-secret manifest with `durable profile init <name>`, then run `durable doctor <agent>`. Profiles are named by default. `default` needs `profiles.allowDefault: true` and cannot be used by Pi-session workers. Keep secrets in the profile's `secrets/<name>.env`, not in definitions.
