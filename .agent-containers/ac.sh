#!/usr/bin/env bash
#
# ac.sh — "agent containers": orchestrate parallel, isolated, containerized strad
# dev sessions.
#
# Each session is a workspace container running under its own Docker Compose
# project named `strad-dev-<name>`, in its own git clone, on its own dynamically
# assigned host port. That isolation is what lets many agent (or human) sessions
# run at once without colliding on ports, dependency trees, or code.
#
# The `strad-dev-` prefix is a convention, not a contract: nothing in strad reaps
# by it (zimmer has a job that does). It is there so `docker ps` and
# `docker compose ls` group these obviously, and so a stray stack is easy to find.
#
# Commands:
#   clone <name> [branch]   Create + boot a new isolated session
#   status [name]           List sessions, or show one session's port + health
#   open <name>             Print (and try to open) the session's console URL
#   attach <name>           Attach to the session's tmux (Claude Code) window
#   logs <name>             Tail a session's gateway log
#   stop <name>             Stop a session's container (keeps its deps volume)
#   destroy <name>          Tear a session down completely (removes volumes)
#
# Requires: docker (with compose plugin), git. tmux and Claude Code (`claude`)
# are optional — `clone` skips the agent window if either is missing.
set -euo pipefail

# --------------------------------------------------------------------------- #
# Paths and constants
# --------------------------------------------------------------------------- #

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO="$(dirname "$SCRIPT_DIR")"

# Where per-session clones live. Override with AC_WORKSPACE_DIR.
SESSIONS_DIR="${AC_WORKSPACE_DIR:-$HOME/.strad-dev-sessions}"

PROJECT_PREFIX="strad-dev-"
COMPOSE_REL=".agent-containers/docker-compose.dev.yml"

# The console bypass token, which must match ADMIN_BOOTSTRAP_TOKEN in the compose
# file. Only used to build the URL `open` prints.
BOOTSTRAP_TOKEN="${ADMIN_BOOTSTRAP_TOKEN:-change-me}"

# How long to wait for /healthz after boot before giving up (seconds).
HEALTH_TIMEOUT="${AC_HEALTH_TIMEOUT:-180}"

# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

log() { printf '\033[0;34m[ac]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[ac] warning:\033[0m %s\n' "$*" >&2; }
err() { printf '\033[0;31m[ac] error:\033[0m %s\n' "$*" >&2; }
die() {
  err "$*"
  exit 1
}

require() {
  command -v "$1" > /dev/null 2>&1 || die "'$1' is required but not installed."
}

validate_name() {
  local name="$1"
  [[ -n "$name" ]] || die "session name is required"
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
    || die "invalid session name '$name' (use lowercase letters, digits, dashes)"
}

project_name() { echo "${PROJECT_PREFIX}$1"; }
session_dir() { echo "${SESSIONS_DIR}/$1"; }
compose_file() { echo "$(session_dir "$1")/${COMPOSE_REL}"; }

session_exists() { [[ -d "$(session_dir "$1")" ]]; }

# Run docker compose for a session (project + compose file already wired).
compose() {
  local name="$1"
  shift
  docker compose -p "$(project_name "$name")" -f "$(compose_file "$name")" "$@"
}

# The host port that the session's app :8080 is published on (empty if down).
# Must never fail: `docker compose port` exits non-zero for a stopped or absent
# service, and under `set -euo pipefail` that would abort callers that do
# `port="$(host_port ...)"`. The trailing `|| true` keeps the pipeline's exit 0.
host_port() {
  local name="$1"
  { compose "$name" port app 8080 2> /dev/null || true; } | awk -F: 'NF>1 {print $NF; exit}'
}

# Is the app container running for this session?
app_running() {
  local name="$1"
  [[ -n "$(compose "$name" ps -q app 2> /dev/null)" ]]
}

# --------------------------------------------------------------------------- #
# clone — create and boot a new isolated session
# --------------------------------------------------------------------------- #

