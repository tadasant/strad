#!/usr/bin/env bash
# One-time (idempotent) setup for a containerized strad workspace.
#
# Run this INSIDE the app container (ac.sh does it for you):
#   docker compose -f .agent-containers/docker-compose.dev.yml exec app .agent-containers/setup.sh
#
# There is no database to create and no asset to compile: strad's whole setup is
# its dependency tree. `npm run dev` runs the TypeScript directly, so there is no
# build step here either.
set -euo pipefail

cd /app

echo "== Installing dependencies (npm ci) =="
# `npm ci` into /app/node_modules, which is a NAMED VOLUME rather than the bind
# mount (see docker-compose.dev.yml) — so this installs the container's own tree
# and leaves the host's checkout alone. It persists across restarts, not across
# `down -v`.
npm ci

echo "== Setup complete =="
echo "Start the gateway with: .agent-containers/run.sh"
