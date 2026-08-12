#!/usr/bin/env bash
#
# agent-dev.sh — boot strad locally with no Docker, no root, and no services.
#
# This is the fast path, and for strad it is also the COMPLETE path: the gateway
# is a stateless Node process with no database, no cache and no build step in
# dev, so "boot it and look at the screen" is one `node --watch` away. Nothing
# here needs a container. `.agent-containers/` is the other path — real per-clone
# isolation for running several sessions at once — and it is strictly heavier.
#
# What this adds over `npm run dev`:
#   - a FREE port, so two clones on one box do not both grab 8080
#   - strad.config.dev.yaml, so the console is enterable and echo is mounted
#   - the three dev env vars, defaulted
#   - `npm ci` when node_modules is missing
#   - a boot preflight, so a dead process is reported as one rather than as a
#     silent shell that returned
#
# Usage:
#   scripts/agent-dev.sh                # pick a free port, run in the foreground
#   PORT=8080 scripts/agent-dev.sh      # pin the port
#   scripts/agent-dev.sh --background   # nohup it, log to .logs/app.log, return
#
# Env overrides: PORT, STRAD_CONFIG, ADMIN_BOOTSTRAP_TOKEN, STRAD_INTERNAL_TOKEN.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKGROUND=false
case "${1:-}" in
  --background | -b) BACKGROUND=true ;;
  "") ;;
  -h | --help)
    # 24, not 25: line 25 is `set -euo pipefail`, and printing it as help text
    # is how this kind of range fails.
    sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown argument '$1' (try --help)" >&2
    exit 1
    ;;
esac

log() { printf '\033[0;34m[agent-dev]\033[0m %s\n' "$*"; }
die() {
  printf '\033[0;31m[agent-dev] error:\033[0m %s\n' "$*" >&2
  exit 1
}

# --------------------------------------------------------------------------- #
# Preflight
# --------------------------------------------------------------------------- #

command -v node >/dev/null 2>&1 || die "node is not installed (strad needs >= 22)"

# `node --experimental-transform-types` — running TypeScript with no build step —
# is what `npm run dev` is. It does not exist before 22, and the failure on an
# older node is an opaque parse error in a .ts file rather than a version
# complaint, so say it here.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] \
  || die "node $NODE_MAJOR is too old; strad needs >= 22 (package.json engines)"

if [[ ! -d node_modules ]]; then
  log "node_modules is missing — running npm ci (a minute or so)"
  npm ci
fi

# --------------------------------------------------------------------------- #
# Port
# --------------------------------------------------------------------------- #

# Ask the kernel for a free port rather than probing candidates. There is a race
# between closing this listener and strad opening its own, which is why an
# explicit PORT always wins: pin it when you need the URL to be stable.
free_port() {
  node -e '
    const net = require("net");
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => process.stdout.write(String(port)));
    });
  '
}

PORT="${PORT:-$(free_port)}"
[[ -n "$PORT" ]] || die "could not find a free port"

# --------------------------------------------------------------------------- #
# Environment
# --------------------------------------------------------------------------- #

export PORT
export STRAD_CONFIG="${STRAD_CONFIG:-$REPO_ROOT/strad.config.dev.yaml}"

# The console bypass takes THREE aligned locks (src/auth/dev.ts): this variable,
# a bootstrap token, and `auth.consoleDevBypass.enabled` in the config. The first
# two are here and the third is in strad.config.dev.yaml. Set them all or the
# console is a 401 whose body names which lock is shut (`devBypass:`).
export ALLOW_DEV_AUTH=true
export ADMIN_BOOTSTRAP_TOKEN="${ADMIN_BOOTSTRAP_TOKEN:-change-me}"

# Shared secret between the core and its bundle components. Nothing local speaks
# to a bundle, but boot reads it, so give it a value that is obviously not one.
export STRAD_INTERNAL_TOKEN="${STRAD_INTERNAL_TOKEN:-change-me}"

# /mcp needs a minted system token and the bypass CANNOT stand in for one — it
# grants a console session and nothing else. An empty array is a working default
# for console work and an explicit dead end for gateway work, so say which.
if [[ -z "${STRAD_TOKENS:-}" ]]; then
  export STRAD_TOKENS="[]"
  TOKEN_NOTE=$'no system tokens — /mcp will reject every request.\n           Mint one with: npm run token:mint -- --label dev --roles admin'
else
  TOKEN_NOTE="STRAD_TOKENS is set (/mcp is callable)"
fi

# --------------------------------------------------------------------------- #
# Boot
# --------------------------------------------------------------------------- #

log "config:  $STRAD_CONFIG"
log "url:     http://localhost:${PORT}"
# /ui?token= is the entry: it moves the token into an HttpOnly cookie and
# redirects. /console?token= authenticates too, but answers JSON — it is the
# session endpoint, not the screen.
log "console: http://localhost:${PORT}/ui?token=${ADMIN_BOOTSTRAP_TOKEN}"
log "tokens:  ${TOKEN_NOTE}"

if [[ "$BACKGROUND" != true ]]; then
  exec npm run dev
fi

mkdir -p .logs

# Read the command out of package.json rather than repeating its flags here, so
# there is one definition of "run strad from source" and this cannot drift from
# it. `sh -c "exec …"` is what makes the pid below the NODE process: launch it
# through `npm run` instead and the pid is npm's, killing that leaves the
# `--watch` supervisor and its child running, and the port stays occupied by a
# process the caller was told it had stopped.
DEV_CMD="$(node -p 'require("./package.json").scripts.dev')"
[[ -n "$DEV_CMD" ]] || die "package.json has no 'dev' script"

nohup sh -c "exec $DEV_CMD" > .logs/app.log 2>&1 &
DEV_PID=$!

# Poll /healthz rather than sleeping a fixed interval, so this returns as soon as
# the process is really serving — and reports a boot CRASH as a failure instead
# of leaving a "started!" line above a dead process and a log nobody reads.
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/healthz" > /dev/null 2>&1; then
    log "up on http://localhost:${PORT} (pid ${DEV_PID}, log .logs/app.log)"
    exit 0
  fi
  if ! kill -0 "$DEV_PID" 2> /dev/null; then
    echo "--- .logs/app.log ---" >&2
    tail -20 .logs/app.log >&2 || true
    die "strad exited during boot"
  fi
  sleep 1
done

echo "--- .logs/app.log ---" >&2
tail -20 .logs/app.log >&2 || true
die "strad did not answer /healthz within 30s"
