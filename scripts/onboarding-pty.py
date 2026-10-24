#!/usr/bin/env python3
"""Exercise real Clack prompts in a PTY with isolated HOME and fake auth adapters."""
import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import struct
import termios
import tempfile
import time

repo = Path(__file__).resolve().parent.parent
node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")

with tempfile.TemporaryDirectory(prefix="durable-pty-") as temporary:
    home = Path(temporary)
    fakebin = home / "bin"
    fakebin.mkdir()
    for name, source in {
        "gh": '''#!/bin/sh
case "$1 $2" in
  "auth login") echo 'FAKE GitHub: open https://example.invalid/device code TEST-CODE' ;;
  "auth token") echo github_pat_fake_pty ;;
  "api user") if [ "$FAIL_GITHUB" = 1 ]; then exit 1; fi; echo octocat ;;
  "--version ") echo 'gh version fake' ;;
  *) exit 1 ;;
esac
''',
        "pi": '''#!/bin/sh
echo "FAKE Pi: $1 sign-in completed (no network)"
''',
    }.items():
        executable = fakebin / name
        executable.write_text(source)
        executable.chmod(0o700)
    runner = home / "run.mts"
    runner.write_text('''import { onboard } from IMPORT;
import { execaSync } from "EXECA";
import { password } from "CLACK";
import { readFileSync, writeFileSync } from "node:fs";
const result = await onboard({ providers: { login: async (profile, provider) => {
  if (provider === "openrouter") {
    const key = await password({ message: "OpenRouter API key (hidden; fake only)" });
    if (typeof key !== "string") throw Error("cancelled");
  }
  execaSync("pi", [provider], { stdio: "inherit" });
  let auth = {};
  try { auth = JSON.parse(readFileSync(profile.authFile, "utf8")); } catch {}
  writeFileSync(profile.authFile, JSON.stringify({ ...auth, [provider]: { type: "api_key", key: "fake-pty-only" } }));
} } });
console.log(result.output);
'''.replace('"EXECA"', repr(str(repo / "node_modules/execa/index.js")))
        .replace('"CLACK"', repr(str(repo / "node_modules/@clack/prompts/dist/index.mjs")))
        .replace('IMPORT', repr(str(repo / "src/onboarding/index.ts"))))
    env = {
        "PATH": f"{fakebin}:{Path(node).parent}:/usr/bin:/bin",
        "HOME": str(home), "TERM": "xterm-256color",
        "PI_CODING_AGENT_DIR": str(home / "pi"),
        "DURABLE_HOME": str(home / "durable"),
        "GH_PROMPT_DISABLED": "1",  # production login must remove this
    }

    def run(label, steps, fail=False, cli=False):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 180, 0, 0))
        command = [node, "--experimental-strip-types", str(repo / "bin/durable"), "onboard"] if cli else [node, "--experimental-strip-types", str(runner)]
        child = subprocess.Popen(command,
                                 stdin=slave, stdout=slave, stderr=slave,
                                 env={**env, "FAIL_GITHUB": "1" if fail else "0"},
                                 start_new_session=True)
        os.close(slave)
        raw = ""
        offset = 0
        deadline = time.monotonic() + 30
        try:
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not data:
                        break
                    raw += data.decode(errors="replace")
                if steps and steps[0][0] in raw[offset:]:
                    needle, keys = steps.pop(0)
                    offset = raw.index(needle, offset) + len(needle)
                    time.sleep(0.15)
                    os.write(master, keys)
                if child.poll() is not None:
                    break
            else:
                raise RuntimeError(f"PTY deadline exceeded; remaining={steps!r}; output={ansi.sub('', raw)!r}")
            child.wait(timeout=2)
            assert child.returncode == 0, raw
            assert not steps, steps
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            os.close(master)
        clean = ansi.sub("", raw).replace("\r", "")
        assert "fake-pty-only" not in clean and "github_pat_fake" not in clean
        # Keep submitted prompts and application output, not every screen redraw.
        lines = clean.splitlines()
        print(f"\n### {label}")
        for line in lines:
            if line.startswith(("◇", "FAKE", "GitHub:", "Provider ", "Profile ", "work:", "Manual", "Next:", "Then:", "durable ", "Run durable", "  Fix:", "Prerequisite:")):
                print(line)
        return clean

    enter = b"\r"
    down = b"\x1b[B"
    fresh = run("Fresh profile; immediate GitHub and three provider sign-ins", [
        ("Start a profile", enter), ("Profile name", b"work\r"),
        ("GitHub authentication", enter),
        ("Sign in to a model provider now?", enter),
        ("Sign in to a model provider now?", enter),
        ("Acknowledge Anthropic", b"y\r"),
        ("Sign in to a model provider now?", enter),
        ("OpenRouter API key", b"fake-hidden-input\r"),
        ("Sign in to a model provider now?", enter),
    ])
    assert "fake-hidden-input" not in fresh
    assert "Profile ready." in fresh and "Next: durable onboard" not in fresh
    run("Rerun; finish without authentication questions", [
        ("Start a profile", enter), ("Profile already configured", down + down + enter),
    ])
    failed = run("Rerun; re-verify with failed GitHub probe", [
        ("Start a profile", enter), ("Profile already configured", enter),
    ], fail=True)
    assert "GitHub: failed\n  Fix:" in failed
    assert "Run durable onboard to finish GitHub authentication" in failed
    run("Actual durable onboard CLI; configured profile finish", [
        ("Start a profile", enter), ("Profile already configured", down + down + enter),
    ], cli=True)
