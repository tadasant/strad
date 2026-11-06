#!/usr/bin/env bash
# Install strad-hostd on this machine: build it, copy it out of the clone, write
# its config, optionally create its Cloudflare tunnel, and (on macOS) install the
# LaunchAgent that keeps it running.
#
#   ./install/install.sh --machine "Tadas's MacBook Pro" --suffix tadas-mbp \
#                        --hostname hostd.example.com
#
# Idempotent: re-running it upgrades the code and leaves the config, the keys and
# the tunnel alone. Without --hostname it installs a loopback-only daemon and
# touches nothing at Cloudflare.
#
# On macOS it also builds strad-hostd-ax (the native helper behind the two
# computer-use servers and the on-screen banner) and strad-hostd-messages (the
# read-only helper behind the messages server, and the one process that holds
# Full Disk Access) when `swift` is available, signs each with a stable
# identity (install/sign-helper.sh), installs them to $STATE/bin and runs each
# as its own LaunchAgent. --no-helper skips all of that.
#
# Safe to run with nobody at the machine, over the shell the daemon itself
# serves. A helper that fails does not stop the daemon step: every failure is
# named at the end and the exit is non-zero. install/launchd.sh is how a service
# is restarted without a window in which losing this script loses the machine.
set -euo pipefail

MACHINE="this machine"
SUFFIX=""
HOSTNAME_ARG=""
TUNNEL_NAME="strad-hostd"
AGENT=1
HELPER=1
SIGN_IDENTITY="${STRAD_HOSTD_SIGN_IDENTITY:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --machine) MACHINE="$2"; shift 2 ;;
    --suffix) SUFFIX="$2"; shift 2 ;;
    --hostname) HOSTNAME_ARG="$2"; shift 2 ;;
    --tunnel-name) TUNNEL_NAME="$2"; shift 2 ;;
    --no-agent) AGENT=0; shift ;;
    --no-helper) HELPER=0; shift ;;
    --sign-identity) SIGN_IDENTITY="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${STRAD_HOSTD_HOME:-$HOME/.strad-hostd}"
APP="$STATE/app"
LABEL="com.strad.hostd"
AX_LABEL="com.strad.hostd-ax"
MESSAGES_LABEL="com.strad.hostd-messages"
RELOAD="$STATE/reload"
FAILED=""

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
# A step that failed and must not stop the steps after it. Named again at the end.
failed() {
  printf 'error: %s\n' "$*" >&2
  FAILED="$FAILED  - $*
"
}

# shellcheck source=install/launchd.sh
. "$HERE/install/launchd.sh"

command -v node >/dev/null || die "node is not installed (need 22.4 or newer): brew install node"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=4)?0:1)' \
  || die "node $(node -v) is too old; strad-hostd needs 22.4 or newer"
NODE="$(command -v node)"

say "Building"
(cd "$HERE" && npm ci --no-audit --no-fund && npm run build)

say "Installing to $APP"
mkdir -p "$STATE" && chmod 700 "$STATE"
rm -rf "$APP.new"
mkdir -p "$APP.new"
cp -R "$HERE/build" "$HERE/extension" "$HERE/package.json" "$HERE/package-lock.json" "$APP.new/"
(cd "$APP.new" && npm ci --omit=dev --no-audit --no-fund)
# The build the daemon is running stays beside the new one until the next
# install: it is what the daemon step rolls back to.
rm -rf "$APP.previous"
if [ -d "$APP" ]; then mv "$APP" "$APP.previous"; fi
mv "$APP.new" "$APP"
HOSTD=("$NODE" "$APP/build/cli.js")

if [ ! -f "$STATE/config.json" ]; then
  say "Writing config and generating keys"
  STRAD_HOSTD_HOME="$STATE" "${HOSTD[@]}" init --machine "$MACHINE" --suffix "${SUFFIX:-hostd}"
else
  say "Keeping the existing $STATE/config.json"
  # A config from before a server existed does not know it: enable it, with a
  # fresh key. A server the config already knows — enabled, or switched off by
  # its owner — is left exactly as it is. Without --suffix the new server is
  # named after the existing shell server's suffix.
  for cap in shell browser computer-headless computer messages; do
    if [ -n "$SUFFIX" ]; then
      STRAD_HOSTD_HOME="$STATE" "${HOSTD[@]}" add "$cap" --suffix "$SUFFIX"
    else
      STRAD_HOSTD_HOME="$STATE" "${HOSTD[@]}" add "$cap"
    fi
  done
fi

