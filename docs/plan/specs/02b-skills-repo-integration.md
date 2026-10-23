# Spec 02b — Skills-repo integration (thin)

Objective: the skills repo (the repo that holds the operator's skills, agent profiles and the Pi harness config, and that owns `install.sh`) gets the **minimum** needed to use the engine: a pinned clone of the public `nanstey/durable` repo installed by `install.sh`, the `durable` CLI on PATH, a thin skill, a catalog row and one contract row. Nothing of the engine lives here.
Design refs: architecture D18 (repository split, cross-repo coordination), D12 (skills), D3 (profiles); program design §1.2, §4.
New in revision 6 (U5). **Repo: the skills repo.** Why a separate spec, not folded into slice 2 or 3: it targets a different repo with a different commit and review cadence (one change per commit, README catalog and harness-table rules from AGENTS.md), and it depends on slice 2 having produced a first durable commit to pin, so it cannot be "slice 0". Later pin bumps are routine PRs governed by this spec's update flow, not new slices.
Depends on: spec 02 (a first durable commit with `bin/durable`, a lockfile and a passing CI).

## What is NOT in the skills repo any more
The engine, console, client library, TUI, API, schemas, tests, systemd units, Termux bootstrap, examples, docs, the worker guard Pi extension (`pi-extension/durable-worker-guard.ts`, loaded through the derived per-agent Pi settings), the slice 1 spike and evidence, and the plan itself all live in `nanstey/durable`. The skills repo still owns the skills and agent profiles that durable workers reuse (`idea-to-pr`, `pr`, `build`, `review-code`, `handoff`, ...), Pi settings and patches (including slice 13), and the installer.

## Checklist (one change per commit)
1. **Read the exact mechanism first.** Read `install/main.sh` (HARNESSES table, typed pairs) and `install/modules/*.sh` (`install_vendor_git`, `link_one`, `install_config`) and mirror the `vendor-git` pair: a manifest of `<url> <40-char commit>` lines; clone at that exact commit; `ok|cloned|updated` reporting; fail-closed on bad manifest lines or clone failures (deferred failure like the other pinned installs). Record any difference from the assumptions below in the PR.
2. **Pin manifest** `harness/durable/vendor/nanstey-durable.txt`: `https://github.com/nanstey/durable <40-char commit>`. Acceptance: manifest format test (full SHA, comment lines allowed).
3. **Installer wiring** `install/main.sh`: a `vendor-git` pair for the durable clone with destination `$DURABLE_HOME/vendor` (default `~/.pi/durable/vendor`, clone at `.../github.com/nanstey/durable`) and the manifest dir `$REPO_ROOT/harness/durable/vendor`, plus calls to the two functions below; run when Node >= 22.19 and the Pi harness is present; `DURABLE_SKIP=1` skips; never fails the whole install for a skipped optional step (mirrors the Pi patch steps). Acceptance: `install/tests/install.test.sh` cases.
4. **Module** `install/modules/durable.sh` (definitions only): `install_durable_deps CLONE_DIR` runs `pnpm install --frozen-lockfile --prod --ignore-scripts` in the clone only when `package.json` or the lockfile hash changed (stamp file), skips with a message when `pnpm` is missing; `install_durable_cli_link CLONE_DIR` links `~/.local/bin/durable` to `CLONE_DIR/bin/durable` with the existing `link_one`. It never writes `profile-meta`, `machine.yaml`, definitions, tokens, secrets or units (the CLI owns those). Acceptance: tests with stub `git`/`pnpm`: clone, `ok` on rerun, update to a new pin (`updated`), bad manifest fails closed, old-Node skip, run twice.
5. **Pin update flow** `harness/durable/bump-pin.sh <ref>`: resolves a ref (branch, tag or SHA) to a full 40-char commit with `git ls-remote`, rewrites the manifest line idempotently, prints the old and new SHA and the durable PR/commit range for the PR body. The documented flow: merge and verify the change in durable first; open a skills-repo PR with the bumped pin (and any doc/row changes it needs); after merge, machines run `install.sh` and see `updated`. Acceptance: test against a local bare repo.
6. **Thin skill** `skills/agent/durable/SKILL.md` (author it with `.agents/skills/make-skill/SKILL.md`; keep it repo/content agnostic): what durable is, the handful of commands (`durable doctor`, `status`, `attach`, `chat`, `queue`, `stop`, `approve`), where its config lives (machine-local), and a link to the durable repo's `docs/operator.md`. No duplicated manual. Acceptance: frontmatter valid; `name:` equals the directory.
7. **Catalog and tables (AGENTS.md):** a `README.md` catalog row for the skill under the right section, description equal to the frontmatter; `harness/durable/README.md` managed-file table (repo path, install destination, purpose) for the manifest and `bump-pin.sh`; one row in `harness/pi/README.md` documenting the **Pi-directory contract**: durable's derived per-agent Pi dirs symlink `auth-profiles/`, `secrets/`, `profile-meta/`, `extensions/`, `skills/`, `agents/`, `prompts/` from `$PI_AGENT_DIR`; `profile-meta/<name>.json` is created and owned by `durable profile`; renaming any of those directories requires the durable-first sequence (architecture D18). Acceptance: rows match files on disk.
8. **CI** (`.github/workflows/ci.yml`): the installer test already runs; add nothing durable-specific beyond the new cases.
9. **Verification on a machine:** run `install.sh` twice (`cloned` then `ok`), `durable doctor --help` from PATH, then `bump-pin.sh` to a newer durable commit and re-run (`updated`).

## Cross-repo coordination (restated for this spec)
- Order: durable first, then the pin bump here. A durable change that alters the `profile-meta` format, the Pi-directory contract or a required skill name is merged and verified in durable (with a migration, `version` bump or dual-name acceptance) before the pin bump.
- pi-durable, pi-ai and pi-coding-agent versions are pinned **exactly in durable's `package.json` and lockfile**; this repo never pins them and pins durable by commit only.
- Pi settings or patches that must change for durable stay in this repo (AGENTS.md "Pi changes must live in the repo"): none are required by slices 1-12; slice 13 removes interactive subagents here.

## Risk controls
- Public-repo hygiene applies to both repos: no secrets, machine-local state, absolute personal paths, real host names or emails in committed files.
- Fail closed: a malformed manifest or failed clone never leaves a half-installed CLI link; an existing working clone is kept if an update fails.
- No engine code, schema or test is duplicated here.

## Out of scope
Anything under the engine; units and service management (`durable enable`); the Termux bootstrap (durable repo); changes to Pi settings/patches other than slice 13.

## Done when
Installer tests pass in CI; a real machine shows `cloned` then `ok`; the pin bump flow shows `updated`; catalog and harness-table rows are in sync; the user accepts the pin flow.
