# Spec 13 — Retire `pi-interactive-subagents` and trim dependencies

**Repo: the skills repo** (this is skills-repo work: Pi settings, patches, fixtures, installer rows and docs). Objective: remove the interactive-subagent stack from the Pi harness after replacements are proven, with a clean install on machines that still have it.
Design refs: architecture D11; product review success signal "Retirement".
Depends on: spec 06 minimum (durable workers proven; durable lives in its own repo and is consumed here only through the pinned clone) (workers and headless paths proven). Revision 2: renumbered (was 10). Run after real use of 06-09, ideally with the console (spec 08) in daily use.

## Checklist
1. **Inventory** (record in the PR body; no new files in either repo): `grep -rn "subagent\|subagent_done\|caller_ping\|interactive" skills/ agents/ harness/ .agents/ README.md AGENTS.md`. For each hit classify: remove, rewrite to `handoff`/steward/headless `pi -p`, or keep (Claude Code `agents/` profiles stay valid for Claude Code).
2. **Replacement coverage table** in the PR: each documented use -> replacement -> evidence it works (handoff run, steward worker, headless reviewer as `pi-improve` does). Stop if any use has no replacement and ask the user.
3. **Rewrite references**: `harness/pi/APPEND_SYSTEM.md` (delegation bias section, subagent tiers), skills that instruct `subagent` use, `agents/*.md` frontmatter that exists only for the interactive package (`system-prompt`, `interactive`, `deny-tools`) — keep valid for Claude Code, update the Pi section of `harness/pi/README.md` ("Pi agent profiles").
4. **Remove from `harness/pi/settings.json`**: `npm:@maplezzk/pi-interactive-subagents@3.16.4`.
5. **Delete files**: `harness/pi/extensions/pi-interactive-subagents/config.json`, `harness/pi/patches/pi-subagent-widget-3.16.patch`, `harness/pi/patches/pi-subagent-done-requires-summary.patch`, fixtures `harness/pi/tests/fixtures/pi-interactive-subagents-3.16.4/`, `harness/pi/tests/subagent-done-summary.test.mjs`, the child-widget parts of `package-extensions.test.mjs`. Decide about `pi-fallback-reviewer-provider-lock.patch` (depends on `PI_SUBAGENT_AGENT=reviewer`): remove it only if the new reviewer path does not use that env; otherwise keep and note why.
6. **Installer**: remove the `config:$PI_AGENT_DIR/extensions/pi-interactive-subagents` pair and the two `patch-subagent-*` types from `HARNESSES` and `install/modules/patches.sh`; keep installer tolerant of machines where the package is still installed (patch steps gone, so no error). Add a documented one-time cleanup (`pi remove npm:@maplezzk/pi-interactive-subagents` — verify the Pi command at implementation time) or an idempotent installer step that reports `stale package installed`.
7. **Docs**: `harness/pi/README.md` table and patch narrative sections updated; `install/TOOL_INSTALLATION.md` if it references them; root `README.md` if catalog text changes. Follow AGENTS.md: removal of a managed artifact updates the harness README table.
8. **Dependency trim review**: list remaining Pi packages and patches with their last verified result (`package-patches.test.sh`). Propose removals for patches that fail on upstream drift (pi-jev) as a **separate** follow-up; do not bundle.
9. **Verify**: `bash install/tests/install.test.sh`, `bash harness/pi/tests/package-patches.test.sh`, `bash harness/pi/tests/pi-improve.test.sh` pass; sandbox `install.sh` twice: second run all `ok`; grep finds no stale reference; the self-improvement loop still runs its dry run.

## Risk controls
- Do not remove before replacements are proven in real use; user checkpoint is mandatory.
- This planning agent's own profile (`planner`, `worker`, `reviewer`) relies on `subagent_done` and `caller_ping` today. Keep Claude Code behaviour unchanged and document Pi behaviour after removal.
- Patches already applied on machines remain in installed packages until the package is removed; do not edit existing patch files (AGENTS.md: add a new patch if one is ever needed).
- Commit granularity: one PR; explain in the body why the package, patches, fixtures and docs are coupled.

## Out of scope
Fixing pi-jev patch drift; changing Claude Code agent profiles; removing `pi-intercom` (decide separately).

## Done when
All checks pass, inventory shows no unresolved use, and the user confirms nothing they rely on is lost.
