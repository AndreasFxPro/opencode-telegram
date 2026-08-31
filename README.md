# opencode-telegram

`opencode-telegram` is a secure Telegram notification and approval companion for OpenCode TUI. OpenCode remains the source of truth: Telegram can act only on an already-pending request, and an action is not shown as successful until the originating TUI observes OpenCode settle it and continue.

> **Project status:** alpha. The protocol, durable hub/node path, fake Telegram integration, and OpenCode adapter are implemented and tested. Real interactive TUI E2E is intentionally not claimed yet; see [OpenCode compatibility](docs/OPENCODE_COMPATIBILITY.md).

## What It Does

- Notifies authorized Telegram chats about permissions, structured questions, failures, stuck states, and meaningful root-session completion.
- Routes allow-once, confirmed always-allow, rejection feedback, options, multi-select forms, sequential fields, free text, and cancellation to the exact host/TUI/session/request.
- Reconciles current TUI pending state after reconnect and edits existing Telegram messages when requests resolve locally.
- Multiplexes many local TUIs through one node and many machines through one hub, with exactly one Telegram `getUpdates` poller.
- Persists hub state, Telegram offsets, enrollment, callbacks, actions, message mappings, and a bounded node event spool in SQLite WAL databases.
- Keeps the bot token at the hub. Nodes and OpenCode plugins never receive it.

## Architecture

```text
OpenCode TUI ────────┐
OpenCode TUI ────────┤ authenticated loopback HTTP
OpenCode TUI ────────┤
                     ├── node ── outbound WebSocket ── hub ── Telegram
another host ─ node ─┤
another host ─ node ─┘
```

The plugin is thin and OpenCode-specific. The node owns local routing and replay. The hub owns authorization, action state, persistence, and the only Telegram poller.

## 30-Second Setup

Inspect-first installation is recommended:

```bash
curl -fsSLO https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/main/install.sh
less install.sh
bash install.sh
opencode-telegram setup
```

Convenience form:

```bash
curl -fsSL https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/main/install.sh | bash
opencode-telegram setup
```

From source:

```bash
bun install
bun run build
bun src/cli.ts setup
```

Setup validates OpenCode and Telegram, creates `0600` secrets, installs the supported global TUI package with `opencode plugin ... --global`, and prints the next command. Install the service after validating foreground operation:

```bash
opencode-telegram standalone
opencode-telegram service install
opencode-telegram doctor
```

## Multi-Host

On the hub:

```bash
opencode-telegram setup hub --hub https://opencode.example.com
opencode-telegram node create workstation-01
```

On a node:

```bash
opencode-telegram setup node \
  --hub https://opencode.example.com \
  --token oct_join_xxxxxxxxxxxxxxxxx
opencode-telegram service install
```

Non-loopback nodes require `wss://` unless the explicit development-only `--allow-insecure-hub` option is used. Nodes need no inbound public port.

## Telegram UX

```text
🔐 OpenCode needs approval

📁 example-project
🔑 ses_abc123

bash
m androidboot

[ ✅ Allow once ] [ 🧠 Always... ]
[ 💬 Reject with feedback ] [ ⛔ Reject ]
```

`Always...` opens a second screen showing the exact OpenCode-proposed rule. Wildcards receive a prominent warning. Callback data contains only a compact opaque ID and operation code.

Commands: `/start`, `/help`, `/status`, `/nodes`, `/sessions`, `/pending`, `/mute`, `/unmute`, `/whoami`.

OpenCode palette/slash commands: `/telegram-status`, `/telegram-test`, `/telegram-mute`.

## Security

- Telegram actions cannot execute arbitrary commands or read arbitrary files.
- A callback can only resolve an existing, unexpired request bound to its original node, TUI, session, location, and request ID.
- `Always` requires a second confirmation and is never broadened by the bridge.
- Authorization roles are `viewer`, `approver`, and `owner`.
- Node credentials are independent and revocable; enrollment tokens are random, expiring, single-use, and hash-stored.
- Model/project text is HTML-escaped and never controls button semantics.
- Bot tokens, node credentials, and local plugin secrets are redacted and stored separately with restrictive permissions.

Read [docs/SECURITY.md](docs/SECURITY.md) before exposing a hub.

## Configuration

See [`config.example.json`](config.example.json) and [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Secrets are stored separately and are never printed by `config show`.

Defaults are privacy-conscious: no final response preview, no arbitrary prompting, no subagent completion notifications, and a 20-second completion threshold.

## Compatibility

- Minimum mutation-safe OpenCode baseline: `1.17.7`.
- Developed against installed OpenCode `1.17.20` and SDK/plugin declarations `1.18.23`.
- Current TUI package discovery uses a package `./tui` export and `opencode plugin <module> --global`.
- API success is not settlement evidence. The adapter requires a matching replied event, pending prompt disappearance, and a continuation event.
- Remote workspace question routing remains an upstream risk; capability degradation is documented in [docs/OPENCODE_COMPATIBILITY.md](docs/OPENCODE_COMPATIBILITY.md).

## Development

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
bun run package:smoke
```

Fast integration tests use local hub/node services and a fake Telegram Bot API. The real TUI test is opt-in and must be supplied an audited harness:

```bash
OPENCODE_REAL_E2E=1 \
OPENCODE_REAL_E2E_HARNESS='./tests/e2e/run-real-opencode.sh' \
bun run test:e2e
```

## Operations

```bash
opencode-telegram status
opencode-telegram doctor --json
opencode-telegram node list
opencode-telegram service restart
opencode-telegram logs
opencode-telegram config validate
```

Troubleshooting: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Review gates: [docs/REVIEWS.md](docs/REVIEWS.md).

## License

MIT
