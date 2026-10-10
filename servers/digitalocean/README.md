# DigitalOcean MCP server

strad's server for a DigitalOcean account: droplets, App Platform apps, managed
databases, and the account and billing basics around them. One API token, two
tiers, and database credentials removed from every result.

It replaces `@digitalocean/mcp` (the npx-launched Go binary, about two hundred
tools across eighteen services) for the part of it a small personal account
actually uses. Tool names are upstream's hyphenated ones wherever upstream has
the tool, so a prompt written against one works on the other.

## Environment

| Variable                 | Required | What it is                                                                          |
| ------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `DIGITALOCEAN_API_TOKEN` | yes      | A DigitalOcean personal access token, sent as `Authorization: Bearer`               |
| `ENABLED_TOOLGROUPS`     | no       | `readonly` or `readwrite`. Unset is everything; an unrecognised value is `readonly` |

The token is read on each call from the environment the server was given, never
at boot. `tools/list` works without it; a call without it fails, naming the
variable and saying how to get one. In the strad bundle that environment is a
snapshot taken when the container boots, so a rotated token reaches this server
through a redeploy, not on the next call.

## Getting the token, and its scopes

https://cloud.digitalocean.com/account/api/tokens → **Generate New Token** →
**Custom Scopes**. The token is shown once.

A token without a write scope cannot create or delete anything, whatever tools
a slug is allowed. That makes a narrower token a real fence only for a
deployment that gives its read-only surface a token of its own. **In strad it
does not:** `digitalocean-tadasant-ro` and `-rw` run in one container on one
token, which has to hold the write scopes `-rw` needs, so the gateway's
per-slug `tools:` policy is the only thing keeping `-ro` read-only. Scope names
below are DigitalOcean's, from
https://docs.digitalocean.com/reference/api/scopes/.

**Read-only tier** (what a token for a read-only deployment holds):

```
account:read  actions:read  app:read  billing:read  database:read
droplet:read  image:read  regions:read  sizes:read  ssh_key:read
```

**Read-write tier** (the strad token, shared by `-ro` and `-rw`) — the above,
plus:

```
droplet:create  droplet:update  droplet:delete
app:create      app:update      app:delete
database:create database:update database:delete
```

`droplet:update` is what the power, resize, snapshot, rename and backup actions
need. Depending on what a created droplet references, DigitalOcean may also want
`vpc:read` and `tag:create`; add them if a create comes back 403.

**Do not grant `database:view_credentials`.** It is the scope that lets a token
read database passwords. This server redacts them regardless (below), but a
token that never held the scope cannot leak them through any other client
either.

## Tools

`readonly` is exactly the tools annotated `readOnlyHint: true`; `readwrite` is
everything. In strad the gateway's per-slug `tools:` allow list is the
enforcement, and the `-ro` slug's list is `toolNames(["readonly"])`. It is the
only fence for `-ro`; see the scopes section.