# The native helper: Swift, macOS only. Built from hostd/ax, signed with a
# stable identity so its TCC grants survive rebuilds, copied beside the app so
# the clone can go away. Without `swift`, the two computer-use servers are
# served but refuse every request with "helper not running", and the shell and
# browser servers are unaffected.
#
# Both helpers run as `install_x || failed …`, which switches `set -e` off inside
# them, so every step that can fail says `|| return 1` itself. A helper is never
# a reason to skip the daemon step.
install_ax() {
  say "Building strad-hostd-ax"
  (cd "$HERE/ax" && swift build -c release 2>&1 | tail -3) || return 1
  AX_BUILT="$HERE/ax/.build/release/strad-hostd-ax"
  [ -x "$AX_BUILT" ] || { echo "the helper did not build; see the output above"; return 1; }
  if [ -n "$SIGN_IDENTITY" ]; then
    "$HERE/install/sign-helper.sh" "$AX_BUILT" --identity "$SIGN_IDENTITY" || return 1
  else
    "$HERE/install/sign-helper.sh" "$AX_BUILT" || return 1
  fi
  { cp "$AX_BUILT" "$STATE/bin/strad-hostd-ax.new" && mv -f "$STATE/bin/strad-hostd-ax.new" "$STATE/bin/strad-hostd-ax"; } || return 1
  AX="$STATE/bin/strad-hostd-ax"
  if [ "$AGENT" = 1 ]; then
    say "Installing the LaunchAgent $AX_LABEL"
    sed -e "s|__HELPER__|$AX|g" -e "s|__HOME__|$HOME|g" -e "s|__STATE__|$STATE|g" \
      "$HERE/install/$AX_LABEL.plist" > "$RELOAD/$AX_LABEL.plist" || return 1
    launchd_install "$AX_LABEL" "$HOME/Library/LaunchAgents/$AX_LABEL.plist" "$RELOAD" || return 1
    # From here on the daemon reaches the helper over the agent's socket and
    # never spawns one of its own (see native.mode in src/config.ts).
    node -e '
      const fs = require("fs"), file = process.argv[1];
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      c.native = { ...(c.native ?? {}), mode: "socket" };
      fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    ' "$STATE/config.json" || return 1
  fi
  say "Helper permissions (both must be granted in System Settings › Privacy & Security):"
  "$AX" --status || true
}

# strad-hostd-messages: the same build, sign and LaunchAgent, under its own
# identifier, so the Full Disk Access it is granted is its alone.
install_messages() {
  say "Building strad-hostd-messages"
  (cd "$HERE/messages" && swift build -c release 2>&1 | tail -3) || return 1
  MESSAGES_BUILT="$HERE/messages/.build/release/strad-hostd-messages"
  [ -x "$MESSAGES_BUILT" ] || { echo "strad-hostd-messages did not build; see the output above"; return 1; }
  if [ -n "$SIGN_IDENTITY" ]; then
    "$HERE/install/sign-helper.sh" "$MESSAGES_BUILT" --identity "$SIGN_IDENTITY" --identifier "$MESSAGES_LABEL" || return 1
  else
    "$HERE/install/sign-helper.sh" "$MESSAGES_BUILT" --identifier "$MESSAGES_LABEL" || return 1
  fi
  { cp "$MESSAGES_BUILT" "$STATE/bin/strad-hostd-messages.new" && mv -f "$STATE/bin/strad-hostd-messages.new" "$STATE/bin/strad-hostd-messages"; } || return 1
  MESSAGES_HELPER="$STATE/bin/strad-hostd-messages"
  if [ "$AGENT" = 1 ]; then
    say "Installing the LaunchAgent $MESSAGES_LABEL"
    sed -e "s|__HELPER__|$MESSAGES_HELPER|g" -e "s|__HOME__|$HOME|g" -e "s|__STATE__|$STATE|g" \
      "$HERE/install/$MESSAGES_LABEL.plist" > "$RELOAD/$MESSAGES_LABEL.plist" || return 1
    launchd_install "$MESSAGES_LABEL" "$HOME/Library/LaunchAgents/$MESSAGES_LABEL.plist" "$RELOAD" || return 1
  fi
  say "Messages helper (Full Disk Access is granted by hand: \`strad-hostd messages --grant\`):"
  "$MESSAGES_HELPER" --status || true
}

if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$STATE/bin" "$RELOAD"
fi

if [ "$HELPER" = 1 ] && [ "$(uname)" = "Darwin" ]; then
  if command -v swift >/dev/null && swift build --help >/dev/null 2>&1; then
    install_ax || failed "$AX_LABEL was not installed; the computer-use servers and the banner need it"
    install_messages || failed "$MESSAGES_LABEL was not installed; the messages server needs it"
  else
    say "swift is not available: skipping strad-hostd-ax and strad-hostd-messages (xcode-select --install, then re-run; the computer-use and messages servers need them)"
  fi
fi

if [ -n "$HOSTNAME_ARG" ]; then
  command -v cloudflared >/dev/null || die "cloudflared is not installed: brew install cloudflared"
  CLOUDFLARED="$(command -v cloudflared)"
  [ -f "$HOME/.cloudflared/cert.pem" ] || { say "Log in to Cloudflare (a browser opens)"; cloudflared tunnel login; }

  if ! cloudflared tunnel list --output json | node -e \
      'const n=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit((JSON.parse(s)||[]).some(t=>t.name===n)?0:1))' "$TUNNEL_NAME"; then
    say "Creating the named tunnel \"$TUNNEL_NAME\""
    cloudflared tunnel create "$TUNNEL_NAME"
  fi
  TUNNEL_ID="$(cloudflared tunnel list --output json | node -e \
    'const n=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(t=>t.name===n).id))' "$TUNNEL_NAME")"

  # The ingress names the MCP port and NOTHING else. The control page listens on
  # another port, and this file is the reason no request from outside can reach it.
  PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port ?? 7311)' "$STATE/config.json")"
  cat > "$STATE/cloudflared.yml" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$PORT
  - service: http_status:404
