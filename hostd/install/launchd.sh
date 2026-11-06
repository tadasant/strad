#!/bin/bash
# Put a LaunchAgent in place on a machine nobody may be sitting at. Sourced by
# install.sh, and run by launchd itself as `reload` (below). /bin/bash on macOS
# is 3.2: an empty array under `set -u` is an error there and bash 5 on the CI
# box would not notice, so this file holds no arrays.
#
# The rule is that a service is unloaded only by something that will load it
# again whatever happens to the installer, because com.strad.hostd serves the
# shell the installer usually arrives through. So there are three paths:
#
#   loaded, plist unchanged   `kickstart -k`. Never unloaded: launchd restarts it
#                             even if this script dies on the same instruction.
#   not loaded                `bootstrap`, retried. Nothing to lose.
#   loaded, plist changed     launchd has no way to replace a definition in
#                             place, so this is the one unload. It is done by a
#                             one-shot agent launchd runs, com.strad.hostd-reload.plist,
#                             which is no descendant of the daemon or of this
#                             script. The one-shot's own bootstrap is the canary:
#                             if this machine refuses a bootstrap from here, it
#                             refuses before anything has been touched.
#
# `bootout` can return before launchd has finished (exit 36, "Operation now in
# progress"), and a `bootstrap` into that window fails with 5, which is also what
# launchd says for most other refusals. That is why the wait, the retry and
# launchd_diagnose all exist.

LAUNCHD_SELF="${BASH_SOURCE[0]}"
# launchd's default ExitTimeOut is 20 seconds before SIGKILL; wait past it.
LAUNCHD_GONE_SECONDS=30
LAUNCHD_BOOTSTRAP_DELAYS="1 2 4 8 16"
# Longer than one full reload: the gone wait plus every bootstrap delay.
LAUNCHD_RELOAD_SECONDS=120

launchd_domain() { printf 'gui/%s' "$(id -u)"; }
launchd_target() { printf 'gui/%s/%s' "$(id -u)" "$1"; }
launchd_loaded() { launchctl print "$(launchd_target "$1")" >/dev/null 2>&1; }

# Everything the next report needs to prove a cause rather than guess one.
# Nothing here may fail the caller.
launchd_diagnose() {
  local label="$1" plist="$2" rc="$3" out status=0
  echo "--- launchd diagnostics: $label, last exit $rc"
  launchctl error "$rc" 2>&1 || true
  echo "manager of this process: $(launchctl managername 2>&1 || true)"
  ls -l "$plist" 2>&1 || true
  if command -v plutil >/dev/null; then plutil -lint "$plist" 2>&1 || true; fi
  echo "disabled state: $( (launchctl print-disabled "$(launchd_domain)" 2>&1 || true) | grep -F "\"$label\"" || echo 'not listed')"
  out="$(launchctl print "$(launchd_target "$label")" 2>&1)" || status=$?
  echo "launchctl print $(launchd_target "$label"): exit $status"
  printf '%s\n' "$out"
  echo "---"
}

# Unload a service and wait until launchd says it is really gone, with a bound.
launchd_bootout() {
  local label="$1" rc=0 waited=0
  launchctl bootout "$(launchd_target "$label")" 2>&1 || rc=$?
  echo "launchctl bootout $label: exit $rc"
  while [ "$waited" -lt "$LAUNCHD_GONE_SECONDS" ]; do
    launchd_loaded "$label" || return 0
    sleep 1
    waited=$((waited + 1))
  done
  if launchd_loaded "$label"; then
    echo "$label is still loaded $LAUNCHD_GONE_SECONDS seconds after bootout"
    return 1
  fi
}

# Load a service, retrying with backoff. Diagnoses on the way out if it cannot.
launchd_bootstrap() {
  local label="$1" plist="$2" delay rc=0
  for delay in $LAUNCHD_BOOTSTRAP_DELAYS 0; do
    rc=0
    launchctl bootstrap "$(launchd_domain)" "$plist" 2>&1 || rc=$?
    if [ "$rc" = 0 ] || launchd_loaded "$label"; then return 0; fi
    echo "launchctl bootstrap $label: exit $rc"
    if [ "$delay" != 0 ]; then sleep "$delay"; fi
  done
  launchd_diagnose "$label" "$plist" "$rc"
  return 1
}

