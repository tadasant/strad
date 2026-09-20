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
set -euo pipefail

MACHINE="this machine"
SUFFIX="hostd"
HOSTNAME_ARG=""
TUNNEL_NAME="strad-hostd"
AGENT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --machine) MACHINE="$2"; shift 2 ;;
    --suffix) SUFFIX="$2"; shift 2 ;;
    --hostname) HOSTNAME_ARG="$2"; shift 2 ;;
    --tunnel-name) TUNNEL_NAME="$2"; shift 2 ;;
    --no-agent) AGENT=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${STRAD_HOSTD_HOME:-$HOME/.strad-hostd}"
APP="$STATE/app"
LABEL="com.strad.hostd"

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
TXT
