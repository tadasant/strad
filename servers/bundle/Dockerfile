# syntax=docker/dockerfile:1
#
# bundle — THE strad supplementary image. Thirty-two MCP servers, one container.
#
# BUILD CONTEXT IS THE REPO ROOT (not servers/bundle/), because this image is
# assembled from twenty-three existing projects that live in different places:
#
#   servers/bundle-api      slack, serpapi-hotels, tailscale, monarch-money,
#                           gcs, google-flights
#   servers/remote-filesystem  remote-filesystem-tmp-public (strad's artifact store)
#   images/bundle-google    gmail, google-calendar, google-docs, google-sheets
#   servers/onepassword     onepassword            (+ the `op` CLI, baked below)
#   servers/secrets         secrets                (Parameter + Secret Manager viewer)
#   servers/good-eggs       good-eggs              ┐
#   servers/fetchpet        fetchpet               ├ one shared Chromium
#   servers/pointsyeah      pointsyeah             ┘
#   servers/x-twitter       X
#   servers/telegram        telegram               (MTProto, USER session)
#   servers/whatsapp        whatsapp               (WhatsApp linked device; Baileys)
#   servers/bill-spend      bill-spend             (BILL Spend & Expense coding)
#   servers/aws-device-farm aws-device-farm        (real iOS hardware, driven over
#                                                  the session's Appium endpoint)
#   servers/liveoak         liveoak                (LiveOak Bank statements,
#                                                  read-only; Cognito + Apiture)
#   servers/ssh             ssh                    (break-glass shell + SFTP, one
#                                                  pinned host per slug)
#   servers/airtable        airtable               (bases, tables, records)
#   servers/flightaware     flightaware            (AeroAPI v4, read-only)
#   servers/digitalocean    digitalocean           (droplets, apps, databases)
#   servers/image-tools     image-diff, svg-tracer (compare two images; trace a
#                                                  bitmap to SVG. Inputs are URLs)
#   servers/nutrition-facts nutrition-facts        (USDA + MenuStat data baked in
#                                                  at build; FatSecret live)
#   servers/pulse-subregistry  pulse-subregistry
#   servers/strad-fetch     strad-fetch            (web fetching; strad's own fork)
#   servers/grafana         grafana                (proxies the pinned mcp-grafana
#                                                  Go binary, baked below)
#
# Each is built in its OWN stage with its OWN lockfile and its OWN node_modules,
# exactly as its standalone image builds it, and copied into /app/trees/<name>.
# Nothing is merged. That is on purpose: merging twenty-three dependency trees is how you
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
COPY servers/bundle-api/upstream/gcs/package.json ./upstream/gcs/
COPY servers/bundle-api/fork/google-flights/package.json ./fork/google-flights/
COPY servers/bundle-api/fork/monarch-money/package.json ./fork/monarch-money/
COPY servers/bundle-api/remote/package.json ./remote/
RUN npm ci --no-audit --no-fund
COPY servers/bundle-api/fork ./fork
COPY servers/bundle-api/upstream ./upstream
COPY servers/bundle-api/remote ./remote
RUN npm run build && npm prune --omit=dev

# ---- bundle-google: gmail / calendar / docs / sheets -------------------------
FROM ${PW} AS build-google
WORKDIR /src
COPY images/bundle-google/package.json images/bundle-google/package-lock.json ./
COPY images/bundle-google/vendor/mcp-elicitation/package.json ./vendor/mcp-elicitation/
COPY images/bundle-google/vendor/gmail-shared/package.json ./vendor/gmail-shared/
COPY images/bundle-google/vendor/google-calendar-shared/package.json ./vendor/google-calendar-shared/
COPY images/bundle-google/vendor/google-docs-shared/package.json ./vendor/google-docs-shared/
COPY images/bundle-google/vendor/google-sheets-shared/package.json ./vendor/google-sheets-shared/
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