| Tool                            | Group     | Annotations                 | What it does                                                                         |
| ------------------------------- | --------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `account-get-information`       | readonly  | read-only                   | Which account this token is: email, team, status, limits                             |
| `balance-get`                   | readonly  | read-only                   | Month-to-date usage and balance                                                      |
| `billing-history-list`          | readonly  | read-only                   | Invoices and payments, paged                                                         |
| `region-list`                   | readonly  | read-only                   | Region slugs and availability                                                        |
| `size-list`                     | readonly  | read-only                   | Droplet size slugs, specs and prices                                                 |
| `image-list`                    | readonly  | read-only                   | Distribution, 1-Click and private images                                             |
| `key-list`                      | readonly  | read-only                   | SSH public keys on the account                                                       |
| `droplet-list`                  | readonly  | read-only                   | Droplets, summarised, filterable by tag or name                                      |
| `droplet-get`                   | readonly  | read-only                   | One droplet in full                                                                  |
| `droplet-action-get`            | readonly  | read-only                   | Poll a droplet action until `completed` / `errored`                                  |
| `apps-list`                     | readonly  | read-only                   | App Platform apps, summarised                                                        |
| `apps-get-info`                 | readonly  | read-only                   | One app with its full spec, credentials redacted                                     |
| `apps-get-deployment-status`    | readonly  | read-only                   | A deployment's phase and failed steps (default: the latest)                          |
| `apps-get-logs`                 | readonly  | read-only                   | Bounded tail of BUILD / DEPLOY / RUN / RUN_RESTARTED logs                            |
| `db-cluster-list`               | readonly  | read-only                   | Database clusters, summarised, no credentials                                        |
| `db-cluster-get`                | readonly  | read-only                   | One cluster in full, credentials redacted                                            |
| `db-cluster-list-backups`       | readonly  | read-only                   | A cluster's automatic backups                                                        |
| `db-cluster-get-firewall-rules` | readonly  | read-only                   | A cluster's trusted sources; flags an open one                                       |
| `db-cluster-list-users`         | readonly  | read-only                   | A cluster's users, passwords redacted                                                |
| `droplet-create`                | readwrite | write                       | Create one droplet; returns the action to poll                                       |
| `droplet-action`                | readwrite | **destructive**             | power_on/off, shutdown, reboot, power_cycle, resize, snapshot, rename, backups, ipv6 |
| `droplet-delete`                | readwrite | **destructive**, idempotent | Delete a droplet and its disk                                                        |
| `apps-create-app-from-spec`     | readwrite | write                       | Create an app from a spec; refuses one carrying `[redacted]`                         |
| `apps-update`                   | readwrite | **destructive**, idempotent | Replace an app's spec — a full replace; refuses one carrying `[redacted]`            |
| `apps-create-deployment`        | readwrite | write                       | Redeploy, optionally forcing a rebuild                                               |
| `apps-delete`                   | readwrite | **destructive**, idempotent | Delete an app                                                                        |
| `db-cluster-create`             | readwrite | write                       | Create a database cluster                                                            |
| `db-cluster-resize`             | readwrite | **destructive**             | Change size, nodes or storage                                                        |
| `db-cluster-delete`             | readwrite | **destructive**, idempotent | Delete a cluster and all its data                                                    |

Every tool also carries `openWorldHint: true`.

`droplet-action-get` and `apps-create-deployment` have no upstream
equivalent and are named in upstream's style; the rest are upstream's names.

### Lists are paged, never walked