cmd_clone() {
  local name="${1:-}"
  local branch="${2:-}"
  validate_name "$name"
  require docker
  require git

  local dir
  dir="$(session_dir "$name")"
  if session_exists "$name"; then
    die "session '$name' already exists at $dir (use 'destroy' first, or pick another name)"
  fi

  log "Cloning $SOURCE_REPO → $dir"
  mkdir -p "$SESSIONS_DIR"
  git clone --quiet "$SOURCE_REPO" "$dir"

  if [[ -n "$branch" ]]; then
    log "Checking out branch '$branch'"
    git -C "$dir" checkout --quiet "$branch" \
      || git -C "$dir" checkout --quiet -b "$branch"
  fi

  log "Building and starting the workspace (project $(project_name "$name"))"
  # APP_PORT=0 → Docker assigns a random free host port to container :8080.
  APP_PORT=0 compose "$name" up -d --build

  log "Installing dependencies — the first run is the slow one"
  compose "$name" exec -T app .agent-containers/setup.sh

  log "Starting the gateway"
  compose "$name" exec -T app .agent-containers/run.sh

  local port
  port="$(host_port "$name")"
  [[ -n "$port" ]] || die "could not determine host port for session '$name'"

  log "Waiting for http://localhost:${port}/healthz (timeout ${HEALTH_TIMEOUT}s)"
  if wait_for_health "$port"; then
    log "Session '$name' is up: http://localhost:${port}/ui?token=${BOOTSTRAP_TOKEN}"
  else
    warn "Session '$name' did not answer /healthz within ${HEALTH_TIMEOUT}s."
    warn "Inspect with: $0 logs $name"
  fi

  maybe_start_agent "$name"

  echo
  log "Next steps:"
  echo "  $0 status $name     # port + health"
  echo "  $0 open $name       # the console URL"
  echo "  $0 attach $name     # attach the Claude Code tmux window"
  echo "  $0 logs $name       # tail the gateway log"
  echo "  $0 destroy $name    # tear it all down"
}

# Poll /healthz until it returns 200 or the timeout elapses.
wait_for_health() {
  local port="$1"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < deadline)); do
    if curl -fsS "http://localhost:${port}/healthz" > /dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# Start a tmux session running Claude Code, if tmux + claude are available.
maybe_start_agent() {
  local name="$1"
  if ! command -v tmux > /dev/null 2>&1; then
    warn "tmux not installed — skipping the agent window."
    return 0
  fi
  if ! command -v claude > /dev/null 2>&1; then
    warn "claude not installed — skipping the agent window (the stack is still up)."
    return 0
  fi

  local tmux_name
  tmux_name="$(project_name "$name")"
  if tmux has-session -t "$tmux_name" 2> /dev/null; then
    warn "tmux session '$tmux_name' already exists — leaving it as is."
    return 0
  fi

  log "Starting Claude Code in tmux session '$tmux_name'"
  tmux new-session -d -s "$tmux_name" -c "$(session_dir "$name")"
  tmux send-keys -t "$tmux_name" "claude --dangerously-skip-permissions" C-m
}

# --------------------------------------------------------------------------- #
# status
# --------------------------------------------------------------------------- #

