# Development

Requirements: Bun 1.4 or newer and OpenCode 1.17.7 or newer for mutation testing.

```bash
bun install
bun run dev
bun test
bun run typecheck
bun run lint
bun run build
bun run package:smoke
```

Tests use temporary SQLite databases and loopback ports. `tests/integration/node-hub.test.ts` runs real Bun HTTP/WebSocket services. `tests/integration/telegram.test.ts` runs a fake Bot API. No Telegram credentials are needed.

Keep protocol changes backward-aware and versioned. Keep OpenCode generation/version checks in `src/opencode/`. Never weaken confirmation evidence to make a flaky test pass.