# ---- whatsapp -----------------------------------------------------------------
# strad's own WhatsApp server, which is also the long-lived WhatsApp client: a
# linked device (Baileys) whose Signal state and message buffer live in GCS,
# sealed. Its dependencies are the MCP SDK and Baileys (with a WebAssembly
# Signal core, so nothing native is compiled here); it reaches GCS on Node's own
# fetch, with no client library.
FROM ${PW} AS build-whatsapp
WORKDIR /src
COPY servers/whatsapp/package.json servers/whatsapp/package-lock.json ./
COPY servers/whatsapp/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/whatsapp/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- bill-spend ---------------------------------------------------------------
# strad's own BILL Spend & Expense server: re-codes card transactions to the
# right chart-of-accounts value, and re-reads the transaction to prove the write
# landed — BILL's update endpoint can answer 200 SUCCESS and discard it. Its only
# dependency is the MCP SDK; every call is one HTTPS request with a static header.
FROM ${PW} AS build-bill-spend
WORKDIR /src
COPY servers/bill-spend/package.json servers/bill-spend/package-lock.json ./
COPY servers/bill-spend/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/bill-spend/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- aws-device-farm ----------------------------------------------------------
# strad's own AWS Device Farm server: puts a build on a REAL iPhone and drives it
# over the remote-access session's own Appium endpoint. Its dependencies are the
# MCP SDK and the Device Farm client of the AWS SDK; the WebDriver half is plain
# `fetch`, so no browser and no Appium client library are pulled in.
FROM ${PW} AS build-aws-device-farm
WORKDIR /src
COPY servers/aws-device-farm/package.json servers/aws-device-farm/package-lock.json ./
COPY servers/aws-device-farm/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/aws-device-farm/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- liveoak ------------------------------------------------------------------
# strad's own LiveOak Bank server: lists and fetches account statements through
# the portal's Cognito login and Apiture API, as a remembered device whose keys
# are sealed in GCS. Its dependencies are the MCP SDK and the portal's own
# Cognito client library (amazon-cognito-identity-js); no browser.
FROM ${PW} AS build-liveoak
WORKDIR /src
COPY servers/liveoak/package.json servers/liveoak/package-lock.json ./
COPY servers/liveoak/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/liveoak/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- ssh ----------------------------------------------------------------------
# strad's own SSH server: command execution and SFTP on one host per slug, with
# the private key and the pinned host key read from the slug's own namespace.
# Its dependencies are the MCP SDK and ssh2 (pure JS; its optional native
# cpu-features addon is a speed-up, and a build without a compiler skips it).
FROM ${PW} AS build-ssh
WORKDIR /src
COPY servers/ssh/package.json servers/ssh/package-lock.json ./
COPY servers/ssh/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/ssh/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- airtable / flightaware / digitalocean -----------------------------------
# strad's own servers over three plain HTTPS APIs, each authenticated by one
# static key. Their only dependency is the MCP SDK; no browser.
FROM ${PW} AS build-airtable
WORKDIR /src
COPY servers/airtable/package.json servers/airtable/package-lock.json ./
COPY servers/airtable/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/airtable/shared ./shared
RUN npm run build && npm prune --omit=dev

FROM ${PW} AS build-flightaware
WORKDIR /src
COPY servers/flightaware/package.json servers/flightaware/package-lock.json ./
COPY servers/flightaware/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/flightaware/shared ./shared
RUN npm run build && npm prune --omit=dev

