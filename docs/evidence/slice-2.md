# Slice 2 replacement evidence

This records offline implementation evidence, not live-account or production-daemon
validation. No live profile credentials were copied or modified. The available Pi
directory had zero named profile files when the manual checkpoint was assessed.

| Spec 02 item | Implementation / evidence |
| --- | --- |
| 1 Scaffold | `package.json`, lockfile, `bin/durable`, `tsconfig.json`, existing license/contributor rules; exact version/engine test in `test/unit/core.test.ts`; frozen installation verified. |
| 2 Schemas/loaders | `src/config/{schema,jsonSchemas,agent,manifest,load,paths}.ts`; exact-pinned Ajv; nested unknown-key rejection, reserved fields, definition path/hostname restrictions; assignment checked by doctor. |
| 3 Generated schemas | `schema/{agent,machine,profile-meta}.schema.json`; `pnpm schema:generate`; drift tests in `test/unit/identity.test.ts`. |
| 4 Profiles | `src/identity/profiles.ts`; canonical named/default paths, no fallback, read-only provider presence through `readStoredCredential`; default restrictions in doctor and role readiness. |
| 5 Manifest CLI | `src/cli/profile.ts`: list/init/show/bind-github/check and dry-run; private 0600 manifests/0700 directories, exclusive creation, injected gh; tests and CLI smoke. The task's stricter 0600 requirement takes precedence over the original checklist's 0644. |
| 6 Environments | `src/identity/env.ts`: process allowlist, profile-owned secrets, generated git identity/helper/rewrite/trailer config; distinct credential-free durable shell with per-item scratch and fresh empty gh directory; hostile parent/profile tests. |
| 7 Derived Pi directory | `src/identity/pidir.ts`; directory-only symlinks, generated settings/defaultProfile, idempotent layout, credential-bearing/file-symlinked auth refusal; exact concurrent ModelRuntime counter, intact directory symlink, 0600 credential mode. |
| 8 GitHub/token checks | `src/identity/{github,token}.ts`; login comparison, advisory token type/broad scopes/out-of-scope reachability warnings; first page of repositories inspected, unavailable probes explicitly reported. |
| 9 Model seam | `src/identity/modelAuth.ts`; awaited public ModelRuntime over the profile; missing-provider rejection; explicit not-configured Anthropic shaping. Tests cover API-key lookup, locked fabricated OAuth rotation via loopback endpoint, and Harness reopen/configure persistence. |
| 10 Doctor | `src/identity/doctor.ts`, `src/cli/doctor.ts`; schema/assignment/profile/manifest/token/git/models/families/channels/ports/default/auth/worker/platform/containment/skills checks; table, fixes, JSON and failure exit; injected capabilities and gh tests. Tightening warnings accept resolved policies through a seam; real policy sources remain slice 9. |
| 11 CLI | Executable `bin/durable`, compatibility `bin/durable.ts`, `src/cli/main.ts`; doctor/profile/help and manifest dry-run. Existing daemon commands are outside this replacement's scope. |
| 12 Required skills | `src/identity/skills.ts`, `docs/skills-contract.md`; role-local readiness guard, configurable Pi-session contracts, explicit durable allowlist, platform enablement, all ten kind-selection truth-table rows. Future dispatch adapters must invoke the readiness guard; adapters are slice 6, not shipped here. |
| 13 Docs/examples | `README.md`, `docs/{install,operator,skills-contract,architecture}.md`, examples and plan corrections; inspiration-only reference; standalone install and limitations documented. |
| 14 CI/hygiene | Existing CI runs frozen install, `pnpm check`, tests and hygiene. Scanner now includes tracked and non-ignored untracked files, plans and evidence, reasoned allowlist, positive/negative generated fixtures; never prints matched secret text. |
| 15 Manual verification | **Not executed: pending operator.** No named live profiles were available. Provision two real named profiles and perform bind/doctor, swapped-token and missing-profile checks. Fabricated tests are not presented as live verification. |

## Executed checks

At this checkpoint: **2,091 lines of `src/**/*.ts`**, **123 passing tests** (zero
failures, skips or TODOs). The source count includes pre-existing API/steward code;
this change focuses on the Slice 2 configuration and identity surface.

- `pnpm install --frozen-lockfile --ignore-scripts`
- `pnpm check` (TypeScript, Biome lint/format, Fallow dead code/duplication)
- `pnpm test`
- `pnpm hygiene`
- Actual executable CLI: profile init/list/show/dry-run, 0600/0700 permission check,
  missing-configuration doctor JSON and exit status 1.

The environment isolation is **not an OS sandbox**. A same-user shell may read
credential files through explicit filesystem paths. Durable workers cannot use
Anthropic subscription OAuth through the plain seam until shaped auth is configured;
Pi-session roles remain available. Network/approval configuration is parsed but
fails doctor as not-yet-supported; parsing does not enable these features.
