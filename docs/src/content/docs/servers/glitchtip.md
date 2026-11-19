---
title: GlitchTip
description: strad's own read-only GlitchTip server — issues, events, projects and teams over GlitchTip's Sentry-compatible API, one GlitchTip per slug.
---

Read a [GlitchTip](https://glitchtip.com) from an agent: the organization, its
projects and teams, error groups (issues) and their events, and one issue in
full with its latest event and comments. The server is strad's own,
`servers/glitchtip`, written against GlitchTip's Sentry-compatible API
(`/api/0/`) and served at `/glitchtip` in strad's bundle image.

It is written rather than vendored. The GlitchTip MCP package on npm,
`@karsten684/glitchtip-mcp-server`, is AGPL-3.0, and strad does not vendor or
link AGPL code. Seven reads over a documented API are less to own than a
stranger's package is to vet.

## Tools

Seven, all `readOnlyHint: true`. Nothing here resolves, assigns, merges or
deletes an issue, whatever the token may do.

| Tool               | What it reads                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `get_organization` | The organization, with its projects (slug, name, platform) and teams                        |
| `list_projects`    | The organization's projects, filterable by name                                              |
| `get_project`      | One project in full, by slug                                                                 |
| `list_teams`       | The organization's teams                                                                     |
| `list_issues`      | Issues, organization-wide or one project's, summarised; `query` defaults to `is:unresolved`  |
| `get_issue`        | One issue, with its latest event (stack trace, request, tags, breadcrumbs) and its comments |
| `list_events`      | One issue's or one project's events, summarised                                              |

Lists read one page: `limit` (default 25, at most 100) and `cursor` in,
`next_cursor` out, null on the last page. `get_issue` takes the numeric issue id
from `list_issues` or the issue's URL, not a short id like `WEB-12`. A result
over 60,000 characters is cut and says so.

## Configuring a slug

| Variable                      | Required | What it is                                                               |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `GLITCHTIP_BASE_URL`          | yes      | The GlitchTip's URL, e.g. `https://glitchtip.example.com`; https unless the host is private |
| `GLITCHTIP_API_TOKEN`         | yes      | An API token from Profile → Auth Tokens, with the read scopes            |
| `GLITCHTIP_ORGANIZATION_SLUG` | no       | The organization a tool uses when the caller passes no `organization`    |

The read scopes are `org:read`, `project:read`, `team:read` and `event:read`.

```yaml
- slug: glitchtip-example
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /glitchtip-example
  entitlements: [admin]
  env:
    GLITCHTIP_BASE_URL: https://glitchtip.example.com
    GLITCHTIP_API_TOKEN: "${GLITCHTIP_EXAMPLE_API_TOKEN}"
    GLITCHTIP_ORGANIZATION_SLUG: example
```

**One instance per slug.** A slug on `path: /<its own slug>` gets its own mount,
built from its own `<SLUG>__GLITCHTIP_*` variables (the
[per-slug variable mechanism](/operate/secrets/)). The URL and the token are
both required for one, so an instance never runs on a sibling's bare value, and
the default organization is read under the slug's own name only. Two
organizations, or two GlitchTips, are two slugs.

Without a URL and token the conventional `/glitchtip` mount lists its seven
tools, reports itself `degraded`, and refuses every call by naming what is
missing.

## What reaches GlitchTip

Every request is a `GET` to the configured origin, with the token as
`Authorization: Bearer`. A redirect is refused rather than followed with the
token attached, so a URL that redirects (`http://` to `https://`, say) fails
with an error that says so. The URL must be https, except for a loopback,
private-network, `.internal` or `.local` host, so the token never crosses the
internet in cleartext. Slugs and issue ids are checked before a path is
built from them, and the token is scrubbed from every result and error.

:::caution
Its tests run against a fake built from GlitchTip's published OpenAPI. Against a
real GlitchTip it has met only an invalid token's `401`. See
[Limitations #155](/limitations/).
:::
