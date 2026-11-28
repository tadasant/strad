# syntax=docker/dockerfile:1
# check=error=true

# ---- build ------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Manifests first, so a source-only change doesn't re-run npm ci. Every
# workspace's package.json must be present for npm to plan the install.
COPY package.json package-lock.json ./
COPY vendor/mcp-elicitation/package.json ./vendor/mcp-elicitation/
COPY vendor/gmail-shared/package.json ./vendor/gmail-shared/
COPY vendor/google-calendar-shared/package.json ./vendor/google-calendar-shared/
COPY vendor/google-docs-shared/package.json ./vendor/google-docs-shared/
COPY vendor/google-sheets-shared/package.json ./vendor/google-sheets-shared/
COPY vendor/google-drive-shared/package.json ./vendor/google-drive-shared/
COPY vendor/google-search-console-shared/package.json ./vendor/google-search-console-shared/
RUN npm ci

# Sources: compile the vendored shared packages (in dependency order) and then
# the entrypoint. See package.json `build`.
COPY tsconfig.json ./
COPY vendor ./vendor
COPY src ./src
RUN npm run build

# Prune to production deps for the runtime layer. The vendored workspaces stay
# linked; typescript and @types drop out.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim

# Links the GHCR package back to the repo (README, visibility inheritance).
LABEL org.opencontainers.image.source="https://github.com/tadasant/strad"
LABEL org.opencontainers.image.description="strad supplementary image — gmail, google-calendar, google-docs and google-sheets MCP servers over Streamable HTTP, credential-free."
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app

# node_modules holds the (relative) workspace symlinks into ./vendor, so vendor —
# with its compiled build/ output — must ship alongside for imports to resolve.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/dist ./dist
COPY package.json ./

# The telemetry bootstrap. Vendored, because each image is its own Docker build
# context and cannot COPY from the repo root; `npm run telemetry:sync` keeps the
# copies identical and a test fails CI if one drifts.
#
# It is plain ESM with no build step, so it is copied straight into the runtime
# stage rather than through the builder. Its OTel dependencies are PROD deps, so
# they survive the `npm ci --omit=dev` prune above.
COPY otel ./otel
# Ship the smoke test so CI (and anyone) can self-check the running container
# with `docker exec <c> node scripts/smoke.mjs`.
COPY scripts ./scripts

# node:22-slim ships a `node` user at uid 1000. Nothing here needs root.
USER 1000:1000

# Baked at build time by the release workflow so serverInfo/healthz report the
# published image version. Defaults for local/CI builds.
ARG BUNDLE_GOOGLE_VERSION=0.1.0
ENV BUNDLE_GOOGLE_VERSION=${BUNDLE_GOOGLE_VERSION}

# App Platform sets PORT. 8080 is the internal_ports value the strad app spec
# binds for this component.
ENV PORT=8080
EXPOSE 8080

# --import runs the telemetry bootstrap to completion before the server starts,
# so process and container metrics cover the boot itself. With no
# OTEL_EXPORTER_OTLP_ENDPOINT it starts no SDK and this is a no-op.
CMD ["node", "--import", "./otel/instrument.mjs", "dist/index.js"]
