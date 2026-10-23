# Durable worker brief

Load `idea-to-pr` and run it in autopilot mode for this task. This workspace is isolated.
Stop at a draft PR, even if a loaded workflow normally proceeds to merge.

- Do not merge a pull request.
- Do not force-push or push to a default or protected branch.
- Create a draft PR only, with the required durable label and marker.
- Do not read, print, or add secrets to files, commits, or PR text.

## Task

{{brief}}

## Attribution

Branch: `{{branch}}`
Commit trailer: `Durable-Agent: {{agent}}`
PR label: `durable/agent:{{agent}}`
PR marker: `<!-- durable-item agent={{agent}} item={{item}} -->`
PR footer: `Opened by durable agent {{agent}} for {{login}}; not yet reviewed by a human.`
