# Required skills contract

The skills repository owns skill content and installation (spec 02b). Durable
owns selection and validation; it never downloads skill trees or silently changes
worker kind to compensate for missing skills.

| Effective kind | Role | Required skills |
| --- | --- | --- |
| pi-session | worker | `idea-to-pr`, `pr`, `build` |
| pi-session | reviewer | `review-code` |
| durable-conversation | worker/reviewer | `workers.durable.skills` only (default `[]`) |
| either | steward/scout/chat | none |

Skills are checked at `$PI_CODING_AGENT_DIR/skills/<name>/SKILL.md` in the canonical
Pi directory. Machine overrides are `workers.roles.<role>.skills` for Pi-session
roles. Durable roles always use the definition's explicit text allowlist, never
all user skills or the Pi-session contract. A present file is a prerequisite, not
an endorsement that a skill is suitable for the durable worker's restricted tool
set; the durable runtime must validate text before loading it in slice 6c.

Kind precedence is machine per-role override, definition per-role override,
definition-wide kind, platform default (Linux Pi-session; Android durable).
Durable enablement is a separate check: selecting durable requires the role in
`workers.durable.enabledRoles`. Omission defaults to `[]` on Linux and
`[worker, reviewer]` on Android. Enablement never selects a kind.

`checkRoleSkills` produces a doctor row and `assertRoleDispatchReady` fails closed
at the future dispatch seam for exactly the selected `(kind, role)`. The fix is:
“install the skills repo integration or copy the skill trees.” Skill-free durable
roles, steward, scout and chat do not inherit another role's missing skills.
Dispatch adapters are a later slice; they must call this seam for every launch.