FROM ${PW} AS build-digitalocean
WORKDIR /src
COPY servers/digitalocean/package.json servers/digitalocean/package-lock.json ./
COPY servers/digitalocean/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/digitalocean/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- good-eggs / fetchpet / pointsyeah (browser servers) ---------------------
FROM ${PW} AS build-x-twitter
WORKDIR /src
COPY servers/x-twitter/package.json servers/x-twitter/package-lock.json ./
COPY servers/x-twitter/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/x-twitter/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- image-tools ---------------------------------------------------------------
# strad's own image servers: image-diff and svg-tracer, two mounts over one tree.
# sharp (libvips, from its prebuilt platform package) decodes and encodes;
# potrace traces. No browser, no credential. The CPU work runs in a worker
# thread so a large image never stalls this process's event loop.
FROM ${PW} AS build-image-tools
WORKDIR /src
COPY servers/image-tools/package.json servers/image-tools/package-lock.json ./
COPY servers/image-tools/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/image-tools/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- nutrition-facts -----------------------------------------------------------
# strad's own nutrition evidence server. Its LOCAL DATA is built here, at image
# build time: `npm run data` downloads USDA FoodData Central's Foundation, SR
# Legacy and FNDDS releases and NYC Open Data's MenuStat CSV — each pinned by
# SHA-256 in servers/nutrition-facts/shared/src/data/sources.ts, so a download
# that changed under its URL fails this stage by name — and writes two gzipped
# JSON files (~2 MB together) into /src/data. Nothing large is in git. USDA
# Branded (a 449 MB release) is NOT baked; the server reads it live, with a key.
#
# Two stages, so the downloads are cached on the DATA BUILDER alone: the first
# copies only `src/data` and the two modules it imports, so an edit anywhere
# else in the server reuses this layer instead of fetching ~32 MB again.
FROM ${PW} AS data-nutrition-facts
WORKDIR /src
COPY servers/nutrition-facts/package.json servers/nutrition-facts/package-lock.json ./
COPY servers/nutrition-facts/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/nutrition-facts/shared/tsconfig.json ./shared/
COPY servers/nutrition-facts/shared/src/data ./shared/src/data
COPY servers/nutrition-facts/shared/src/nutrients.ts servers/nutrition-facts/shared/src/text.ts ./shared/src/
RUN npm run build && npm run data

FROM ${PW} AS build-nutrition-facts
WORKDIR /src
COPY servers/nutrition-facts/package.json servers/nutrition-facts/package-lock.json ./
COPY servers/nutrition-facts/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/nutrition-facts/shared ./shared
RUN npm run build && npm prune --omit=dev
COPY --from=data-nutrition-facts /src/data ./data

# ---- pulse-subregistry -------------------------------------------------------
FROM ${PW} AS build-pulse-subregistry
WORKDIR /src
COPY servers/pulse-subregistry/package.json servers/pulse-subregistry/package-lock.json ./
COPY servers/pulse-subregistry/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/pulse-subregistry/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- strad-fetch -------------------------------------------------------------
# strad's own web-fetching server, forked from @pulsemcp/pulse-fetch. It is a
# pure-HTTP server despite the company it keeps below: jsdom parses the page,
# nothing launches a browser. See servers/strad-fetch/FORK.md.
FROM ${PW} AS build-strad-fetch
WORKDIR /src
COPY servers/strad-fetch/package.json servers/strad-fetch/package-lock.json ./
COPY servers/strad-fetch/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/strad-fetch/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- grafana -----------------------------------------------------------------
# The proxy half of the Grafana mount: it supervises the pinned mcp-grafana
# binary (fetched in the stage below) over stdio and forwards one MCP surface to
# it. Its only dependency is the MCP SDK — the server itself is Go.
FROM ${PW} AS build-grafana
WORKDIR /src
COPY servers/grafana/package.json servers/grafana/package-lock.json ./
COPY servers/grafana/shared/package.json ./shared/
RUN npm ci --no-audit --no-fund
COPY servers/grafana/shared ./shared
RUN npm run build && npm prune --omit=dev

