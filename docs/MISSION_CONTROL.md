# Mission Control

Mission Control is the hub-owned operating layer for coordinating many OpenCode projects and sessions. It adds a durable project registry, a bounded work queue, and an operator inbox without turning Telegram or the browser into a remote shell.

## Model

- A project is a stable key, display name, description, optional repository reference, and priority.
- A work item belongs to one project and carries a title, description, acceptance criteria, priority, state, and optional session attachment.
- The operator inbox is derived from unresolved OpenCode permission/questions plus blocked work. It is not a second action ledger.
- Project and work rows have monotonically increasing versions. Mutations use optimistic version checks so stale operators cannot silently overwrite newer state.

Work follows explicit transitions:

```text
backlog -> ready -> planning -> running -> verifying -> review -> completed
                    \         \          \          \-> blocked
                     \         \          \-> completed
                      \         \-> review/completed
                       \-> running

blocked -> ready | planning | running | cancelled
review  -> running | blocked | completed | cancelled
```

`completed` and `cancelled` are terminal. The CLI rejects transitions outside the graph.

## Operator Workflow

Create a project and queue work on the hub or standalone host:

```bash
opencode-telegram mission project add bridge "Telegram Bridge" \
  --description "Secure OpenCode operator plane" \
  --repository /srv/opencode-telegram \
  --priority high

opencode-telegram mission work add bridge "Ship Mission Control" \
  --description "Expose the durable queue in browser and Telegram" \
  --acceptance "Persistence, bounds, authorization, and views are verified" \
  --priority urgent
```

Inspect and advance work:

```bash
opencode-telegram mission project list
opencode-telegram mission project show bridge
opencode-telegram mission work list --active
opencode-telegram mission work list --project bridge --state blocked
opencode-telegram mission work show wrk_example
opencode-telegram mission work set wrk_example ready
opencode-telegram mission work set wrk_example running
opencode-telegram mission work attach wrk_example node-id:session-id
opencode-telegram mission work attach wrk_example none
```

Use `--json` on create, list, and show commands for automation. Quote names and titles containing spaces. Archive inactive projects with `mission project archive <id|key>`; archived projects remain durable and cannot receive new work.

## Read-Only Views

The authenticated browser dashboard exposes Overview, Projects, Queue, Inbox, and Sessions from one bounded snapshot. Telegram viewer commands are `/mission`, `/projects`, `/queue`, and `/inbox`. Both surfaces are read-only in v1.

OpenCode approval mutations remain in their exact existing Telegram messages. Mission Control inbox entries only point the operator toward that flow. Browser and Mission Control callbacks cannot dispatch node actions.

Telegram Mission Control views use opaque operation-only callback data, expire after 30 minutes, and are bound to the initiating user, authorized chat, configured topic, and exact bot message. Rich Messages use structured plain-text fields; unsupported Bot API servers receive clipped escaped HTML.

## Security Boundary

Mission Control does not accept arbitrary prompts, commands, paths, environment variables, or executable payloads. Repository references and session keys are labels, not launch instructions. Model-controlled project, work, and session text never controls callback semantics and is rendered as text.

Remote worktree/session launch is intentionally deferred. A future launcher requires a node-advertised capability, configured repository allowlists and base directories, bounded launch schemas, immutable launch identities, audit records, and an explicit protocol revision. It must not reuse approval dispatch or weaken the no-shell guarantee.
