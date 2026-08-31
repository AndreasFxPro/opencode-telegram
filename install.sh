#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${OPENCODE_TELEGRAM_REPO:-AndreasFxPro/opencode-telegram}"
VERSION="${OPENCODE_TELEGRAM_VERSION:-latest}"
BIN_DIR="${OPENCODE_TELEGRAM_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-telegram"
PLUGIN_DIR="$DATA_DIR/plugin"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-telegram"
LOG_FILE="${OPENCODE_TELEGRAM_INSTALL_LOG:-$STATE_DIR/install.log}"
BIN="$BIN_DIR/opencode-telegram"
RESTART_SERVICE="${OPENCODE_TELEGRAM_RESTART_SERVICE:-auto}"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

log() {
  printf '[opencode-telegram] %s\n' "$*"
}

tmp=""
finish() {
  status=$?
  trap - EXIT
  [[ -z "$tmp" ]] || rm -rf "$tmp"
  if ((status != 0)); then
    log "Install failed with exit code $status. Full log: $LOG_FILE"
  fi
  exit "$status"
}
trap finish EXIT

log "Install started at $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
log "Full log: $LOG_FILE"
log "[1/7] Detecting platform"
if [[ "$RESTART_SERVICE" != auto && "$RESTART_SERVICE" != never ]]; then
  log "OPENCODE_TELEGRAM_RESTART_SERVICE must be 'auto' or 'never'."
  exit 1
fi
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) log "Unsupported operating system: $(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) log "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac
log "Platform: $os-$arch"

if [[ "$VERSION" == latest ]]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
asset="opencode-telegram-$os-$arch"
tmp="$(mktemp -d)"
previous_version=""
service_active=false
if [[ -x "$BIN" ]]; then
  previous_version="$("$BIN" version 2>/dev/null || true)"
fi
if [[ "$RESTART_SERVICE" == auto && "$os" == linux ]] && command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet opencode-telegram.service; then
  service_active=true
elif [[ "$RESTART_SERVICE" == auto && "$os" == darwin ]] && launchctl print "gui/$(id -u)/dev.opencode.telegram" >/dev/null 2>&1; then
  service_active=true
fi

log "[2/7] Resolving release"
log "Repository: $REPO"
log "Requested version: $VERSION"
log "Release base: $base"
[[ -z "$previous_version" ]] || log "Installed version: $previous_version"

log "[3/7] Downloading release assets"
log "Downloading $asset"
curl -fsSL --retry 3 "$base/$asset" -o "$tmp/$asset"
log "Downloading opencode-telegram-tui.js"
curl -fsSL --retry 3 "$base/opencode-telegram-tui.js" -o "$tmp/opencode-telegram-tui.js"
log "Downloading SHA256SUMS"
curl -fsSL --retry 3 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

log "[4/7] Verifying SHA-256 checksums"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c SHA256SUMS --ignore-missing)
elif command -v shasum >/dev/null 2>&1; then
  for file in "$asset" opencode-telegram-tui.js; do
    expected="$(awk -v file="$file" '$2 == file {print $1}' "$tmp/SHA256SUMS")"
    actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"
    [[ -n "$expected" && "$expected" == "$actual" ]] || { log "Checksum verification failed: $file"; exit 1; }
    log "$file: OK"
  done
else
  log "sha256sum or shasum is required for verified installation."
  exit 1
fi

log "[5/7] Installing binary and TUI plugin"
mkdir -p "$BIN_DIR" "$PLUGIN_DIR"
chmod 700 "$DATA_DIR" "$PLUGIN_DIR"
install -m 0755 "$tmp/$asset" "$BIN_DIR/.opencode-telegram.new"
mv -f "$BIN_DIR/.opencode-telegram.new" "$BIN"
install -m 0644 "$tmp/opencode-telegram-tui.js" "$PLUGIN_DIR/.tui.js.new"
mv -f "$PLUGIN_DIR/.tui.js.new" "$PLUGIN_DIR/tui.js"
cat >"$PLUGIN_DIR/.package.json.new" <<'JSON'
{
  "name": "opencode-telegram-release-plugin",
  "private": true,
  "type": "module",
  "exports": { "./tui": "./tui.js" },
  "engines": { "opencode": ">=1.17.7 <2" }
}
JSON
chmod 644 "$PLUGIN_DIR/.package.json.new"
mv -f "$PLUGIN_DIR/.package.json.new" "$PLUGIN_DIR/package.json"
installed_version="$("$BIN" version)"
if [[ -n "$previous_version" ]]; then
  log "Updated $previous_version -> $installed_version"
else
  log "Installed version $installed_version"
fi
log "Binary: $BIN"
log "TUI plugin: $PLUGIN_DIR"

if (($# > 0)); then
  log "[6/7] Running requested post-install command"
  if [[ -t 0 ]]; then
    "$BIN" "$@"
  elif { exec 3</dev/tty; } 2>/dev/null; then
    "$BIN" "$@" <&3
    exec 3<&-
  else
    "$BIN" "$@"
  fi
else
  log "[6/7] No post-install command requested"
fi

if [[ "$service_active" == true ]]; then
  log "[7/7] Restarting active service"
  "$BIN" service restart
else
  log "[7/7] No active service to restart"
fi

if [[ -z "$previous_version" && $# -eq 0 ]]; then
  log "Next: $BIN setup"
elif (($# > 0)) && [[ "$service_active" == false ]]; then
  log "Next: $BIN service install"
fi
log "Restart running OpenCode TUIs to load the installed plugin bundle."
log "Install completed successfully. Full log: $LOG_FILE"
