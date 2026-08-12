#!/usr/bin/env bash
# Start the strad dev server INSIDE the app container.
#
# One process — `npm run dev`, i.e. `node --experimental-transform-types --watch
# src/index.ts`. No asset watcher, no job worker: the watch flag is the whole
# reload story, and strad has no background work.
#
# It goes under nohup, logging to /app/.logs/app.log, so it survives the
# `docker compose exec` shell that launched it.
set -euo pipefail

cd /app

mkdir -p .logs

PORT="${PORT:-8080}"

# If the gateway is already serving, don't start a second one — a duplicate would
# just die on EADDRINUSE. This makes re-running run.sh a no-op rather than a
# confusing failure.
if curl -fsS "http://localhost:${PORT}/healthz" > /dev/null 2>&1; then
  echo "strad already serving on :${PORT} — nothing to do."
  exit 0
fi

echo "Starting strad on 0.0.0.0:${PORT} → .logs/app.log"
nohup npm run dev > .logs/app.log 2>&1 &

echo "Launched. Tail the log with:"
echo "  docker compose -f .agent-containers/docker-compose.dev.yml exec app tail -f /app/.logs/app.log"
