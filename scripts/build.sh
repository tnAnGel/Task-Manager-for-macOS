#!/usr/bin/env bash
#
# Task Manager for macOS — one-command build.
#
# Does everything for you: checks macOS, installs Node.js if it's missing,
# installs the project dependencies, downloads the Electron runtime (falling
# back to a mirror if GitHub is blocked), and builds a .dmg into ./dist/.
#
# Usage:
#   ./scripts/build.sh            # build for this Mac (auto-detected)
#   ./scripts/build.sh arm64      # force Apple Silicon
#   ./scripts/build.sh x64        # force Intel
#   ./scripts/build.sh universal  # one app for both

set -uo pipefail
cd "$(dirname "$0")/.."

# ----------------------------------------------------------------- pretty output
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'
  BL=$'\033[34m'; C=$'\033[36m'; X=$'\033[0m'
else
  B=; D=; R=; G=; Y=; BL=; C=; X=
fi
STEP=0; TOTAL=5
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d] %s%s\n' "$B$BL" "$STEP" "$TOTAL" "$1" "$X"; }
info() { printf '      %s\n' "$1"; }
ok()   { printf '      %s✓%s %s\n' "$G" "$X" "$1"; }
warn() { printf '      %s!%s %s\n' "$Y" "$X" "$1"; }
die()  { printf '\n%s✗ %s%s\n\n' "$R" "$1" "$X"; exit 1; }
ask()  { printf '      %s?%s %s [y/N] ' "$Y" "$X" "$1"; local a=""; read -r a </dev/tty 2>/dev/null || a=""; [[ "$a" =~ ^[Yy] ]]; }

ARCH_ARG="${1:-auto}"

# ----------------------------------------------------------------- banner
printf '%s\n' "$C$B"
printf '   ┌───────────────────────────────────────────────┐\n'
printf '   │   Task Manager for macOS — build assistant      │\n'
printf '   └───────────────────────────────────────────────┘\n'
printf '%s\n' "$X"
printf '   This script will, if needed:\n'
printf '     • install %sNode.js%s (only if it is missing)\n' "$B" "$X"
printf '     • install dependencies: %sElectron, electron-builder, systeminformation%s\n' "$D" "$X"
printf '     • download the Electron runtime (uses a mirror if GitHub is blocked)\n'
printf '     • build a %s.dmg%s installer into %s./dist/%s\n' "$B" "$X" "$B" "$X"
printf '   Nothing is sent anywhere; everything is built locally.\n'

# ----------------------------------------------------------------- 1. system
step "Checking your system"
[ "$(uname)" = "Darwin" ] || die "This builds a macOS app, so it must be run on a Mac."
ok "macOS $(sw_vers -productVersion 2>/dev/null || true)"
case "$(uname -m)" in
  arm64)  HOST=arm64 ;;
  x86_64) HOST=x64 ;;
  *)      die "Unsupported CPU: $(uname -m)" ;;
esac
if [ "$ARCH_ARG" = "auto" ]; then ARCH="$HOST"; else ARCH="$ARCH_ARG"; fi
case "$ARCH" in arm64|x64|universal) ;; *) die "Unknown target '$ARCH' (use arm64 | x64 | universal)";; esac
ok "Building for: $B$ARCH$X"

# ----------------------------------------------------------------- 2. node.js
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local maj
  maj="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [ -n "$maj" ] && [ "$maj" -ge 18 ] 2>/dev/null
}

install_node() {
  if command -v brew >/dev/null 2>&1; then
    info "Homebrew found — installing Node.js…"
    brew install node && node_ok && return 0
  fi
  warn "Node.js 18+ is required and isn't installed."
  ask "Download & install the latest Node.js LTS from nodejs.org now? (will ask for your password)" || return 1
  local ver pkg tmp
  info "Looking up the latest LTS version…"
  ver="$(curl -fsSL https://nodejs.org/dist/index.tab 2>/dev/null | awk -F'\t' 'NR>1 && $10!="-" {print $1; exit}')"
  [ -n "$ver" ] || { warn "Couldn't reach nodejs.org."; return 1; }
  pkg="node-${ver}.pkg"
  tmp="$(mktemp -d)/$pkg"
  info "Downloading Node.js $ver…"
  curl -fL --progress-bar "https://nodejs.org/dist/${ver}/${pkg}" -o "$tmp" || { warn "Download failed."; return 1; }
  info "Installing Node.js (enter your macOS password if prompted)…"
  sudo installer -pkg "$tmp" -target / || return 1
  hash -r
  node_ok
}

step "Checking Node.js"
if node_ok; then
  ok "Node.js $(node -v) and npm $(npm -v)"
else
  if install_node; then
    ok "Node.js $(node -v) installed"
  else
    die "Node.js is required. Install it from https://nodejs.org/ and run this again."
  fi
fi

# ----------------------------------------------------------------- 3. deps
step "Installing dependencies"
info "Running npm install (this can take a minute the first time)…"
npm install --no-audit --no-fund || die "npm install failed. Check your internet connection and try again."
ok "Dependencies installed"

# ----------------------------------------------------------------- 4. electron runtime
USED_MIRROR=""
ensure_electron() {
  [ -d node_modules/electron/dist ] && return 0
  info "Downloading the Electron runtime…"
  node node_modules/electron/install.js >/dev/null 2>&1
  [ -d node_modules/electron/dist ] && return 0
  warn "Direct download failed — GitHub looks blocked. Trying mirrors…"
  local m
  for m in "https://npmmirror.com/mirrors/electron/" "https://registry.npmmirror.com/-/binary/electron/"; do
    info "Mirror: $m"
    ELECTRON_MIRROR="$m" node node_modules/electron/install.js >/dev/null 2>&1
    if [ -d node_modules/electron/dist ]; then USED_MIRROR="$m"; return 0; fi
  done
  return 1
}

step "Preparing the Electron runtime"
if ensure_electron; then
  [ -n "$USED_MIRROR" ] && ok "Electron downloaded via mirror" || ok "Electron runtime ready"
else
  die "Couldn't download Electron. Allow github.com (and objects.githubusercontent.com) in your
   firewall/AdGuard, OR re-run with a mirror, e.g.:
     ELECTRON_MIRROR=\"https://npmmirror.com/mirrors/electron/\" ./scripts/build.sh"
fi

# ----------------------------------------------------------------- 5. build
step "Building the app (this takes a moment)…"
[ -n "$USED_MIRROR" ] && export ELECTRON_MIRROR="$USED_MIRROR"
case "$ARCH" in
  arm64)     npx electron-builder --mac --arm64 ;;
  x64)       npx electron-builder --mac --x64 ;;
  universal) npx electron-builder --mac --universal ;;
esac || die "The build failed — see the output above."

DMG="$(ls -t dist/*.dmg 2>/dev/null | head -1)"
printf '\n%s✓ Done!%s\n' "$G$B" "$X"
if [ -n "$DMG" ]; then
  printf '   Your installer: %s%s%s\n' "$B" "$DMG" "$X"
else
  printf '   Output is in %s./dist/%s\n' "$B" "$X"
fi
printf '   Opening the dist folder…\n'
open dist 2>/dev/null || true
printf '\n   %sFirst launch:%s the app isn'\''t code-signed, so right-click it → Open\n' "$D" "$X"
printf '   (or run: xattr -dr com.apple.quarantine "/Applications/Task Manager.app").\n\n'
