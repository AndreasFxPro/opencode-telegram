# Multi-Host

Run one hub per bot and one node per machine. Never run independent hub/standalone pollers with the same token; Telegram `getUpdates` offsets would conflict.

The hub creates a 15-minute one-time enrollment token. A node exchanges it over HTTPS for a random persistent credential. The hub stores only credential hashes. Revoke or rename nodes with the CLI.

```bash
opencode-telegram node create build-server
opencode-telegram node list
opencode-telegram node revoke node_xxx
opencode-telegram node rename node_xxx new-name
```

`node create` prints the token, expiry, and a ready-to-run command like:

```bash
(installer="$(mktemp)" && trap 'rm -f "$installer"' EXIT && curl -fsSL 'https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/v0.2.0/install.sh' -o "$installer" && OPENCODE_TELEGRAM_VERSION='v0.2.0' OPENCODE_TELEGRAM_ENROLLMENT_TOKEN='oct_join_...' bash "$installer" setup node --hub 'https://opencode.example.com')
```

Run it only on the intended node and do not share it. The token is passed through the installer's environment rather than its process arguments, but may be retained in shell history, so use a private administrative shell appropriate to your threat model. The installer verifies a release matching the generating hub version, runs setup, and prints the remaining service command. The node's first authenticated connection notifies configured Telegram chats when `notifications.nodeJoin` is enabled.

Nodes open outbound WebSockets, so no inbound node firewall rule is needed. Reverse proxies must support WebSocket upgrade on `/v1/node/ws`, preserve `Authorization` and `x-node-id`, and use suitable idle timeouts. `/v1/enroll` and `/health` are HTTP endpoints.
