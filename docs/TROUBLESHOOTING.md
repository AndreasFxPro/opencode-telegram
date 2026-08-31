# Troubleshooting

## Notification Arrives But Approval Fails

Run `/telegram-status` in the originating TUI and `opencode-telegram doctor`. Confirm OpenCode is at least 1.17.7. A `200` is intentionally insufficient; the error lists which evidence was absent. Resolve locally if uncertain.

## Plugin Missing

Run `opencode plugin <plugin-package-path> --global --force`, restart existing TUIs, and inspect global `tui.json`/`tui.jsonc`. Current TUI plugins are not discovered from a global directory automatically.

## Hub Offline

OpenCode remains usable. The node spools bounded events and reconnects with jittered exponential backoff. Check TLS, reverse-proxy WebSocket upgrade, and node revocation status.

## Telegram Conflict

Stop every other poller using the bot token. There must be exactly one hub or standalone process per bot.

## Stale Prompt After OpenCode Restart

OpenCode pending continuations are process-local. Answer the newly created request if one appears; do not replay an old callback.
