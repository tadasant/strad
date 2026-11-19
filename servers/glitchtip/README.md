# GlitchTip MCP server

strad's own server for a GlitchTip: the organization, its projects and teams,
issues and their events, and one issue in full with its latest event and
comments. Seven tools, all read-only, over GlitchTip's Sentry-compatible API
(`/api/0/`).

It is written rather than vendored. The GlitchTip MCP package on npm,
`@karsten684/glitchtip-mcp-server`, is AGPL-3.0, and strad does not vendor or
link AGPL code. Paths, parameters and response shapes come from GlitchTip's
published OpenAPI, `https://app.glitchtip.com/api/openapi.json`.

## Environment

| Variable                      | Required | What it is                                                             |
| ----------------------------- | -------- | ---------------------------------------------------------------------- |
| `GLITCHTIP_BASE_URL`          | yes      | The GlitchTip's URL, e.g. `https://glitchtip.example.com`; https unless the host is loopback, private, `.internal` or `.local` |
| `GLITCHTIP_API_TOKEN`         | yes      | An API token (Profile → Auth Tokens) with `org:read`, `project:read`, `team:read`, `event:read` |
| `GLITCHTIP_ORGANIZATION_SLUG` | no       | The organization a tool uses when the caller passes no `organization`  |

The variables are read on each call from the environment the server was given,
never at boot. `tools/list` works without them; a call without them fails naming
what is missing.

## Tools

| Tool               | Request                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `get_organization` | `GET /api/0/organizations/{org}/`                                                                 |
| `list_projects`    | `GET /api/0/organizations/{org}/projects/`                                                        |
| `get_project`      | `GET /api/0/projects/{org}/{project}/`                                                            |
| `list_teams`       | `GET /api/0/organizations/{org}/teams/`                                                           |
| `list_issues`      | `GET /api/0/organizations/{org}/issues/`, or `/api/0/projects/{org}/{project}/issues/`            |
| `get_issue`        | `GET /api/0/issues/{id}/`, `…/events/latest/`, `…/comments/`                                       |
| `list_events`      | `GET /api/0/issues/{id}/events/`, or `/api/0/projects/{org}/{project}/events/`                    |

Every request is a `GET` with `Authorization: Bearer`, to the configured origin
only, and a redirect is refused. Lists read one page (`limit`, `cursor`) and
return `next_cursor`, read from the `Link` header. A result over 60,000
characters is cut and says so. The token is scrubbed from every result and
error.

## Tests

```
cd servers/glitchtip && npm ci && npm test
```

Every test runs against a fake GlitchTip built from the OpenAPI's shapes.
Against the real API this server has met only an invalid token's
`401 {"detail": "Unauthorized"}` (`HACKS.md` #155).
