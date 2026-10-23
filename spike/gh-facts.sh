#!/usr/bin/env bash
# Spike (throwaway): GitHub facts a gate / future RepoPolicySource could rely on.
# Usage: REPO=<owner>/<sandbox-repo> PR=<n> ./gh-facts.sh   (run with the token under test in GH_TOKEN or gh's keyring)
# Writes (commit status, comments, review request) go ONLY to a private throwaway sandbox repo.
set -u
: "${REPO:?}" "${PR:?}"
st() { echo "== $1"; shift; out=$("$@" 2>&1); rc=$?; echo "${out:0:1200}"; echo "   exit=$rc"; }
gh auth status 2>&1 | grep -E "Token:|scopes" | sed -E 's/(gh[opsu]_|github_pat_)[A-Za-z0-9_*]+/\1<redacted>/'
HEAD=$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)
BASE=$(gh api "repos/$REPO" --jq .default_branch)
st "pr view" gh pr view "$PR" -R "$REPO" --json mergeStateStatus,reviewDecision,statusCheckRollup,files
st "create commit status" gh api "repos/$REPO/statuses/$HEAD" -f state=success -f context=durable/spike -f description="spike status" --jq '{state,context}'
st "pr view after status" gh pr view "$PR" -R "$REPO" --json statusCheckRollup,mergeStateStatus
st "merge --match-head-commit flag" sh -c 'gh pr merge --help | grep -- --match-head-commit'
st "default-branch HEAD" gh api "repos/$REPO/commits/$BASE" --jq '{sha: .sha[0:12]}'
SHA=$(gh api "repos/$REPO/commits/$BASE" --jq .sha)
st "contents README@sha" gh api "repos/$REPO/contents/README.md?ref=$SHA" --jq '{type, path, blobSha: .sha[0:12], size, encoding}'
for p in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do
  st "contents $p@sha" gh api "repos/$REPO/contents/$p?ref=$SHA" --jq '{path, blobSha: .sha[0:12], size}'
done
st "git tree (recursive) blob shas" gh api "repos/$REPO/git/trees/$SHA?recursive=1" --jq '[.tree[] | {path, sha: .sha[0:12]}]'
st "rules for branch" gh api "repos/$REPO/rules/branches/$BASE"
st "rulesets list" gh api "repos/$REPO/rulesets"
st "branch protection" gh api "repos/$REPO/branches/$BASE/protection"
st "branch (protected flag)" gh api "repos/$REPO/branches/$BASE" --jq '{protected, protection_url: (.protection_url|tostring|length>0)}'
st "repo merge settings (gh)" gh repo view "$REPO" --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,deleteBranchOnMerge,visibility,viewerPermission
st "repo merge settings (REST)" gh api "repos/$REPO" --jq "{allow_auto_merge, allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge}"
