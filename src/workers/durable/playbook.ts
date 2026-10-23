export const interruptedToolPlaybook = `
## Interrupted tool recovery

A non-replay-safe tool can return \`interrupted\` after a steward crash or restart. Do not assume whether its effect happened. Before repeating it, inspect \`git status\`, the relevant files, and the remote branch or draft PR where applicable. Reuse the code-owned push_branch and open_draft_pr tools to reconcile their recorded intent; never use bash to force a retry.
`;
