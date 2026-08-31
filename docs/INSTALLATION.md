# Installation

## Release

Inspect `install.sh` before execution. It detects Linux/macOS and x64/arm64, downloads the matching binary and TUI bundle, verifies release SHA-256 checksums, and atomically replaces the executable while retaining configuration.

```bash
curl -fsSLO https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/main/install.sh
less install.sh
bash install.sh
opencode-telegram setup
```

The release installer writes no credentials. Setup creates them later.

## Source

```bash
git clone https://github.com/AndreasFxPro/opencode-telegram.git
cd opencode-telegram
bun install
bun test
bun src/cli.ts setup
```

## OpenCode Plugin

OpenCode 1.17.20/1.18.23 does not auto-discover a global TUI plugin directory. TUI packages must expose `./tui` and be listed by the supported installer in global `tui.json`/`tui.jsonc`. Setup therefore runs:

```bash
opencode plugin <opencode-telegram-plugin-package> --global --force
```

This is idempotent and avoids undocumented plugin locations.

## Services

```bash
opencode-telegram service install
opencode-telegram service status
```

Linux uses `systemd --user`; macOS uses a user LaunchAgent. Root is not required. WSL works when user systemd is available; otherwise run the selected mode in a persistent user process.

## Managed Global Instruction

Setup offers this change and defaults to no. It uses managed markers so install/update/uninstall is idempotent. It can also be managed explicitly:

```bash
opencode-telegram instructions install
opencode-telegram instructions uninstall
```

Managed content:

```md
When execution cannot continue without user input, a decision, clarification,
confirmation, or selection, use OpenCode's current structured question
mechanism instead of only asking in prose.

Do not use it for rhetorical questions or when execution can safely continue.
```
