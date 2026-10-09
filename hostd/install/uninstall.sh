#!/usr/bin/env bash
# Stop strad-hostd and remove its LaunchAgents and code. Pass --purge to also
# delete the state directory (config, keys, audit log, the helper binary). Left
# alone, on purpose: the Cloudflare tunnel and its DNS record (`cloudflared
# tunnel delete strad-hostd`), the logs under ~/Library/Logs/com.strad.hostd*,
# the "strad-hostd-ax" code-signing certificate in the login keychain, and the
# helpers' entries in System Settings › Privacy & Security (Accessibility and
# Screen Recording for strad-hostd-ax, Full Disk Access for
# strad-hostd-messages).
set -euo pipefail

STATE="${STRAD_HOSTD_HOME:-$HOME/.strad-hostd}"
LABEL="com.strad.hostd"
AX_LABEL="com.strad.hostd-ax"
MESSAGES_LABEL="com.strad.hostd-messages"

if [ "$(uname)" = "Darwin" ]; then
  for label in "$LABEL" "$AX_LABEL" "$MESSAGES_LABEL"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$label.plist"
  done
fi
rm -rf "$STATE/app" "$STATE/bin" "$STATE/ax.sock" "$STATE/messages.sock"
if [ "${1:-}" = "--purge" ]; then
  # STATE comes from the environment. Only delete a directory that is
  # recognisably this daemon's, so a stray STRAD_HOSTD_HOME=$HOME cannot cost a
  # home directory.
  if [ -f "$STATE/config.json" ] || [ -f "$STATE/audit.jsonl" ] || [ -z "$(ls -A "$STATE" 2>/dev/null)" ]; then
    rm -rf "$STATE"
  else
    echo "not purging $STATE: it does not look like a strad-hostd state directory" >&2
    exit 1
  fi
fi
echo "strad-hostd is uninstalled."
