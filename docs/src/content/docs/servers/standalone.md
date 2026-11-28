---
title: Running a server without strad
description: Some of the MCP servers in strad's repository run on their own, over stdio or over Streamable HTTP on a localhost port, with no gateway in front. Which ones, and how.
---

Most of the MCP servers in strad's repository are ordinary MCP servers. strad
mounts them behind one endpoint, but nothing in them needs strad. A server with
a standalone entrypoint runs on its own in two ways:

- **stdio**, launched by a local MCP client such as Claude Desktop or Claude
  Code.
- **Streamable HTTP**, at `/mcp` on a localhost port you choose, for a client
  that connects by URL.

Each one has a README in its own directory with the build, the credentials, the
client config and a curl check.

| Server            | README                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail`           | [`images/bundle-google/vendor/gmail-shared/README.md`](https://github.com/tadasant/strad/blob/main/images/bundle-google/vendor/gmail-shared/README.md)                     |
| `google-calendar` | [`images/bundle-google/vendor/google-calendar-shared/README.md`](https://github.com/tadasant/strad/blob/main/images/bundle-google/vendor/google-calendar-shared/README.md) |
| `google-docs`     | [`images/bundle-google/vendor/google-docs-shared/README.md`](https://github.com/tadasant/strad/blob/main/images/bundle-google/vendor/google-docs-shared/README.md)         |
| `google-drive`    | [`images/bundle-google/vendor/google-drive-shared/README.md`](https://github.com/tadasant/strad/blob/main/images/bundle-google/vendor/google-drive-shared/README.md)       |
| `google-search-console` | [`images/bundle-google/vendor/google-search-console-shared/README.md`](https://github.com/tadasant/strad/blob/main/images/bundle-google/vendor/google-search-console-shared/README.md) |

Inside strad, google-drive is mounted per slug under an `oauth:` connector
([connectors](/operate/connectors/)). It has met only fakes
([limitation #124](/limitations/#124-google-drive-has-met-only-fakes)).

gmail on its own does not send mail. In strad, `send_email` waits for a human
to approve each send, through a channel only the gateway can hand the server
([confirmations](/servers/confirmations/)). With no gateway there is nobody to
ask and no channel to trust, so the standalone entrypoint serves the read,
label and draft tools by default and refuses to start with
`GMAIL_ENABLED_TOOLGROUPS=readwrite_external`. Write a draft and send it from
Gmail.

## What strad adds, and what you give up

A standalone server is the same code strad mounts, built by the same factory. What
you lose is everything strad does in front of it:

- **No authentication on HTTP.** Anyone who can reach the port can use the
  server's credential. The HTTP mode binds `127.0.0.1` by default and refuses a
  request whose `Host` header is not loopback, which stops DNS rebinding from a
  browser tab. It does not stop another process on the same machine.
- **No per-tool policy, no confirmations, no telemetry.** A `tools: allow` list,
  a `confirmations: true` gate and strad's metrics all live in the gateway. A
  tool that needs a confirmation is not served at all (gmail's `send_email`).
  The server's own tool-group variable (`GMAIL_ENABLED_TOOLGROUPS=readonly`,
  `GOOGLE_CALENDAR_ENABLED_TOOLGROUPS=readonly`,
  `GOOGLE_DOCS_ENABLED_TOOLGROUPS=readonly`,
  `GOOGLE_DRIVE_ENABLED_TOOLGROUPS=readonly`) is the one narrowing left. In
  strad, google-docs' `share_document` is kept off every slug but the external
  tier by a `tools:` allow list; on its own, it is served unless you set the
  group. The standalone entrypoint refuses a group it does not recognise, so a
  typo cannot quietly mean "every tool".
- **One credential per process.** strad can mount one server once per account.
  On its own, a server is one process with one set of environment variables.

## The shape, for the next server

The pattern lives in `images/bundle-google/src/standalone/`. `serve.ts` takes a
server factory and runs it over stdio or Streamable HTTP. Its flags are
`--transport stdio|http`, `--port` (else `PORT`, else 3000) and `--host`.
`validateEnv` lets an entrypoint refuse a setting the server would misread.
A server's entrypoint is a few lines beside it that hand over the factory the
bundle already mounts. The README goes in the server's own tree, and a case in
`test/standalone.test.ts` boots both transports with no credentials and lists
the tools.
