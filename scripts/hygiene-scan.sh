#!/usr/bin/env bash
set -euo pipefail
# Public repository guard: only tracked text files are inspected.
files=$(git ls-files -z | tr '\0' '\n' | grep -v '^scripts/hygiene-allow.txt$' || true)
fail=0
check() { local pattern=$1 label=$2; if printf '%s\n' "$files" | xargs -r grep -nE "$pattern" >/dev/null 2>&1; then echo "hygiene failure ($label)"; printf '%s\n' "$files" | xargs -r grep -nE "$pattern" || true; fail=1; fi; }
check '/home/[A-Za-z0-9._-]+' 'home path'
check '/Users/[A-Za-z0-9._-]+' 'user path'
check '(ghp|gho)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+' 'token'
check 'sk(-ant)?-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}' 'token'
check '-----BEGIN( [A-Z]+)? PRIVATE KEY-----' 'private key'
check '[A-Za-z0-9.-]+\.ts\.net|100\.(6[4-9]|[7-9][0-9]|1[0-2][0-9])\.[0-9.]{3,}' 'tailnet'
# URLs such as git@github.com are not email addresses.
email_hits=$(printf '%s\n' "$files" | xargs -r grep -nE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net|io|dev)' | grep -v 'git@github\.com' || true)
if [ -n "$email_hits" ]; then echo 'hygiene failure (email)'; echo "$email_hits"; fail=1; fi
if printf '%s\n' "$files" | grep -E '(^|/)\.env($|\.)' >/dev/null; then echo 'hygiene failure (.env file)'; fail=1; fi
exit "$fail"
