#!/usr/bin/env bash
# Stop strad-hostd and remove its LaunchAgent and code. Pass --purge to also
# delete the state directory (config, keys, audit log). The Cloudflare tunnel and
# its DNS record are left alone: `cloudflared tunnel delete strad-hostd`.
set -euo pipefail

STATE="${STRAD_HOSTD_HOME:-$HOME/.strad-hostd}"
LABEL="com.strad.hostd"

if [ "$(uname)" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
fi
rm -rf "$STATE/app"
if [ "${1:-}" = "--purge" ]; then rm -rf "$STATE"; fi
echo "strad-hostd is uninstalled."
