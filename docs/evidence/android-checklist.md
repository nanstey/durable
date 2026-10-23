# Android/Termux checklist (slice 14 gate)

Status: **pending operator device**. Nothing here has been run yet. Results gate slice 14 only; failures do not block slices 2-13.

Rules:
- Run in Termux on a real device, with throwaway tokens and a throwaway repo.
- Keep state in Termux's private `$HOME`. Never put profile files on shared storage, which cannot hold `0600`.
- Never bind `0.0.0.0` on an untrusted network.
- Paste only redacted output: no tokens, host names, tailnet names or IPs, logins, emails.

Reference results from the Linux spike (for comparison): Node v26.8.1 with `node:sqlite` OK; pi-durable 1.4.0 + pi-ai 1.4.0 + chord 1.4.0 kill -9 recovery OK (`spike/recovery.ts`); `@simplewebauthn/server` 14.0.3 verify OK. See [spike.md](./spike.md).

Device / Android version: ________ Termux source (F-Droid or GitHub, not Google Play) and version: ________ Date: ________

## 0. Setup

```sh
pkg update && pkg upgrade
pkg install nodejs git
```
Result: ________

## 1. Node and node:sqlite

```sh
node -v
node -e "require('node:sqlite'); console.log('sqlite ok')"
```

- Node version: ________
- `sqlite ok`? ________ If missing: pi-durable's JSONL storage (`@earendil-works/pi-durable/storage/jsonl/node`) is required. Note it here: ________

## 2. Pi CLI, profiles and file modes

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
mkdir -p ~/durable-test/pi && export PI_CODING_AGENT_DIR=~/durable-test/pi
# API-key profile:
pi -p --provider <provider> --model <model> "reply ok" </dev/null
# OAuth via the headless copy-code flow (separately): pi, then /login
ls -l "$PI_CODING_AGENT_DIR"   # expect auth file mode -rw-------
```

- `pi --version`: ________
- API-key `pi -p` result: ________ (pass `--provider/--model` explicitly; the Linux spike found `defaultModel` + profile extension is not enough in print mode)
- OAuth headless login result: ________
- Profile file mode `0600` preserved under `$HOME`? ________ Shared storage tested (expect no `0600`)? ________

## 3. pi-durable recovery

```sh
mkdir -p ~/durable-test/pd && cd ~/durable-test/pd
npm init -y >/dev/null
npm i --ignore-scripts @earendil-works/pi-durable@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/chord@1.4.0
# copy spike/recovery.ts from the durable repo into this dir, then:
node recovery.ts start r.sqlite &   # wait ~4 s
kill -9 %1
node recovery.ts resume r.sqlite    # expect: toolResult isError true, "interrupted", SETTLED done
```

- Install OK with `--ignore-scripts`? ________
- Resume output (redacted): ________
- If SQLite is unavailable: repeat with JSONL storage. Result: ________
- Orphaned `sleep 30` child left behind after kill -9 (Linux: yes)? ________

## 4. Pure-JS runtime deps

```sh
npm i --ignore-scripts typebox yaml @simplewebauthn/server
node -e "import('@simplewebauthn/server').then(m => console.log(typeof m.verifyAuthenticationResponse))"
node -e "import('yaml').then(m => console.log(m.parse('a: 1').a))"
```
Result: ________

## 5. gh, worktrees and a small worker task (30 min)

```sh
pkg install gh
GH_TOKEN=<fine-grained PAT, throwaway repo> gh auth status
git clone <throwaway repo> repo && cd repo && git worktree add ../wt -b durable-test
cd ../wt && time pi -p --provider <p> --model <m> "add a line to README" </dev/null
termux-battery-status   # before and after
```

- `gh auth status` token type line (redacted): ________
- Wall time: ________ Peak memory: ________ Battery drop over 30 min: ________ Temperature: ________

## 6. Services, boot, wake lock, Doze

```sh
pkg install termux-services     # restart Termux afterwards
mkdir -p $PREFIX/var/service/durable-hb/log
printf '#!/data/data/com.termux/files/usr/bin/sh\nwhile true; do date +%%s >> ~/hb.log; sleep 60; done\n' > $PREFIX/var/service/durable-hb/run
chmod +x $PREFIX/var/service/durable-hb/run
sv-enable durable-hb
termux-wake-lock
```

- Survives closing the Termux session? ________
- Termux:Boot installed; starts after reboot? ________
- Overnight heartbeat gaps (from `~/hb.log`): ________
- Phantom-process killing observed? ________ Battery-optimization exemption steps used: ________

## 7. Networking

```sh
ip addr; ifconfig
node -e "console.log(require('os').networkInterfaces())"
# Tailscale Android app connected; bind ONLY the 100.x address:
node -e "require('http').createServer((q,s)=>s.end(q.socket.remoteAddress+'\n')).listen(8787,'<tailnet-ip>',()=>console.log('up'))"
# from another tailnet node: curl http://<tailnet-ip>:8787/
```

- `os.networkInterfaces()` works or throws: ________
- 100.x address visible? ________ Bindable? ________ Reachable from another node (peer address seen)? ________

## 8. Tailscale inside Termux

```sh
pkg search tailscale
# if present: tailscaled --tun=userspace-networking --state=~/ts.state &  (separate node, own tag)
# tailscale serve --tcp 8788 tcp://127.0.0.1:8787 ; tailscale whois <peer-ip>
```

- Package present? ________ Userspace node workable? ________ Interaction with the Android app: ________

## 9. Notifications (nonce safety)

```sh
pkg install termux-api   # plus the Termux:API app
termux-notification --title durable-test --content "nonce 123456"
termux-notification-list   # from another Termux session/process
termux-battery-status
```

- Can another Termux process read the notification content? ________ (If yes, the CLI approval nonce must never go to this notifier; the plan already assumes this.)
- Battery status JSON fields usable for a battery gate? ________

## 10. Console client on the same phone

- Open `http://127.0.0.1:<port>` of a Node server in the phone browser: ________
- WebAuthn on that origin (register + assert; e.g. `spike/webauthn/` served from Termux): ________
- SSE across a Wi-Fi to mobile-data handoff (reconnect + fresh snapshot): ________
