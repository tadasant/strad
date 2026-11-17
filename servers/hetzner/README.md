# Hetzner Cloud MCP server

strad's server for a Hetzner Cloud project: servers and their power, metrics
and actions; the images, types and locations they are built from; and the
firewalls, networks, volumes, primary IPs and SSH keys around them. One API
token, two tiers, and no root password in any result.

Hetzner publishes no MCP server of its own (the `hetznercloud` GitHub
organisation has none; the packages on npm and GitHub are third-party), so this
one is written against the Cloud API, `https://api.hetzner.cloud/v1`. Tool names
are strad's house style — snake_case, verb first.

## Environment

| Variable             | Required | What it is                                                                          |
| -------------------- | -------- | ----------------------------------------------------------------------------------- |
| `HCLOUD_TOKEN`       | yes      | A Hetzner Cloud project API token, sent as `Authorization: Bearer`                  |
| `ENABLED_TOOLGROUPS` | no       | `readonly` or `readwrite`. Unset is everything; an unrecognised value is `readonly` |

`HCLOUD_TOKEN` is Hetzner's own name for the variable: the `hcloud` CLI and the
Terraform provider read it too.

The token is read on each call from the environment the server was given, never
at boot. `tools/list` works without it; a call without it fails, naming the
variable and saying how to get one. In the strad bundle that environment is a
snapshot taken when the container boots, so a rotated token reaches this server
through a redeploy, not on the next call.

## Getting the token

https://console.hetzner.cloud → the project → **Security** → **API tokens** →
**Generate API token**. It is shown once.

A token belongs to **one project** and is either **Read** or **Read & Write**;
Hetzner has nothing finer. A Read token cannot change anything, whatever tools
a slug is allowed, so it is a real fence for a deployment that gives its
read-only surface a token of its own. **In strad it does not:** the `-ro` and
`-rw` slugs run in one container on one token, which has to be Read & Write
for `-rw`, so the gateway's per-slug `tools:` policy is the only thing keeping
`-ro` read-only.

## Blast radius

A token reaches its whole project. strad's `hetzner-pulse-*` slugs reach the
`pulsemcp-ci` project, whose one server is the CI runner box PulseMCP's
production CI runners share with tadasant's. A mistake on `-rw` stops every
pipeline on that box, other people's production CI included. So:

- every tool that can take a machine down or lose data ends its description
  with a **BLAST RADIUS** paragraph saying so, where the agent reads it;
- **nothing here can turn Hetzner's delete or rebuild protection off.** A
  `delete_server` or `rebuild_server` against a protected server fails with
  `protected`, and the error says a human lifts protection in the console;
- `set_firewall_rules` refuses an empty rule set unless `clear_all: true` — an
  empty set on a default-deny firewall cuts every server it is on off the
  internet.

## Tools

`readonly` is exactly the tools annotated `readOnlyHint: true`; `readwrite` is
everything. In strad the gateway's per-slug `tools:` allow list is the
enforcement, and the `-ro` slug's list is `toolNames(["readonly"])`.

