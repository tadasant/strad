# syntax=docker/dockerfile:1
#
# 1Password MCP server, as a strad `supplementary-image` bundle.
#
# Build context is servers/onepassword/. This image is published SEPARATELY from
# the strad core image (to ghcr.io/tadasant/strad-server-onepassword) and runs
# as its own internal-only App Platform component; the core gateway proxies to
# it over the private network at http://bundle-onepassword:8080/mcp.
#
# The defining fact of this image: the 1Password CLI (`op`) is BAKED IN at build
# time, at a PINNED version. The shared/ tool logic talks to 1Password purely by
# shelling out to `op` (child_process `spawn('op', ...)`, no configurable path),
# so the binary must be present and on PATH inside the container. gVisor (App
# Platform's sandbox) runs `op` fine — execve works, which the strad PoC proved.
#
# The image is CREDENTIAL-FREE. `op` reads its service-account token from
# OP_SERVICE_ACCOUNT_TOKEN in the environment at runtime; strad injects it as a
# per-bundle SECRET. Nothing secret is baked into the image.
#
# TWO STAGES, and the split is the point. The build needs devDependencies
# (typescript, @types, and vitest via elicitation/); the runtime needs none of
# them. `npm prune --omit=dev` alone would not be enough here: in a single stage
# the pruned files stay in the published `npm ci` layer, so the compiler and the
# test runner still ship — deleted from the container's filesystem, present in
# the image. The runtime stage copies the pruned tree and nothing else.

# --- build stage --------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests + lockfile first so a source-only change re-uses the install layer.
# NODE_ENV is intentionally unset: the build needs devDependencies.
COPY package.json package-lock.json ./
COPY elicitation/package.json ./elicitation/package.json
COPY shared/package.json ./shared/package.json
COPY remote/package.json ./remote/package.json
RUN npm ci --no-audit --no-fund

# Sources, then build in dependency order: elicitation -> shared -> remote.
COPY elicitation ./elicitation
COPY shared ./shared
COPY remote ./remote

# The telemetry bootstrap. Vendored (each image is its own build context, so it
# cannot COPY from the repo root); keep it in sync with `npm run telemetry:sync`.
# It imports only @opentelemetry/* packages, which remote/ declares as
# `dependencies` — so it still resolves after the prune below.
COPY otel ./otel

# Build, then drop the toolchain that built it. What is left in /app is exactly
# what the runtime stage takes.
RUN npm run build && npm prune --omit=dev

# --- runtime stage ------------------------------------------------------------
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/tadasant/strad"
LABEL org.opencontainers.image.description="1Password MCP server — strad supplementary-image bundle (op CLI baked in, streamable-HTTP)."
LABEL org.opencontainers.image.licenses="MIT"

# --- 1Password CLI (op), pinned -----------------------------------------------
# PINNED on purpose: never resolve "latest" at build time, so a rebuild of an
# old commit produces the same binary. To bump, edit OP_VERSION in a commit.
# 1Password serves each release from an immutable, version-scoped path on its
# CDN; we fetch the linux/amd64 zip, unzip just the `op` binary onto PATH, and
# assert `op --version` prints exactly what we asked for.
ARG OP_VERSION=2.34.1
ARG TARGETARCH=amd64
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    curl -fsSL -o /tmp/op.zip \
      "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${TARGETARCH}_v${OP_VERSION}.zip"; \
    unzip -o /tmp/op.zip op -d /usr/local/bin; \
    chmod 755 /usr/local/bin/op; \
    rm -f /tmp/op.zip; \
    apt-get purge -y --auto-remove unzip; \
    rm -rf /var/lib/apt/lists/*; \
    test "$(op --version)" = "${OP_VERSION}"

WORKDIR /app

# The built, pruned tree: compiled JS, runtime dependencies, the telemetry
# bootstrap. No compiler, no test runner, no TypeScript sources' toolchain.
COPY --from=build /app /app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# --import runs the telemetry bootstrap to completion before the server starts.
# With no OTEL_EXPORTER_OTLP_ENDPOINT it starts no SDK and the server runs exactly
# as it did before.
CMD ["node", "--import", "./otel/instrument.mjs", "remote/build/index.js"]
