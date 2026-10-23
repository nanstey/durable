# Standalone installation

Requirements: Linux with systemd --user, Node **>=22.19.0**, pnpm, Git and
`gh`. Linux is the only supported daemon platform. Android/Termux is planned for
spec 14; macOS/launchd is deferred. On other operating systems `durable enable`
skips service installation and says why.

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

## Install through the skills repository

If Pi and the skills repository are already installed, run that repository's
`install.sh`. Its Durable integration clones the commit named in its pinned
Durable manifest, installs this package with `pnpm install --frozen-lockfile --prod
--ignore-scripts`, and links `durable`. It skips this Linux service integration on
non-Linux hosts with the same clear message as `durable enable`.

The pinned-clone route installs only the program. Complete the profile, machine
and definition steps in [operator.md](operator.md); do not put any of those
machine-local files into either repository.

For development use `pnpm install --frozen-lockfile --ignore-scripts`, then run
`pnpm check`, `pnpm test` and `pnpm hygiene`. Tests use temporary directories and
fabricated credentials only. The hygiene scanner covers all tracked and untracked
non-ignored files, including plans and evidence; it reports categories and filenames,
not matched credential text. Exceptions require `path # reason` entries in
`scripts/hygiene-allow.txt` and should be reviewed rather than used to hide secrets.