YAML
  chmod 600 "$STATE/cloudflared.yml"

  # `--config` is load-bearing. Without it cloudflared reads
  # ~/.cloudflared/config.yml, and when that file belongs to another tunnel
  # (the one serving Anki, say) its `tunnel:` wins over the name given here:
  # the DNS record is pointed at the wrong tunnel and the command succeeds.
  # `--overwrite-dns` re-points an existing record at this tunnel, so a re-run
  # repairs a record that was routed elsewhere: the hostname was named for this
  # tunnel and nothing else.
  say "Routing $HOSTNAME_ARG to the tunnel"
  cloudflared tunnel --config "$STATE/cloudflared.yml" route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME_ARG" \
    || echo "   warning: could not route $HOSTNAME_ARG to $TUNNEL_NAME; check the record in the Cloudflare dashboard"

  node -e '
    const fs = require("fs"), [file, configPath, binary] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    c.tunnel = { enabled: true, configPath, binary };
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  ' "$STATE/config.json" "$STATE/cloudflared.yml" "$CLOUDFLARED"
fi

# Is the daemon answering on its MCP port? Each look waits first, so that the
# first one is not the old process answering on its way out.
daemon_serving() {
  local port tries=0
  port="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port ?? 7311)' "$STATE/config.json")"
  while [ "$tries" -lt 15 ]; do
    sleep 2
    if curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then return 0; fi
    tries=$((tries + 1))
  done
  return 1
}

# The last thing that can take this machine off the network, so it runs last and
# everything worth reporting is said before it starts: this restart can end the
# shell this script came from. By then the service is loaded, or in the hands of
# the one-shot, so launchd brings the daemon back with or without this script.
install_daemon() {
  say "Installing the LaunchAgent $LABEL"
  sed -e "s|__NODE__|$NODE|g" -e "s|__CLI__|$APP/build/cli.js|g" -e "s|__HOME__|$HOME|g" -e "s|__STATE__|$STATE|g" \
    "$HERE/install/$LABEL.plist" > "$RELOAD/$LABEL.plist" || {
      failed "$LABEL was not restarted: its plist could not be rendered"
      return 1
    }
  if ! launchd_install "$LABEL" "$HOME/Library/LaunchAgents/$LABEL.plist" "$RELOAD"; then
    failed "$LABEL was not restarted; see the launchd output above"
    return 1
  fi
  if daemon_serving; then return 0; fi

  # Loaded and not serving: the new build fails at runtime, in a way loading it
  # for `add` above could not show, and launchd would restart it for ever.
  echo "the daemon is not answering; its log ends:"
  tail -n 20 "$HOME/Library/Logs/$LABEL.err.log" 2>&1 || true
  if [ ! -d "$APP.previous" ]; then
    failed "$LABEL is not serving, and there is no previous build to roll back to"
    return 1
  fi
  say "Rolling back to the previous build"
  rm -rf "$APP.failed"
  if ! { mv "$APP" "$APP.failed" && mv "$APP.previous" "$APP"; }; then
    failed "$LABEL is not serving, and rolling back to the previous build failed"
    return 1
  fi
  launchctl kickstart -k "$(launchd_target "$LABEL")" 2>&1 || true
  if daemon_serving; then
    failed "$LABEL did not serve on the new build and was rolled back; that build is at $APP.failed"
  else
    failed "$LABEL is not serving on the new build or the rolled-back one"
  fi
  return 1
}

if [ "$AGENT" = 1 ] && [ "$(uname)" = "Darwin" ]; then
  if [ -n "$FAILED" ]; then
    printf '\nFailed so far:\n%s' "$FAILED"
  fi
  if install_daemon; then
    CONTROL_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).controlPort ?? 7312)' "$STATE/config.json")"
    say "Running. Status page: http://127.0.0.1:$CONTROL_PORT"
  fi
else
  say "Installed. Start it with: $NODE $APP/build/cli.js serve"
fi

cat <<TXT

  See what is in control:   $NODE $APP/build/cli.js status
  Turn everything off:      $NODE $APP/build/cli.js disable     (or: touch $STATE/DISABLED)
  Print the bearer keys:    $NODE $APP/build/cli.js keys
  Check the native helper:  $NODE $APP/build/cli.js helper
  Check the Messages helper: $NODE $APP/build/cli.js messages   (--grant opens Full Disk Access)
  Install the Chrome extension (unattended browser use): $NODE $APP/build/cli.js extension
TXT

if [ -n "$FAILED" ]; then
  printf '\nThe install did not finish cleanly:\n%s' "$FAILED" >&2
  exit 1
fi
