# syntax=docker/dockerfile:1
#
# bundle-api MCP server bundle, as a strad `supplementary-image`.
#
# Build context is servers/bundle-api/. This image is published SEPARATELY from
# the strad core image (to ghcr.io/tadasant/strad-bundle-api) and runs as its
# own internal-only App Platform component; the core gateway proxies to it over
# the private network at http://bundle-api:8080/<slug>.
#
# Every server in here is a pure HTTP/API wrapper — no browser, no subprocess —
# so a plain node:22-slim base is all it needs (contrast good-eggs, which needs
# a Playwright base for Chromium). It holds ZERO credentials: each server reads
# its own config from the environment at tool-invocation time, and strad injects
# those secrets onto this component at deploy time.
#
# TWO STAGES, and the split is the point. The build needs devDependencies
# (typescript, @types, and vitest via fork/slack and fork/google-flights); the
# runtime needs none of them. `npm prune --omit=dev` alone would not be enough
# here: in a single stage the pruned files stay in the published `npm ci`
# layer, so the toolchain still ships — deleted from the container's
# filesystem, present in the image. The runtime stage takes the pruned tree
# and nothing that built it.
#
# The prune is safe for the telemetry bootstrap because `otel/instrument.mjs`
# imports node: builtins and @opentelemetry/* only, and remote/ declares every
# one of those as a `dependency`. Keep it that way: an OTel package that
# drifts into devDependencies breaks every boot of this image, at `--import`,
# before the server runs.

# --- build stage --------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Manifests + lockfile first so a source-only change re-uses the install layer.
# NODE_ENV is intentionally unset: the build needs devDependencies. The
# runtime stage pins it to production.
COPY package.json package-lock.json ./
COPY fork/slack/package.json ./fork/slack/package.json
COPY upstream/serpapi-hotels/package.json ./upstream/serpapi-hotels/package.json
COPY upstream/tailscale/package.json ./upstream/tailscale/package.json
COPY upstream/monarch-money/package.json ./upstream/monarch-money/package.json
COPY upstream/gcs/package.json ./upstream/gcs/package.json
COPY fork/google-flights/package.json ./fork/google-flights/package.json
COPY remote/package.json ./remote/package.json
RUN npm ci --no-audit --no-fund

# Sources, then build every server workspace (fork/ and upstream/), then the
# remote host.
COPY fork ./fork
COPY upstream ./upstream
COPY remote ./remote

# The telemetry bootstrap. Vendored (each image is its own build context, so it
# cannot COPY from the repo root); keep it in sync with `npm run telemetry:sync`.
COPY otel ./otel
RUN npm run build && npm prune --omit=dev

# --- runtime stage ------------------------------------------------------------
FROM node:22-slim

LABEL org.opencontainers.image.source="https://github.com/tadasant/strad"
LABEL org.opencontainers.image.description="bundle-api — strad supplementary-image bundle of 6 pure-API MCP servers (streamable-HTTP)."
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# The built, pruned tree, in the layers it changes in: `node_modules` is decided
# by the lockfile and stays byte-identical across a source-only commit, so a
# release that changes only sources re-pushes the workspaces and not the
# dependency tree. The TypeScript sources ride along inside the workspaces —
# they are text, not a toolchain.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/fork ./fork
COPY --from=build /app/upstream ./upstream
COPY --from=build /app/remote ./remote
COPY --from=build /app/otel ./otel

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# node:22-slim ships a `node` user at uid 1000. Nothing here needs root.
USER 1000:1000

# --import runs the telemetry bootstrap to completion before the server starts.
# With no OTEL_EXPORTER_OTLP_ENDPOINT it starts no SDK and the server runs exactly
# as it did before.
CMD ["node", "--import", "./otel/instrument.mjs", "remote/build/index.js"]
