---
title: PulseMCP admin and Proctor
description: "PulseMCP's CMS admin and Proctor servers, vendored into the bundle image and served one instance per API key, so a read-only and a read-write key are two slugs."
---

`pulsemcp-cms-admin` and `proctor` are PulseMCP's own MCP servers, vendored
unchanged from [`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers)
into `servers/pulsemcp-cms-admin/` and `servers/proctor/`, and mounted in the
bundle image at `/pulsemcp-cms-admin` and `/proctor`. They are there for
PulseMCP's strad. No slug in this repo's own configs points at them.

- **pulsemcp-cms-admin** is PulseMCP's admin API: the MCP server directory, the
  newsletter, the official and unofficial mirror queues, tenants and their API
  keys, redirects, background jobs, Proctor exam results, discovered URLs and MOZ
  metrics. 71 tools, 34 of them reads.
- **proctor** runs an exam against an MCP server and manages the Fly machines
  exams run on. Five tools, two of them reads.

Both talk to `https://admin.pulsemcp.com` with one `X-API-Key`.

## Configuration

| Server               | Key (required)           | Base URL (optional, defaults to `https://admin.pulsemcp.com`) |
| -------------------- | ------------------------ | ------------------------------------------------------------- |
| `pulsemcp-cms-admin` | `PULSEMCP_ADMIN_API_KEY` | `PULSEMCP_ADMIN_API_URL`                                      |
| `proctor`            | `PROCTOR_API_KEY`        | `PROCTOR_API_URL`                                             |

`proctor` takes the same admin keys as `pulsemcp-cms-admin`, under its own
variable name. cms-admin also reads `PULSEMCP_ADMIN_INTERNAL_SECRET` when it is
set: it goes out as `X-PulseMCP-Internal`, which lets requests skip Cloudflare's
rate limits on the admin origin. It is read from the bare variable, so every
slug on a bundle sends the same one.

With no key a mount still lists its tools and reports itself `degraded`, and
every call fails naming the missing variable.

## One instance per key

The admin API issues read-only and read-write keys, and the key is what the API
enforces. So each tier is its own slug with its own key, and each slug sits at
`path: /<its own slug>`. The renderer bakes the slug's variables under its own
names (`PULSE_CMS_RO__PULSEMCP_ADMIN_API_KEY`), and the bundle host mounts one
instance per slug that carries a key of its own. A per-slug instance reads its
key and its base URL under its own name only, never a sibling's bare value, so
one tier can point at staging without the other following it.

```yaml
servers:
  - slug: pulse-cms-ro
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /pulse-cms-ro
    entitlements: [admin]
    env:
      PULSEMCP_ADMIN_API_KEY: "${PULSEMCP_ADMIN_API_KEY_RO}"
    tools:
      allow: [get_mcp_server, list_mcp_servers, search_mcp_implementations] # the reads you need
  - slug: pulse-cms-rw
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /pulse-cms-rw
    entitlements: [admin]
    env:
      PULSEMCP_ADMIN_API_KEY: "${PULSEMCP_ADMIN_API_KEY_RW}"
  - slug: proctor-ro
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /proctor-ro
    entitlements: [admin]
    env:
      PROCTOR_API_KEY: "${PULSEMCP_ADMIN_API_KEY_RO}"
    tools:
      allow: [get_proctor_metadata, get_machines]
  - slug: proctor-rw
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /proctor-rw
    entitlements: [admin]
    env:
      PROCTOR_API_KEY: "${PULSEMCP_ADMIN_API_KEY_RW}"
```

Two slugs sharing one path would be one mount, and the render refuses two
different keys there. A `tools: allow` list on a read-only slug is optional,
since the key already refuses writes, but it keeps write tools out of the
slug's `tools/list`.

### The read tools

A read-only slug's allow list can name any of these.

**pulsemcp-cms-admin (34):** `get_newsletter_posts`, `get_newsletter_post`,
`get_authors`, `search_mcp_implementations`, `get_draft_mcp_implementations`,
`find_providers`, `get_official_mirror_queue_items`,
`get_official_mirror_queue_item`, `get_unofficial_mirrors`,
`get_unofficial_mirror`, `get_official_mirrors`, `get_official_mirror`,
`get_tenants`, `get_tenant`, `list_tenant_servers`, `get_mcp_jsons`,
`get_mcp_json`, `list_mcp_servers`, `get_mcp_server`, `get_redirects`,
`get_redirect`, `list_good_jobs`, `get_good_job`,
`list_good_job_cron_schedules`, `list_good_job_processes`,
`get_good_job_queue_statistics`, `get_exam_result`, `list_proctor_runs`,
`get_proctor_metadata`, `list_discovered_urls`, `get_discovered_url_stats`,
`get_moz_metrics`, `get_moz_backlinks`, `get_moz_stored_metrics`.

**proctor (2):** `get_proctor_metadata`, `get_machines`.

## What is not served

Upstream's `TOOL_GROUPS` does nothing here: the bundle removes it, because
narrowing a slug is the gateway's [`tools:` policy](/servers/interface/). Each
mount serves the upstream default, which is every group except cms-admin's
`tenants_destructive`. So `delete_tenant`, `delete_api_key` and `revoke_api_key`
are not reachable through strad. Upstream gates them behind a confirmation
prompt, and strad has not wired one for this server.
See [limitation 153](/limitations/#153-the-pulsemcp-admin-servers-are-vendored-as-is-and-three-cms-admin-tools-are-not-served).

## Changing the code

Both trees are VENDOR: `shared/` is upstream's, byte for byte. A fix lands in
strad, but first the tree moves to PATCHED VENDOR (a delta table in its README
and a `HACKS.md` entry) or FORK (a `FORK.md`), so a re-vendor cannot quietly
undo it. cms-admin's `elicitation/src` is generated from
`servers/onepassword/elicitation/src` by `npm run elicitation:sync`.

`npm test` in either tree runs strad's suite: the surface and its read-only
subset, the key and origin on the wire, and a missing key failing the call
rather than the process.
