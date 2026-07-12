# syntax=docker/dockerfile:1
# check=error=true

# ---- build ------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Deps first, so a source-only change doesn't re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Prune to production deps for the runtime layer.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim

# This label is what links the GHCR package back to the repo — it gives the
# package its README, its repo sidebar, and (crucially) lets it inherit the
# repo's visibility. Without it, the package is an orphan you have to manage
# by hand. zimmer omits it; that's a bug there, not a pattern to copy.
LABEL org.opencontainers.image.source="https://github.com/tadasant/strad"
LABEL org.opencontainers.image.description="strad — a self-hosted MCP platform. One endpoint, many MCP servers, selected per request."
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The stock image ships ZERO servers, on purpose. A deployment supplies its own
# server list via STRAD_CONFIG_YAML (or bakes a config in and sets STRAD_CONFIG).
COPY strad.config.yaml ./strad.config.yaml

# node:22-slim ships a `node` user at uid 1000. Run as it: nothing here needs
# root, and App Platform will happily run a container as root if you let it.
USER 1000:1000

# App Platform sets PORT. 8080 is the default for both the public component
# (http_port) and internal bundle components (internal_ports).
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]
