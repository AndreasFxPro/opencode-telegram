# Multi-Host

Run one hub per bot and one node per machine. Never run independent hub/standalone pollers with the same token; Telegram `getUpdates` offsets would conflict.

The hub creates a 15-minute one-time enrollment token. A node exchanges it over HTTPS for a random persistent credential. The hub stores only credential hashes. Revoke or rename nodes with the CLI.

```bash
opencode-telegram node create build-server
opencode-telegram node list
opencode-telegram node revoke node_xxx
opencode-telegram node rename node_xxx new-name
```

Nodes open outbound WebSockets, so no inbound node firewall rule is needed. Reverse proxies must support WebSocket upgrade on `/v1/node/ws`, preserve `Authorization` and `x-node-id`, and use suitable idle timeouts. `/v1/enroll` and `/health` are HTTP endpoints.
