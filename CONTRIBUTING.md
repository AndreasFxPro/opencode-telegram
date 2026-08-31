# Contributing

1. Open an issue for substantial protocol, security, or persistence changes.
2. Run `bun install`, `bun test`, `bun run typecheck`, `bun run lint`, and `bun run build`.
3. Add a regression test for every bug fix, especially routing and idempotency defects.
4. Keep OpenCode-specific behavior inside `src/opencode/`.
5. Never add real Telegram credentials, captured private prompts, or user paths to fixtures.

Changes to authorization, callback handling, enrollment, saved permissions, or remote prompting require a threat-model update.
