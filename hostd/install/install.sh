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
# computer-use servers and the on-screen banner) when `swift` is available,
# signs it with a stable identity (install/sign-helper.sh), installs it to
# $STATE/bin and runs it as its own LaunchAgent. --no-helper skips all of that.
set -euo pipefail

MACHINE="this machine"
SUFFIX="hostd"
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
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${STRAD_HOSTD_HOME:-$HOME/.strad-hostd}"
APP="$STATE/app"
LABEL="com.strad.hostd"
AX_LABEL="com.strad.hostd-ax"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

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
cp -R "$HERE/build" "$HERE/package.json" "$HERE/package-lock.json" "$APP.new/"
(cd "$APP.new" && npm ci --omit=dev --no-audit --no-fund)
rm -rf "$APP" && mv "$APP.new" "$APP"
HOSTD=("$NODE" "$APP/build/cli.js")

if [ ! -f "$STATE/config.json" ]; then
  say "Writing config and generating keys"
  STRAD_HOSTD_HOME="$STATE" "${HOSTD[@]}" init --machine "$MACHINE" --suffix "$SUFFIX"
else
  say "Keeping the existing $STATE/config.json"
  # A config from before a server existed does not know it: enable it, with a
  # fresh key, and leave everything already there alone.
  for cap in shell browser computer-headless computer; do
    STRAD_HOSTD_HOME="$STATE" "${HOSTD[@]}" add "$cap" --suffix "$SUFFIX"
  done
fi

# The native helper: Swift, macOS only. Built from hostd/ax, signed with a
# stable identity so its TCC grants survive rebuilds, copied beside the app so
# the clone can go away. Without `swift`, the two computer-use servers are
# served but refuse every request with "helper not running", and the shell and
# browser servers are unaffected.
if [ "$HELPER" = 1 ] && [ "$(uname)" = "Darwin" ]; then
  if command -v swift >/dev/null && swift build --help >/dev/null 2>&1; then
    say "Building strad-hostd-ax"
    (cd "$HERE/ax" && swift build -c release 2>&1 | tail -3)
    AX_BUILT="$HERE/ax/.build/release/strad-hostd-ax"
    [ -x "$AX_BUILT" ] || die "the helper did not build; see the output above"
    if [ -n "$SIGN_IDENTITY" ]; then
      "$HERE/install/sign-helper.sh" "$AX_BUILT" --identity "$SIGN_IDENTITY"
    else
      "$HERE/install/sign-helper.sh" "$AX_BUILT"
    fi
    mkdir -p "$STATE/bin"
    cp "$AX_BUILT" "$STATE/bin/strad-hostd-ax.new" && mv -f "$STATE/bin/strad-hostd-ax.new" "$STATE/bin/strad-hostd-ax"
    AX="$STATE/bin/strad-hostd-ax"
    if [ "$AGENT" = 1 ]; then
      say "Installing the LaunchAgent $AX_LABEL"
      AX_PLIST="$HOME/Library/LaunchAgents/$AX_LABEL.plist"
      mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
      sed -e "s|__HELPER__|$AX|g" -e "s|__HOME__|$HOME|g" -e "s|__STATE__|$STATE|g" \
        "$HERE/install/$AX_LABEL.plist" > "$AX_PLIST"
      launchctl bootout "gui/$(id -u)/$AX_LABEL" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$AX_PLIST"
    fi
    say "Helper permissions (both must be granted in System Settings › Privacy & Security):"
    "$AX" --status || true
  else
    say "swift is not available: skipping strad-hostd-ax (xcode-select --install, then re-run; the computer-use servers need it)"
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

  say "Routing $HOSTNAME_ARG to the tunnel"
  cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" || echo "   (the DNS record may already exist; continuing)"

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

  node -e '
    const fs = require("fs"), [file, configPath, binary] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    c.tunnel = { enabled: true, configPath, binary };
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  ' "$STATE/config.json" "$STATE/cloudflared.yml" "$CLOUDFLARED"
fi

if [ "$AGENT" = 1 ] && [ "$(uname)" = "Darwin" ]; then
  say "Installing the LaunchAgent $LABEL"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  sed -e "s|__NODE__|$NODE|g" -e "s|__CLI__|$APP/build/cli.js|g" -e "s|__HOME__|$HOME|g" -e "s|__STATE__|$STATE|g" \
    "$HERE/install/$LABEL.plist" > "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  CONTROL_PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).controlPort ?? 7312)' "$STATE/config.json")"
  say "Running. Status page: http://127.0.0.1:$CONTROL_PORT"
else
  say "Installed. Start it with: $NODE $APP/build/cli.js serve"
fi

cat <<TXT

  See what is in control:   $NODE $APP/build/cli.js status
  Turn everything off:      $NODE $APP/build/cli.js disable     (or: touch $STATE/DISABLED)
  Print the bearer keys:    $NODE $APP/build/cli.js keys
  Check the native helper:  $NODE $APP/build/cli.js helper
TXT