cmd_status() {
  require docker
  local name="${1:-}"

  if [[ -n "$name" ]]; then
    validate_name "$name"
    session_exists "$name" || die "no such session '$name'"
    show_one_status "$name"
    return 0
  fi

  if [[ ! -d "$SESSIONS_DIR" ]] || [[ -z "$(ls -A "$SESSIONS_DIR" 2> /dev/null)" ]]; then
    log "No sessions. Create one with: $0 clone <name>"
    return 0
  fi

  printf '%-20s %-8s %-10s %s\n' "SESSION" "PORT" "STATE" "HEALTH"
  local d
  for d in "$SESSIONS_DIR"/*/; do
    [[ -d "$d" ]] || continue
    show_one_status "$(basename "$d")" oneline
  done
}

show_one_status() {
  local name="$1" mode="${2:-full}"
  local port state health
  port="$(host_port "$name")"
  if app_running "$name"; then state="running"; else state="stopped"; fi

  health="-"
  if [[ -n "$port" ]] && curl -fsS "http://localhost:${port}/healthz" > /dev/null 2>&1; then
    health="ok"
  elif [[ -n "$port" ]]; then
    health="down"
  fi

  if [[ "$mode" == "oneline" ]]; then
    printf '%-20s %-8s %-10s %s\n' "$name" "${port:--}" "$state" "$health"
  else
    echo "Session:  $name"
    echo "Project:  $(project_name "$name")"
    echo "Dir:      $(session_dir "$name")"
    echo "State:    $state"
    echo "Port:     ${port:--}"
    [[ -n "$port" ]] && echo "Console:  http://localhost:${port}/ui?token=${BOOTSTRAP_TOKEN}"
    echo "Health:   $health"
  fi
}

# --------------------------------------------------------------------------- #
# open / attach / logs
# --------------------------------------------------------------------------- #

cmd_open() {
  local name="${1:-}"
  validate_name "$name"
  session_exists "$name" || die "no such session '$name'"
  local port
  port="$(host_port "$name")"
  [[ -n "$port" ]] || die "session '$name' is not running"
  # /ui?token= moves the token into an HttpOnly cookie and redirects; it is the
  # screen. /console?token= authenticates too but answers JSON.
  local url="http://localhost:${port}/ui?token=${BOOTSTRAP_TOKEN}"
  log "$url"
  if command -v open > /dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open > /dev/null 2>&1; then
    xdg-open "$url" > /dev/null 2>&1 || true
  fi
}

cmd_attach() {
  local name="${1:-}"
  validate_name "$name"
  require tmux
  local tmux_name
  tmux_name="$(project_name "$name")"
  tmux has-session -t "$tmux_name" 2> /dev/null \
    || die "no tmux session '$tmux_name' (was claude available at clone time?)"
  tmux attach -t "$tmux_name"
}

cmd_logs() {
  local name="${1:-}"
  validate_name "$name"
  session_exists "$name" || die "no such session '$name'"
  compose "$name" exec app tail -f /app/.logs/app.log
}

# --------------------------------------------------------------------------- #
# stop / destroy
# --------------------------------------------------------------------------- #

cmd_stop() {
  local name="${1:-}"
  validate_name "$name"
  session_exists "$name" || die "no such session '$name'"
  log "Stopping the container for '$name' (dependency volume preserved)"
  compose "$name" stop
}

cmd_destroy() {
  local name="${1:-}"
  validate_name "$name"
  session_exists "$name" || die "no such session '$name'"

  local tmux_name
  tmux_name="$(project_name "$name")"
  if command -v tmux > /dev/null 2>&1 && tmux has-session -t "$tmux_name" 2> /dev/null; then
    log "Killing tmux session '$tmux_name'"
    tmux kill-session -t "$tmux_name" || true
  fi

  log "Tearing down '$name' (-v removes the node_modules volume)"
  compose "$name" down -v --remove-orphans || warn "compose down reported errors"

  log "Removing clone directory $(session_dir "$name")"
  rm -rf "$(session_dir "$name")"
  log "Session '$name' destroyed."
}

# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #

usage() {
  # 25, not 26: line 26 is `set -euo pipefail`, and printing it as help text is
  # how this kind of range fails.
  sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-}"
  [[ $# -gt 0 ]] && shift || true
  case "$cmd" in
    clone) cmd_clone "$@" ;;
    status) cmd_status "$@" ;;
    open) cmd_open "$@" ;;
    attach) cmd_attach "$@" ;;
    logs) cmd_logs "$@" ;;
    stop) cmd_stop "$@" ;;
    destroy) cmd_destroy "$@" ;;
    "" | -h | --help | help) usage ;;
    *)
      err "unknown command '$cmd'"
      echo
      usage
      exit 1
      ;;
  esac
}

main "$@"
