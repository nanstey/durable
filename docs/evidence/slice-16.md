# Slice 16 evidence

## Automated boundary

- `test/unit/improve.test.ts` covers outcome grouping, bounded code-owned evidence, opt-in and repeat-threshold refusal, hard allowlist refusal, and draft-only proposal creation through a fake GitHub adapter.
- Proposal paths are limited in code to skills/prompt files or an agent definition's `scope.repos[].pipeline` location. Engine, gate, approval, policy, credential, and GitHub configuration paths are rejected.
- A proposal API has no dispatch, gate, approval, merge, or running-pipeline mutation route. GitHub writes use the existing fenced, audited identity adapter and reject a non-draft response.

## Live run

**Pending operator.** Enable one repository's `scope.repos[].pipeline.improve` setting, review the grouped evidence with `durable improve`, and inspect the resulting draft PR before any human merge. No live proposal was opened for this evidence record.
