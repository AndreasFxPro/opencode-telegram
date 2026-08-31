#!/usr/bin/env bash
set -euo pipefail

REPO="${OPENCODE_TELEGRAM_REPO:-AndreasFxPro/opencode-telegram}"
VERSION="${OPENCODE_TELEGRAM_VERSION:-latest}"
BIN_DIR="${OPENCODE_TELEGRAM_BIN_DIR:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-telegram"
PLUGIN_DIR="$DATA_DIR/plugin"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) printf 'Unsupported operating system: %s\n' "$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

if [[ "$VERSION" == latest ]]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
asset="opencode-telegram-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/opencode-telegram-tui.js" -o "$tmp/opencode-telegram-tui.js"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c SHA256SUMS --ignore-missing)
elif command -v shasum >/dev/null 2>&1; then
  for file in "$asset" opencode-telegram-tui.js; do
    expected="$(awk -v file="$file" '$2 == file {print $1}' "$tmp/SHA256SUMS")"
    actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"
    [[ -n "$expected" && "$expected" == "$actual" ]] || { echo "Checksum verification failed: $file" >&2; exit 1; }
  done
else
  echo 'sha256sum or shasum is required for verified installation.' >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$PLUGIN_DIR"
chmod 700 "$DATA_DIR" "$PLUGIN_DIR"
install -m 0755 "$tmp/$asset" "$BIN_DIR/.opencode-telegram.new"
mv -f "$BIN_DIR/.opencode-telegram.new" "$BIN_DIR/opencode-telegram"
install -m 0644 "$tmp/opencode-telegram-tui.js" "$PLUGIN_DIR/tui.js"
cat >"$PLUGIN_DIR/package.json" <<'JSON'
{
  "name": "opencode-telegram-release-plugin",
  "private": true,
  "type": "module",
  "exports": { "./tui": "./tui.js" },
  "engines": { "opencode": ">=1.17.7 <2" }
}
JSON

printf 'Installed %s\n' "$BIN_DIR/opencode-telegram"
printf 'If necessary, add %s to PATH. Then run: opencode-telegram setup\n' "$BIN_DIR"
