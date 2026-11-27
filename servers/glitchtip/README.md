# GlitchTip MCP server

strad's own server for a GlitchTip: the organization, its projects and teams,
issues and their events, and one issue in full with its latest event and
comments. Seven read-only tools over GlitchTip's Sentry-compatible API
(`/api/0/`), and two opt-in writes behind `GLITCHTIP_ALLOW_WRITE`.

It is written rather than vendored. The GlitchTip MCP package on npm,
`@karsten684/glitchtip-mcp-server`, is AGPL-3.0, and strad does not vendor or
link AGPL code. Paths, parameters and response shapes come from GlitchTip's
published OpenAPI, `https://app.glitchtip.com/api/openapi.json`.

## Environment

| Variable                      | Required | What it is                                                             |
| ----------------------------- | -------- | ---------------------------------------------------------------------- |
| `GLITCHTIP_BASE_URL`          | yes      | The GlitchTip's URL, e.g. `https://glitchtip.example.com`; https unless the host is loopback, private, `.internal` or `.local` |
| `GLITCHTIP_API_TOKEN`         | yes      | An API token (Profile → Auth Tokens) with `org:read`, `project:read`, `team:read`, `event:read`; a write slug adds `event:write` for `update_issue` and `project:admin` for `delete_project` |
| `GLITCHTIP_ORGANIZATION_SLUG` | no       | The organization a tool uses when the caller passes no `organization`  |
| `GLITCHTIP_ALLOW_WRITE`       | no       | Exactly `true` lists and serves the two write tools; anything else, or unset, leaves the seven reads only |

The variables are read on each call from the environment the server was given,
never at boot. `tools/list` works without them; a call without them fails naming
what is missing. `GLITCHTIP_ALLOW_WRITE` is the exception: it decides the tool
surface, so it is read once, when the server is created.

In strad's bundle the switch is own-name only. `<SLUG>__GLITCHTIP_ALLOW_WRITE`
(the slug uppercased, `-` to `_`) opens that slug's writes; a bare
`GLITCHTIP_ALLOW_WRITE`, or a sibling's, opens no other slug, the conventional
`/glitchtip` included.

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

### Write tools (`GLITCHTIP_ALLOW_WRITE=true` only)

| Tool             | Request                                                         | Token scope     | Annotations                                  |
| ---------------- | --------------------------------------------------------------- | --------------- | -------------------------------------------- |
| `update_issue`   | `PUT /api/0/issues/{id}/` with `{"status": "resolved" \| "unresolved" \| "ignored"}` | `event:write`   | `readOnlyHint: false`, `destructiveHint: false` |
| `delete_project` | `DELETE /api/0/projects/{org}/{project}/`                       | `project:admin` | `readOnlyHint: false`, `destructiveHint: true`  |

`delete_project` is irreversible: GlitchTip deletes the project with its issues
and events. It requires `confirm_project_slug`, which must equal `project`
exactly, and sends nothing otherwise.

Paths, methods and bodies are from the OpenAPI. The OpenAPI declares no scopes,
so these are from GlitchTip's source (`glitchtip-backend`):
`update_issue` is guarded by `event:write` or `event:admin`, and
`delete_project` by `project:admin`. GlitchTip grants `event:write` to every
organization role and `project:admin` only to Admin, Manager and Owner, so a
delete token's user needs one of those roles.

Reads are `GET`, writes are `PUT` or `DELETE`, all with `Authorization:
Bearer`, to the configured origin only, and a redirect is refused. A write is
never retried, and a timeout or 5xx on one says it may have landed. Lists read one page (`limit`, `cursor`) and
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