# Clear a one-shot left by an earlier run, which may still be retrying.
launchd_disarm() {
  if launchd_loaded "$1"; then launchd_bootout "$1" >/dev/null || true; fi
}

# The body of the one-shot. launchd runs it until it exits 0 (the plist's
# KeepAlive), so a daemon that cannot come back keeps being tried for as long as
# the owner is logged in, with no installer alive. Idempotent for that reason:
# the rendered plist moves into place only once its predecessor is unloaded, so
# a re-run skips what is already done, and the plist in LaunchAgents is always
# the one the loaded service came from.
launchd_reload() {
  local label="$1" plist="$2" dir="$3"
  local rendered="$dir/$label.plist" result="$dir/$label.result"
  echo "reloading $label at $(date)"
  if [ -f "$rendered" ]; then
    if launchd_loaded "$label" && ! launchd_bootout "$label"; then
      echo failed >"$result"
      return 1
    fi
    mv -f "$rendered" "$plist"
  fi
  if ! launchd_loaded "$label" && ! launchd_bootstrap "$label" "$plist"; then
    echo failed >"$result"
    return 1
  fi
  echo "$label is loaded"
  echo ok >"$result"
}

# Hand a loaded service with a changed plist to the one-shot, and wait for it.
# A run that is killed here changes nothing: the one-shot finishes without it.
launchd_hand_over() {
  local label="$1" plist="$2" dir="$3"
  local reload="$label.reload" result="$dir/$label.result"
  local log="$HOME/Library/Logs/$reload.log" waited=0
  cp "$LAUNCHD_SELF" "$dir/launchd.sh" || return 1
  sed -e "s|__LABEL__|$reload|g" -e "s|__TARGET__|$label|g" -e "s|__PLIST__|$plist|g" \
    -e "s|__SCRIPT__|$dir/launchd.sh|g" -e "s|__DIR__|$dir|g" -e "s|__LOG__|$log|g" \
    "$(dirname "$LAUNCHD_SELF")/com.strad.hostd-reload.plist" >"$dir/$reload.plist" || return 1
  rm -f -- "$result"
  : >"$log"
  if ! launchd_bootstrap "$reload" "$dir/$reload.plist"; then
    rm -f -- "$dir/$label.plist"
    echo "$label was left loaded and untouched"
    return 1
  fi
  while [ "$waited" -lt "$LAUNCHD_RELOAD_SECONDS" ] && [ ! -s "$result" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  cat "$log"
  if [ "$(cat "$result" 2>/dev/null)" = ok ]; then
    launchd_disarm "$reload"
    return 0
  fi
  echo "$reload has not brought $label back; launchd keeps retrying it until it does (log: $log)"
  return 1
}

# Put $dir/$label.plist, freshly rendered, into service at $plist.
launchd_install() {
  local label="$1" plist="$2" dir="$3" rc=0
  launchd_disarm "$label.reload"
  if ! launchd_loaded "$label"; then
    mv -f "$dir/$label.plist" "$plist" || return 1
    launchd_bootstrap "$label" "$plist"
    return
  fi
  if ! cmp -s "$dir/$label.plist" "$plist"; then
    launchd_hand_over "$label" "$plist" "$dir"
    return
  fi
  rm -f -- "$dir/$label.plist"
  launchctl kickstart -k "$(launchd_target "$label")" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    echo "launchctl kickstart $label: exit $rc"
    launchd_diagnose "$label" "$plist" "$rc"
    return 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  case "${1:-}" in
    reload) shift; launchd_reload "$@" ;;
    *) echo "usage: launchd.sh reload <label> <plist> <dir>" >&2; exit 2 ;;
  esac
fi
