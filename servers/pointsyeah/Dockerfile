# syntax=docker/dockerfile:1
#
# PointsYeah MCP server, as a strad `supplementary-image` bundle.
#
# Build context is servers/pointsyeah/. This image is published SEPARATELY from
# the strad core image (to ghcr.io/tadasant/strad-server-pointsyeah) and runs as
# its own internal-only App Platform component; the core gateway proxies to it
# over the private network at http://bundle-pointsyeah:8080/mcp.
#
# Base image: the official Playwright image already carries Chromium (rev 1228)
# and every system library it needs, at PLAYWRIGHT_BROWSERS_PATH=/ms-playwright.
# We pin the app's Playwright to the SAME version (see package.json overrides),
# so the build never downloads a browser — cutting the slow, flaky
# cdn.playwright.dev fetch out of the build entirely.
#
# Browser facts (proven on App Platform's gVisor sandbox): Chromium runs with
# --no-sandbox --disable-dev-shm-usage (set by remote/), peaks ~545MB RSS, and
# the constraint is CPU (1 vCPU serialises rendering), not RAM — hence a 1GB
# bundle. Unlike upstream (which launched a browser per search), remote/ launches
# ONE browser at startup and opens a fresh context per search.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

LABEL org.opencontainers.image.source="https://github.com/tadasant/strad"
LABEL org.opencontainers.image.description="PointsYeah MCP server — strad supplementary-image bundle (browser-driven, streamable-HTTP)."
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Manifests + lockfile first so a source-only change re-uses the install layer.
# NODE_ENV is intentionally unset here: the build needs devDependencies
# (typescript, @types). It is pinned to production below, for the runtime.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY remote/package.json ./remote/package.json
RUN npm ci --no-audit --no-fund

# Sources, then build shared -> remote. No `playwright install`: the base image
# already has the matching Chromium at /ms-playwright.
COPY shared ./shared
COPY remote ./remote
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "remote/build/index.js"]
