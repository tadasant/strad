#!/bin/bash
# launchd.sh against the real launchd, on the macOS runner (hostd-ax.yml). It
# loads a throwaway agent that takes three seconds to die, then drives the three
# paths through it. test/install.test.ts has the decisions; this has the claims
# about launchd that a stub can only repeat.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=install/launchd.sh
. "$HERE/launchd.sh"

LABEL="com.strad.hostd-smoke"
DIR="$(mktemp -d)"
PLIST="$DIR/installed/$LABEL.plist"
mkdir -p "$DIR/installed" "$HOME/Library/Logs"

render() {
  cat >"$1" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-c</string>
      <string>trap 'sleep 3; exit 0' TERM; while :; do sleep 1; done # $2</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
  </dict>
</plist>
XML
}
pid() { launchd_pid "$LABEL"; }
await_pid() {
  local waited=0
  until [ -n "$(pid)" ] && [ "$(pid)" != "${1:-}" ]; do
    [ "$waited" -lt 30 ] || { echo "no new pid after 30 seconds"; return 1; }
    sleep 1
    waited=$((waited + 1))
  done
}
# shellcheck disable=SC2329 # run by the trap
cleanup() {
  launchd_disarm "$LABEL.reload"
  launchd_disarm "$LABEL"
}
trap cleanup EXIT

echo "manager: $(launchctl managername), domain: $(launchd_domain)"
launchctl print "$(launchd_domain)" >/dev/null

echo "== not loaded: bootstrap"
render "$DIR/$LABEL.plist" one
launchd_install "$LABEL" "$PLIST" "$DIR"
launchd_loaded "$LABEL"
await_pid

echo "== loaded, plist unchanged: kickstart, never unloaded"
before="$(pid)"
render "$DIR/$LABEL.plist" one
launchd_install "$LABEL" "$PLIST" "$DIR"
await_pid "$before"
launchd_loaded "$LABEL"

echo "== loaded, plist changed: the one-shot, across a three-second teardown"
before="$(pid)"
render "$DIR/$LABEL.plist" two
launchd_install "$LABEL" "$PLIST" "$DIR"
await_pid "$before"
definition="$(launchctl print "$(launchd_target "$LABEL")")"
case "$definition" in
  *"# two"*) ;;
  *) echo "launchd is still running the old definition"; exit 1 ;;
esac
grep -q '# two' "$PLIST"
if launchd_loaded "$LABEL.reload"; then
  echo "the one-shot was left loaded"
  exit 1
fi

echo "== bootout, then bootstrap straight away: what the wait is for"
launchctl bootout "$(launchd_target "$LABEL")" || echo "bootout exit $?"
if launchd_loaded "$LABEL"; then
  echo "still loaded the moment bootout returned"
else
  echo "gone the moment bootout returned"
fi
launchctl bootstrap "$(launchd_domain)" "$PLIST" || echo "immediate bootstrap exit $?"
launchd_disarm "$LABEL"

echo "== a plist launchd refuses never reaches the service"
render "$DIR/$LABEL.plist" three
launchd_install "$LABEL" "$PLIST" "$DIR"
await_pid
before="$(pid)"
echo "not a plist" >"$DIR/$LABEL.plist"
if launchd_install "$LABEL" "$PLIST" "$DIR"; then
  echo "a plist that does not lint was installed"
  exit 1
fi
[ "$(pid)" = "$before" ]
launchd_disarm "$LABEL"

echo "== refused: the diagnostics"
echo "not a plist" >"$DIR/bad.plist"
LAUNCHD_BOOTSTRAP_DELAYS="1"
if launchd_bootstrap "$LABEL" "$DIR/bad.plist"; then
  echo "launchd accepted a file that is not a plist"
  exit 1
fi
echo "ok"
