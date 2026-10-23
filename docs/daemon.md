# Steward daemon

`durable enable <agent>` installs and enables `durable-agent@<agent>` as a systemd user unit. The unit uses `KillMode=control-group`, restart-on-failure, and no secrets. Enable user lingering if the daemon must survive logout: `loginctl enable-linger`.

Use `durable status|stop|logs <agent>` for service control and `durable run <agent>` for foreground operation. Create a client bearer token once with `durable token create <agent> --client <name> --scopes read,chat,pause`; it is never displayed again.