Every list takes `page` (from 1) and `per_page` (default 20, clamped at 200)
and returns `items`, `total` (DigitalOcean's `meta.total`), `has_next_page` and
`next_page`. One call is one page. `/v2/databases` is not paginated by
DigitalOcean, so `db-cluster-list` fetches it once and cuts the page locally.

### Logs

App Platform's logs endpoint returns signed links, not text. `apps-get-logs`
fetches the first `historic_urls` link **without the DigitalOcean token** — the
token goes to `api.digitalocean.com` and nowhere else — and returns at most
200 lines and 64 KB from the end (both lower on request), with `total_lines`
and `dropped_lines` saying what was left out. The signed link itself is never
returned. With no `deployment_id`, RUN and RUN_RESTARTED read the active
deployment and BUILD / DEPLOY read the most recent one, which is where a failed
build is. RUN_RESTARTED is the run before a component's last restart — where a
crash is.

The link is fetched on a short leash:

- **Host.** Only `https` on a host ending `.digitaloceanspaces.com` or
  `.digitalocean.com`, on the default port, and never the API host. Not
  `.ondigitalocean.app`: customers' apps live there. DigitalOcean does not
  document which host it signs log links for, so this is the permissive reading
  of "DigitalOcean's storage"; a link anywhere else is an error naming the host.
- **No redirects.** The fetch is `redirect: "error"`, and a 3xx that arrives
  anyway is refused: the host was checked, the one a redirect names was not.
- **Bounded memory.** The body is streamed and only its last 2 MB is kept. A
  log larger than that comes back with `fetch_truncated: true`, `total_bytes`
  for the whole log, and a note that `total_lines` counts only the window.

A selection with no stored logs but a `live_url` is reported as `live_only`:
those logs exist only as a websocket stream, which this server does not open,
and the live link is not returned either.

## Database credentials are redacted

DigitalOcean's database reads return secrets: `connection.password`, a
`connection.uri` with the password in it, the same under `private_connection`,
`standby_connection` and `standby_private_connection`, `users[].password`, and
Kafka users' `access_cert` / `access_key`. An agent on the read-only tier would
otherwise read every database password on the account.

So every result from every tool is walked before it is returned
(`shared/src/secrets.ts`):

- any field whose name ends in a credential word — matching
  `/(^|_)(password|passwd|secret|token|api_key|apikey|access_key|access_cert|private_key|secret_key|registry_credentials|client_secret)$/i`
  — becomes `"[redacted]"`, at any depth. That covers a database's
  `ui_connection` and `schema_registry_connection`, a Kafka user's
  `access_cert`, an app spec's log destination `api_key` or `token`, and an
  image's `registry_credentials`. The pattern is anchored at the end, so
  `token_type` or `password_expires_at` is left alone;
- an app spec env var (`{key, value, type, scope}`) whose `key` matches the
  same pattern — `DB_PASSWORD`, `GITHUB_TOKEN`, `STRIPE_SECRET` — loses its
  `value` even when its type is `GENERAL`;
- any `scheme://user:password@` string keeps the scheme, user and host and
  loses the password, up to the LAST `@` before the host (so
  `postgres://u:p@ss@h/db` loses all of `p@ss`) — in a database URI, an app
  spec's plaintext env var, or a log line;
- any `?password=`, `&pwd=`, `;sslpassword=`, `token=`, `secret=` or
  `api_key=` query parameter loses its value.

The agent can see that a database exists, its engine, size, host, port, users
and firewall. It never sees what authenticates against it. A human reads
credentials in the control panel. A value DigitalOcean has already encrypted
(`EV[…]`, which is how env vars of type `SECRET` come back) passes through
unchanged, since it is safe to show and can be sent back as is.

### A redacted spec cannot be written back

`apps-update` is a full replace, and `apps-get-info`'s spec is redacted. Sent
back as it is, it would store the literal text `[redacted]` as the app's
database password. So `apps-update` and `apps-create-app-from-spec` refuse any
spec that carries `[redacted]` anywhere — a value, a key, inside a URI, at any
depth — naming the paths and sending nothing. The fix is to re-supply the real
value (an env var holding a credential as `type: SECRET`, which DigitalOcean
encrypts) or to remove that env var or field.

The token itself is scrubbed from every result and every error, and errors are
additionally scrubbed of anything token-shaped.

## What upstream has that this does not

Kubernetes (DOKS), Container Registry, networking (domains, DNS, certificates,
firewalls, load balancers, reserved IPs, VPCs, CDN), Spaces, volumes and NFS,
Functions, Insights, Marketplace, the GenAI and inference services, and docs
search. Within the services covered: droplet snapshots / backups listing and
restore, droplet rebuild and password reset, SSH key management, app rollback,
alerts and instance sizes, database replicas, pools, firewall and user writes,
maintenance windows, and engine configuration.

If you need those, DigitalOcean runs its own hosted remote MCP servers, one per
service, at `https://<service>.mcp.digitalocean.com/mcp` (e.g.
`https://droplets.mcp.digitalocean.com/mcp`, `apps`, `databases`, `accounts`,
`networking`, `doks`), authenticated with the same token as
`Authorization: Bearer`. They are a `remote-http` slug away. They do not redact
database credentials.

## Tested only against a fake

Every test here runs against `shared/test/fake-do.ts`, an injected `fetch` that
answers in DigitalOcean's documented shapes. Nothing in this tree has talked to
the real API. The request shapes, the error envelope, the pagination metadata,
the log-link flow, the log storage host and the field names the redaction
targets are taken from
DigitalOcean's API reference, not observed; a live call is the first proof of
any of them.

```
cd servers/digitalocean && npm ci && npm test
```
