# durable

Durable, proactive agents that find project work and push it to human review.
Built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).

Status: planning. No code yet.

## Principles

- One agent uses one credential profile and one GitHub identity.
- GitHub is the durable record. Each machine runs independently.
- Auto-merge is off unless a repo opts in. The agent never bypasses GitHub rules.
- The repo holds no secrets, no machine-local state and no absolute paths.