# ---- mcp-grafana, the pinned Go binary ---------------------------------------
# Grafana ships its MCP server as a Go executable and a Docker image, and as
# nothing else: there is no npm package to build into a tree. So the binary is
# baked in, exactly like `op` below.
#
# THE CHECKSUM IS PINNED HERE, NOT FETCHED. The Zimmer-side bootstrap this mount
# replaces downloaded the release's own `checksums.txt` alongside the tarball and
# compared the two — which proves the download was not corrupted in flight, and
# proves nothing at all about the release, since both files come from the same
# server. The digests below are in the repo: they were verified against the
# published v0.17.1 assets when this landed, they are reviewable in the diff, and
# a re-tagged or substituted release now fails the BUILD rather than shipping.
#
# Both architectures are here because the digest must be selectable without a
# network round-trip. Only amd64 is built today (App Platform), and an arm64
# build — a laptop, a future runner — must not silently fall back to it.
FROM ${PW} AS fetch-mcp-grafana
ARG MCP_GRAFANA_VERSION=0.17.1
ARG MCP_GRAFANA_SHA256_AMD64=d6c2db06c16177eef6d24b7d53b5515f0e1c9fd209317a9ed867884598c763b3
ARG MCP_GRAFANA_SHA256_ARM64=5719e72b9faa65874d271332a6db63d1fae08e2443fe65ee3ab765f785b73bbe
ARG TARGETARCH=amd64
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) asset=x86_64; want="${MCP_GRAFANA_SHA256_AMD64}" ;; \
      arm64) asset=arm64;  want="${MCP_GRAFANA_SHA256_ARM64}" ;; \
      *) echo "mcp-grafana: no pinned digest for TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    curl -fsSL -o /tmp/mcp-grafana.tar.gz \
      "https://github.com/grafana/mcp-grafana/releases/download/v${MCP_GRAFANA_VERSION}/mcp-grafana_Linux_${asset}.tar.gz"; \
    echo "${want}  /tmp/mcp-grafana.tar.gz" | sha256sum -c -; \
    mkdir -p /out; \
    tar xzf /tmp/mcp-grafana.tar.gz -C /out mcp-grafana; \
    chmod 755 /out/mcp-grafana; \
    rm -f /tmp/mcp-grafana.tar.gz; \
    rm -rf /var/lib/apt/lists/*; \
    test "$(/out/mcp-grafana --version)" = "${MCP_GRAFANA_VERSION}"

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
LABEL org.opencontainers.image.description="strad's single supplementary image — 32 MCP servers (API, Google, X.com, Telegram, WhatsApp, web fetching, Grafana, banking, Airtable, FlightAware, DigitalOcean, image diff/tracing, nutrition facts, 1Password, secrets, browser) over streamable-HTTP, one shared Chromium, credential-free."
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

# The twenty-three trees, each with the node_modules it was built against.
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
COPY --from=build-whatsapp /src /app/trees/whatsapp
COPY --from=build-bill-spend /src /app/trees/bill-spend
COPY --from=build-aws-device-farm /src /app/trees/aws-device-farm
COPY --from=build-liveoak /src /app/trees/liveoak
COPY --from=build-ssh /src /app/trees/ssh
COPY --from=build-airtable /src /app/trees/airtable
COPY --from=build-flightaware /src /app/trees/flightaware
COPY --from=build-digitalocean /src /app/trees/digitalocean
COPY --from=build-image-tools /src /app/trees/image-tools
COPY --from=build-nutrition-facts /src /app/trees/nutrition-facts
COPY --from=build-pulse-subregistry /src /app/trees/pulse-subregistry
COPY --from=build-strad-fetch /src /app/trees/strad-fetch
COPY --from=build-grafana /src /app/trees/grafana

# The one upstream in this image that is not JavaScript. It goes on PATH because
# that is where the grafana tree's supervisor looks for it (DEFAULT_BINARY), and
# it is spawned per mount with an allowlisted environment — see
# servers/grafana/shared/src/config.ts for what it is and is not handed.
COPY --from=fetch-mcp-grafana /out/mcp-grafana /usr/local/bin/mcp-grafana

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