| Tool                  | Group     | Annotations                 | What it does                                                                    |
| --------------------- | --------- | --------------------------- | ------------------------------------------------------------------------------- |
| `list_servers`        | readonly  | read-only                   | Servers, summarised, filterable by name, label selector and status              |
| `get_server`          | readonly  | read-only                   | One server in full, including traffic and the price of its type                 |
| `get_server_metrics`  | readonly  | read-only                   | CPU, disk or network over the last N minutes: min / max / avg / last per series |
| `list_server_actions` | readonly  | read-only                   | What was done to a server, newest first                                         |
| `get_action`          | readonly  | read-only                   | Poll any action a write returned until `success` / `error`                      |
| `list_images`         | readonly  | read-only                   | System images, snapshots, backups and app images                                |
| `list_server_types`   | readonly  | read-only                   | Sizes with cores, RAM, disk and gross EUR price per location                    |
| `list_locations`      | readonly  | read-only                   | Locations and their network zones                                               |
| `list_datacenters`    | readonly  | read-only                   | Which server types each datacenter has capacity for right now                   |
| `list_ssh_keys`       | readonly  | read-only                   | SSH public keys stored in the project                                           |
| `list_firewalls`      | readonly  | read-only                   | Firewalls, their rules and what they are applied to                             |
| `list_networks`       | readonly  | read-only                   | Private networks, subnets, routes and attached servers                          |
| `list_primary_ips`    | readonly  | read-only                   | Public IPv4 / IPv6 addresses and what they are assigned to                      |
| `list_volumes`        | readonly  | read-only                   | Block storage volumes and what they are attached to                             |
| `create_server`       | readwrite | write                       | Create one server; an SSH key is required                                       |
| `create_server_image` | readwrite | write                       | Snapshot a server's disk                                                        |
| `create_ssh_key`      | readwrite | write                       | Add a public key to the project; refuses a private one                          |
| `attach_volume`       | readwrite | write                       | Attach a volume to a server                                                     |
| `power_server`        | readwrite | **destructive**             | poweron, shutdown, reboot, poweroff (hard), reset (hard)                        |
| `rebuild_server`      | readwrite | **destructive**             | Wipe the disk and reinstall from an image                                       |
| `change_server_type`  | readwrite | **destructive**             | Resize; the server must be off; `upgrade_disk` is permanent                     |
| `delete_server`       | readwrite | **destructive**, idempotent | Delete a server and its disk                                                    |
| `delete_image`        | readwrite | **destructive**, idempotent | Delete a snapshot or backup                                                     |
| `delete_ssh_key`      | readwrite | **destructive**, idempotent | Remove a key from the project (servers that have it keep it)                    |
| `set_firewall_rules`  | readwrite | **destructive**, idempotent | Replace a firewall's whole rule set                                             |
| `apply_firewall`      | readwrite | **destructive**, idempotent | Put a firewall on a server                                                      |
| `remove_firewall`     | readwrite | **destructive**, idempotent | Take a firewall off a server                                                    |
| `detach_volume`       | readwrite | **destructive**             | Detach a volume without asking the OS                                           |

Every tool also carries `openWorldHint: true`.

### Writes are asynchronous

Every write returns at once with an `action_id` and `status: running`. Only
`get_action` answering `success` means the change happened; `error` carries
Hetzner's reason. A server with an action still running reads `locked: true`,
and a second write against it fails with `locked`.

### Lists are paged, never walked

Every list takes `page` (from 1) and `per_page` (default 25, clamped at 50,
Hetzner's ceiling) and returns `items`, `total`, `has_next_page` and
`next_page`. One call is one page: a project token's budget is 3,600 requests
an hour.

### Metrics

`get_server_metrics` asks for a window ending now (`minutes`, default 60, at
most 30 days — all Hetzner keeps) at a step that yields about `max_points`
samples, and returns each series as `points`, `min`, `max`, `avg`, `last` and
up to `max_points` evenly spaced values, always including the newest. CPU is a
percentage of ONE core, so a 32-core box at full load reads near 3200.

## Credentials in results

The token is scrubbed from every result and every error, and errors are
additionally scrubbed of anything token-shaped. The token is only ever sent to
the API origin, and a redirect is refused rather than followed with it.

`create_server` and `rebuild_server` can answer with a generated
`root_password`. Every result is walked and any field named like a credential
(`password`, `root_password`, `token`, `secret`, `private_key`, `wss_url`)
becomes `"[redacted]"` at any depth, so a rebuild says a password was generated
without saying what it is. `create_server` requires an SSH key for that reason:
without one the box would be reachable only by a password nobody can read.

## What the API has that this does not

Load balancers, floating IPs, placement groups, certificates, ISOs, DNS,
Storage Boxes and the Robot (dedicated server) API; and within the resources
covered, creating or deleting networks, volumes and primary IPs, assigning a
primary IP, and every label or name update.

Absent on purpose: `reset_password` and `enable_rescue` (each returns a root
password), `request_console` (a VNC URL and password), and every
`change_protection` — the switch a human sets so a box cannot be deleted or
rebuilt by mistake.

## Tested only against a fake

Every test here runs against `shared/test/fake-hetzner.ts`, an injected `fetch`
that answers in Hetzner's documented shapes. Nothing in this tree has talked to
the real API. The request shapes, the error envelope and its codes, the
pagination metadata and the metrics format are taken from Hetzner's API
reference (https://docs.hetzner.cloud/), not observed; a live call is the first
proof of any of them.

```
cd servers/hetzner && npm ci && npm test
```
