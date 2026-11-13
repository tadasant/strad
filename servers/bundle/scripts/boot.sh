#!/bin/sh
# The bundle's entrypoint. One job beyond `exec node`: keep the tailnet auth key
# out of the environment Node starts with.
#
# `delete process.env.X` changes Node's copy of the environment and nothing
# else. The kernel keeps the environment a process was started with in
# /proc/<pid>/environ, and every server loaded into the host process (and every
# child running as the same user) can read it. So the key is moved to a 0600
# file here, before Node exists, and Node is started without it. The host reads
# the file and deletes it (servers/bundle/host/src/tailnet.ts).
#
# With no key this is `exec node …` and nothing else.
set -eu
if [ -n "${STRAD_TAILNET_AUTHKEY:-}" ]; then
  umask 077
  dir=$(mktemp -d)
  printf '%s' "$STRAD_TAILNET_AUTHKEY" > "$dir/authkey"
  STRAD_TAILNET_AUTHKEY_FILE="$dir/authkey"
  export STRAD_TAILNET_AUTHKEY_FILE
  unset STRAD_TAILNET_AUTHKEY
fi
exec node --import /app/host/otel/instrument.mjs /app/host/dist/index.js
