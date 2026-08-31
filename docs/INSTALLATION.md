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

## Single Command

The installer passes arguments after `bash -s --` to the installed CLI and uses the controlling terminal for interactive prompts:

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/main/install.sh | bash -s -- setup'
```

On a configured hub, `opencode-telegram node create <name>` prints a complete single-use command that installs and enrolls that node. Treat the command as a temporary secret because it contains the 15-minute, single-use enrollment token and may be retained in shell history.

## Install Log

Each platform check, download, checksum, destination, setup invocation, and service restart is printed and appended to:

```text
~/.local/state/opencode-telegram/install.log
```

The default state directory is `0700` and the log is always `0600`. Override the path with `OPENCODE_TELEGRAM_INSTALL_LOG`.

## Update

Rerun the installer without setup arguments:

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/main/install.sh | bash'
```

Configuration and secrets are retained. Release files are checksum-verified and each file is atomically replaced. If the service is active, the installer restarts it. Restart existing OpenCode TUIs to load the new TUI plugin bundle.

Set `OPENCODE_TELEGRAM_RESTART_SERVICE=never` to replace files without restarting an active service.

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
