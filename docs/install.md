# Standalone installation

Requirements: Linux, Node **>=22.19.0**, pnpm, Git and `gh`. Platform capability
checks also describe Termux, but Android daemon support is a later slice.

```sh
git clone https://github.com/nanstey/durable.git
cd durable
pnpm install --frozen-lockfile --prod --ignore-scripts
mkdir -p ~/.local/bin
ln -s "$PWD/bin/durable" ~/.local/bin/durable
durable help
```

Ensure `~/.local/bin` is on PATH. The executable resolves its own source tree when
linked; no build step or global TypeScript loader is required. Runtime dependencies
are exact-pinned; installation does not need dependency lifecycle scripts.

Set up a named Pi profile, manifest, definition and machine assignment as described
in [operator.md](operator.md), then run `durable doctor <id>`. Installation never
creates credentials, binds a GitHub identity, modifies Pi authentication files or
enables a daemon on your behalf.

For development use `pnpm install --frozen-lockfile --ignore-scripts`, then run
`pnpm check`, `pnpm test` and `pnpm hygiene`. Tests use temporary directories and
fabricated credentials only. The hygiene scanner covers all tracked and untracked
non-ignored files, including plans and evidence; it reports categories and filenames,
not matched credential text. Exceptions require `path # reason` entries in
`scripts/hygiene-allow.txt` and should be reviewed rather than used to hide secrets.
