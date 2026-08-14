# syntax=docker/dockerfile:1
#
# bundle — THE strad supplementary image. Seventeen MCP servers, one container.
#
# BUILD CONTEXT IS THE REPO ROOT (not servers/bundle/), because this image is
# assembled from ten existing projects that live in different places:
#
#   servers/bundle-api      slack, serpapi-hotels, tailscale, monarch-money,
#                           gcs, google-flights
#   servers/remote-filesystem  remote-filesystem-tmp-public (strad's artifact store)
#   images/bundle-google    gmail, google-calendar, google-docs
#   servers/onepassword     onepassword            (+ the `op` CLI, baked below)
#   servers/secrets         secrets                (Parameter + Secret Manager viewer)
#   servers/good-eggs       good-eggs              ┐
#   servers/fetchpet        fetchpet               ├ one shared Chromium
#   servers/pointsyeah      pointsyeah             ┘
#   servers/x-twitter       X
#   servers/telegram        telegram               (MTProto, USER session)
#   servers/pulse-subregistry  pulse-subregistry
#
# Each is built in its OWN stage with its OWN lockfile and its OWN node_modules,
# exactly as its standalone image builds it, and copied into /app/trees/<name>.
# Nothing is merged. That is on purpose: merging eleven dependency trees is how you
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

# ---- bundle-api: six pure-API servers ---------------------------------------
FROM ${PW} AS build-api
WORKDIR /src
COPY servers/bundle-api/package.json servers/bundle-api/package-lock.json ./
COPY servers/bundle-api/fork/slack/package.json ./fork/slack/
COPY servers/bundle-api/upstream/serpapi-hotels/package.json ./upstream/serpapi-hotels/
COPY servers/bundle-api/upstream/tailscale/package.json ./upstream/tailscale/
COPY servers/bundle-api/upstream/monarch-money/package.json ./upstream/monarch-money/
COPY servers/bundle-api/upstream/gcs/package.json ./upstream/gcs/
COPY servers/bundle-api/fork/google-flights/package.json ./fork/google-flights/
COPY servers/bundle-api/remote/package.json ./remote/
RUN npm ci --no-audit --no-fund
COPY servers/bundle-api/fork ./fork
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

# ---- secrets ------------------------------------------------------------------
# Google Cloud Parameter Manager + Secret Manager (viewer): parameter names,
# kinds, notes and non-secret values. Its client is fetch + node:crypto, so this
# tree's only dependency is the MCP SDK.
FROM ${PW} AS build-secrets
WORKDIR /src
COPY servers/secrets/package.json servers/secrets/package-lock.json ./
COPY servers/secrets/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/secrets/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- remote-filesystem --------------------------------------------------------
# strad's own artifact store: uploads to ONE GCS bucket and hands back a link.
# Its only dependencies are the MCP SDK, zod and @google-cloud/storage.
FROM ${PW} AS build-remotefs
WORKDIR /src
COPY servers/remote-filesystem/package.json servers/remote-filesystem/package-lock.json ./
COPY servers/remote-filesystem/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/remote-filesystem/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- telegram -----------------------------------------------------------------
# strad's own Telegram server, over MTProto with a USER session — the only
# protocol that can read a group the account joined and does not administer. Its
# dependencies are the MCP SDK and the MTProto client library.
FROM ${PW} AS build-telegram
WORKDIR /src
COPY servers/telegram/package.json servers/telegram/package-lock.json ./
COPY servers/telegram/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/telegram/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- good-eggs / fetchpet / pointsyeah (browser servers) ---------------------
FROM ${PW} AS build-x-twitter
WORKDIR /src
COPY servers/x-twitter/package.json servers/x-twitter/package-lock.json ./
COPY servers/x-twitter/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/x-twitter/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- pulse-subregistry -------------------------------------------------------
FROM ${PW} AS build-pulse-subregistry
WORKDIR /src
COPY servers/pulse-subregistry/package.json servers/pulse-subregistry/package-lock.json ./
COPY servers/pulse-subregistry/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/pulse-subregistry/shared ./shared
RUN npm run build && npm prune --omit=dev

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
LABEL org.opencontainers.image.description="strad's single supplementary image — 17 MCP servers (API, Google, X.com, Telegram, 1Password, secrets, browser) over streamable-HTTP, one shared Chromium, credential-free."
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

# SIZE, honestly: ~3.9GB, and the Playwright base is ~85% of it (it ships Firefox
# and WebKit, which nothing here launches). `rm -rf`ing them buys nothing — the
# layer that contains them is still pulled. Slimming this means a `node:22-slim`
# runtime with Chromium and its system libraries copied in, which is a real piece
# of work and a real risk of a missing .so surfacing only in staging. It is a
# follow-up, and the trade is stated here rather than pretended away. Note the
# fleet-wide footprint still fell: this replaces THREE Playwright-based images.
ENV NODE_ENV=production
WORKDIR /app

# The eleven trees, each with the node_modules it was built against.
COPY --from=build-api /src /app/trees/bundle-api
COPY --from=build-google /src /app/trees/bundle-google
COPY --from=build-op /src /app/trees/onepassword
COPY --from=build-secrets /src /app/trees/secrets
COPY --from=build-remotefs /src /app/trees/remote-filesystem
COPY --from=build-goodeggs /src /app/trees/good-eggs
COPY --from=build-fetchpet /src /app/trees/fetchpet
COPY --from=build-pointsyeah /src /app/trees/pointsyeah
COPY --from=build-x-twitter /src /app/trees/x-twitter
COPY --from=build-telegram /src /app/trees/telegram
COPY --from=build-pulse-subregistry /src /app/trees/pulse-subregistry

# The host: the only new code in this image.
COPY --from=build-host /src/node_modules /app/host/node_modules
COPY --from=build-host /src/dist /app/host/dist
COPY servers/bundle/host/package.json /app/host/package.json
COPY servers/bundle/scripts /app/scripts

# The telemetry bootstrap, vendored from telemetry/bundle by `npm run
# telemetry:sync` (CI fails if the copies drift). It lives INSIDE the host tree
# so its bare `@opentelemetry/*` imports resolve from /app/host/node_modules.
# With no OTEL_EXPORTER_OTLP_ENDPOINT it starts nothing and logs one line — the
# image is identical whether or not anything is collecting.
COPY servers/bundle/otel /app/host/otel

# App Platform sets PORT; 8080 is the internal_ports value strad binds.
ENV PORT=8080
EXPOSE 8080

# --import runs the bootstrap to completion BEFORE the host loads, which is what
# lets it publish the Chromium hooks on globalThis in time for the first launch.
CMD ["node", "--import", "/app/host/otel/instrument.mjs", "/app/host/dist/index.js"]
