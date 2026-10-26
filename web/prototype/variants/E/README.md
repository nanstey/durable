# Variant E modules

`E.js` owns routing and keyboard shortcuts. `shell/` owns the rail; `conversations/` owns filters, list, transcript, composer and detail pane. Add a page in `pages/<id>/index.js`, register its lazy import in `pages/registry.js`, and keep its page-specific CSS in `<id>.css` (imported by `E.css`).

CSS tokens in `tokens.css`: `--bg`, `--panel`, `--raise`, `--line`, `--text`, `--muted`, `--accent`, `--run`, `--wait`, `--error`, `--radius`, `--space`, `--motion`. They work in `.dark` and light mode.

Shared kit (`ui/index.js`): `Icon`, `StatusPill`, `Chip`, `Menu`, `Dialog`, `Tabs`, `EmptyState`, `Kbd`, and `tone`. `PageVariants` stores the selected `pv` URL parameter. Page props are `{ nav, conversations, selectConversation, data }`; `data` provides projects, agentsList, orgs, devices, approvals, workItems, inbox, metrics, and connectors.
