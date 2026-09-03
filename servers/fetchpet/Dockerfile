# syntax=docker/dockerfile:1
#
# Fetch Pet MCP server, as a strad `supplementary-image` bundle.
#
# Build context is servers/fetchpet/. This image is published SEPARATELY from
# the strad core image (to ghcr.io/tadasant/strad-server-fetchpet) and runs as
# its own internal-only App Platform component; the core gateway proxies to it
# over the private network at http://bundle-fetchpet:8080/mcp.
#
# Base image: the official Playwright image already carries Chromium (rev 1228)
# and every system library it needs, at PLAYWRIGHT_BROWSERS_PATH=/ms-playwright.
# We pin the app's Playwright to the SAME version (see package.json overrides),
# so the build never downloads a browser — cutting the slow, flaky
# cdn.playwright.dev fetch out of the build entirely.
#
# Browser facts (proven on App Platform's gVisor sandbox): Chromium runs with
# --no-sandbox --disable-dev-shm-usage (set by shared/), peaks ~545MB RSS, and
# the constraint is CPU (1 vCPU serialises rendering), not RAM — hence a 1GB
# bundle. The browser is launched once at startup (background login) and kept
# alive; per tool call we reuse the one logged-in page.
#
# TWO STAGES, and the split is the point. The build needs devDependencies
# (typescript, @types, and vitest via shared/); the runtime needs none of
# them. `npm prune --omit=dev` alone would not be enough here: in a single
# stage the pruned files stay in the published `npm ci` layer, so the
# toolchain still ships — deleted from the container's filesystem, present in
# the image. The runtime stage takes the pruned tree and nothing that built
# it.
#
# The prune is safe for the telemetry bootstrap because `otel/instrument.mjs`
# imports node: builtins and @opentelemetry/* only, and remote/ declares every
# one of those as a `dependency`. Keep it that way: an OTel package that
# drifts into devDependencies breaks every boot of this image, at `--import`,
# before the server runs.

# --- build stage --------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS build

WORKDIR /app

# Manifests + lockfile first so a source-only change re-uses the install layer.
# NODE_ENV is intentionally unset: the build needs devDependencies. The
# runtime stage pins it to production.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY remote/package.json ./remote/package.json
RUN npm ci --no-audit --no-fund

# Sources, then build shared -> remote. No `playwright install`: the base image
# already has the matching Chromium at /ms-playwright.
COPY shared ./shared
COPY remote ./remote

# The telemetry bootstrap. Vendored (each image is its own build context, so it
# cannot COPY from the repo root); keep it in sync with `npm run telemetry:sync`.
COPY otel ./otel
RUN npm run build && npm prune --omit=dev

# --- runtime stage ------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.61.1-noble

LABEL org.opencontainers.image.source="https://github.com/tadasant/strad"
LABEL org.opencontainers.image.description="Fetch Pet MCP server — strad supplementary-image bundle (browser-driven, streamable-HTTP)."
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# The built, pruned tree, in the layers it changes in: `node_modules` is decided
# by the lockfile and stays byte-identical across a source-only commit, so a
# release that changes only sources re-pushes the workspaces and not the
# dependency tree. The TypeScript sources ride along inside the workspaces —
# they are text, not a toolchain.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/remote ./remote
COPY --from=build /app/otel ./otel

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# --import runs the telemetry bootstrap to completion before the server starts.
# With no OTEL_EXPORTER_OTLP_ENDPOINT it starts no SDK and the server runs exactly
# as it did before.
CMD ["node", "--import", "./otel/instrument.mjs", "remote/build/index.js"]
