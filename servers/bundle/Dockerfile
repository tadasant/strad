# syntax=docker/dockerfile:1
#
# bundle — THE strad supplementary image. Thirteen MCP servers, one container.
#
# BUILD CONTEXT IS THE REPO ROOT (not servers/bundle/), because this image is
# assembled from six existing projects that live in different places:
#
#   servers/bundle-api      slack, serpapi-hotels, tailscale, monarch-money,
#                           gcs, remote-filesystem, google-flights
#   images/bundle-google    gmail, google-calendar, google-docs
#   servers/onepassword     onepassword            (+ the `op` CLI, baked below)
#   servers/good-eggs       good-eggs              ┐
#   servers/fetchpet        fetchpet               ├ one shared Chromium
#   servers/pointsyeah      pointsyeah             ┘
#
# Each is built in its OWN stage with its OWN lockfile and its OWN node_modules,
# exactly as its standalone image builds it, and copied into /app/trees/<name>.
# Nothing is merged. That is on purpose: merging six dependency trees is how you
# discover in production that two of them wanted different Playwright versions.
# The host (servers/bundle/host) imports across them by path — Node resolves each
# package's own imports from its own tree — and owns the one thing that MUST be
# shared: the browser.
#
# Base: the official Playwright image. It already carries Chromium (rev 1228) and
# every system library it needs at PLAYWRIGHT_BROWSERS_PATH=/ms-playwright, and
# every tree that touches Playwright pins 1.61.1 to match — so no build step ever
# downloads a browser. It is also the base for the non-browser stages, so the
# node_modules they produce are built by the same Node that will run them.

ARG PW=mcr.microsoft.com/playwright:v1.61.1-noble

# ---- bundle-api: seven pure-API servers -------------------------------------
FROM ${PW} AS build-api
WORKDIR /src
COPY servers/bundle-api/package.json servers/bundle-api/package-lock.json ./
COPY servers/bundle-api/upstream/slack/package.json ./upstream/slack/
COPY servers/bundle-api/upstream/serpapi-hotels/package.json ./upstream/serpapi-hotels/
COPY servers/bundle-api/upstream/tailscale/package.json ./upstream/tailscale/
COPY servers/bundle-api/upstream/monarch-money/package.json ./upstream/monarch-money/
COPY servers/bundle-api/upstream/gcs/package.json ./upstream/gcs/
COPY servers/bundle-api/upstream/remote-filesystem/package.json ./upstream/remote-filesystem/
COPY servers/bundle-api/upstream/google-flights/package.json ./upstream/google-flights/
COPY servers/bundle-api/remote/package.json ./remote/
RUN npm ci --no-audit --no-fund
COPY servers/bundle-api/upstream ./upstream
COPY servers/bundle-api/remote ./remote
RUN npm run build && npm prune --omit=dev

# ---- bundle-google: gmail / calendar / docs ---------------------------------
FROM ${PW} AS build-google
WORKDIR /src
COPY images/bundle-google/package.json images/bundle-google/package-lock.json ./
COPY images/bundle-google/vendor/mcp-elicitation/package.json ./vendor/mcp-elicitation/
COPY images/bundle-google/vendor/gmail-shared/package.json ./vendor/gmail-shared/
COPY images/bundle-google/vendor/google-calendar-shared/package.json ./vendor/google-calendar-shared/
COPY images/bundle-google/vendor/google-docs-shared/package.json ./vendor/google-docs-shared/
RUN npm ci --no-audit --no-fund
COPY images/bundle-google/tsconfig.json ./
COPY images/bundle-google/vendor ./vendor
COPY images/bundle-google/src ./src
RUN npm run build && npm prune --omit=dev

# ---- onepassword -------------------------------------------------------------
FROM ${PW} AS build-op
WORKDIR /src
COPY servers/onepassword/package.json servers/onepassword/package-lock.json ./
COPY servers/onepassword/elicitation/package.json ./elicitation/
COPY servers/onepassword/shared/package.json ./shared/
COPY servers/onepassword/remote/package.json ./remote/
RUN npm ci --no-audit --no-fund
COPY servers/onepassword/elicitation ./elicitation
COPY servers/onepassword/shared ./shared
COPY servers/onepassword/remote ./remote
RUN npm run build && npm prune --omit=dev

# ---- good-eggs / fetchpet / pointsyeah (browser servers) ---------------------
FROM ${PW} AS build-goodeggs
WORKDIR /src
COPY servers/good-eggs/package.json servers/good-eggs/package-lock.json ./
COPY servers/good-eggs/shared/package.json ./shared/
COPY servers/good-eggs/remote/package.json ./remote/
RUN npm ci --no-audit --no-fund
COPY servers/good-eggs/shared ./shared
COPY servers/good-eggs/remote ./remote
RUN npm run build && npm prune --omit=dev

FROM ${PW} AS build-fetchpet
WORKDIR /src
COPY servers/fetchpet/package.json servers/fetchpet/package-lock.json ./
COPY servers/fetchpet/shared/package.json ./shared/
COPY servers/fetchpet/remote/package.json ./remote/
RUN npm ci --no-audit --no-fund
COPY servers/fetchpet/shared ./shared
COPY servers/fetchpet/remote ./remote
RUN npm run build && npm prune --omit=dev

FROM ${PW} AS build-pointsyeah
WORKDIR /src
COPY servers/pointsyeah/package.json servers/pointsyeah/package-lock.json ./
COPY servers/pointsyeah/shared/package.json ./shared/
COPY servers/pointsyeah/remote/package.json ./remote/
RUN npm ci --no-audit --no-fund
COPY servers/pointsyeah/shared ./shared
COPY servers/pointsyeah/remote ./remote
RUN npm run build && npm prune --omit=dev

# ---- the host ----------------------------------------------------------------
FROM ${PW} AS build-host
WORKDIR /src
COPY servers/bundle/host/package.json servers/bundle/host/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY servers/bundle/host/tsconfig.json ./
COPY servers/bundle/host/src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime -----------------------------------------------------------------
FROM ${PW}

LABEL org.opencontainers.image.source="https://github.com/tadasant/strad"
LABEL org.opencontainers.image.description="strad's single supplementary image — 13 MCP servers (API, Google, 1Password, browser) over streamable-HTTP, one shared Chromium, credential-free."
LABEL org.opencontainers.image.licenses="MIT"

# --- 1Password CLI (op), pinned ----------------------------------------------
# The 1Password server talks to 1Password by shelling out to `op` (spawn('op'),
# no configurable path), so the binary must be on PATH. PINNED on purpose: never
# resolve "latest" at build time, so rebuilding an old commit yields the same
# binary. gVisor (App Platform's sandbox) runs it fine — execve works.
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

ENV NODE_ENV=production
WORKDIR /app

# The six trees, each with the node_modules it was built against.
COPY --from=build-api /src /app/trees/bundle-api
COPY --from=build-google /src /app/trees/bundle-google
COPY --from=build-op /src /app/trees/onepassword
COPY --from=build-goodeggs /src /app/trees/good-eggs
COPY --from=build-fetchpet /src /app/trees/fetchpet
COPY --from=build-pointsyeah /src /app/trees/pointsyeah

# The host: the only new code in this image.
COPY --from=build-host /src/node_modules /app/host/node_modules
COPY --from=build-host /src/dist /app/host/dist
COPY servers/bundle/host/package.json /app/host/package.json
COPY servers/bundle/scripts /app/scripts

# App Platform sets PORT; 8080 is the internal_ports value strad binds.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "/app/host/dist/index.js"]
