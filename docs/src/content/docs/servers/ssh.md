---
title: SSH
description: strad's own SSH server — break-glass shell and SFTP on one host per slug, with the private key and a pinned host key held in strad's store, strict host-key checking, and checked-in entitlements only.
---

A shell on a machine, for when something is on fire and the product's own
surfaces cannot tell you why. `ssh` is strad's own MCP server: the source is in
`servers/ssh/`, and every host is its own store-served instance of it inside the
bundle image.

It replaces the npm package `ssh-agent-mcp-server`, which a client spawned
locally with `npx` and pointed at the user's SSH agent. The tool names and
arguments are that package's, so a catalog entry can be repointed without
surprising anyone who used it. Where they could not keep their meaning, they say
so ([below](#what-changed-from-ssh-agent-mcp-server)).

:::danger[Break-glass, not routine]
strad's production invariant is that products are run without box access. A
task that needs `ssh_execute` more than once is a missing API, deploy step or
workflow, and the fix is to build that. These tools are for diagnosis and
emergencies, and the production slugs are entitled to humans only.
:::

## One slug per host

A host is an identity: its address, the account on it, the key that logs in, and
the host key it must present belong together. So each host is one slug, and each
slug is one instance of this server reading **only its own namespace**.

```yaml
- slug: ssh-ci-runner
  kind: supplementary-image
  title: CI runner (SSH)
  description: >-
    Break-glass SSH to the self-hosted GitHub Actions runner, as the
    unprivileged runner user.
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /_instance/ssh/ssh-ci-runner
  params: true
  entitlements: [admin]
```

That entry renders nothing onto the container. The bundle host learns about the
slug from core and reads `/strad/{env}/mcp/ssh-ci-runner/static/*` through core
when it builds the instance — see [store-served
instances](/operate/secrets/#store-served-instances--a-mount-credentialed-from-its-own-namespace).
No bare name from the container is ever used, so a half-seeded slug degrades and
says what is missing rather than completing itself from a sibling host.

**It needs `gcp-parameter-store`**, like every store-served instance, and an
instance is the only way an SSH host is served. The conventional `/ssh` mount
lists the tools and is handed no environment, so no variable baked onto the
container can credential it, and the host discovers no per-slug SSH mounts from
its environment. A slug the environment could conjure is one the runtime roster
could alias, and that would put who may reach a shell outside the checked-in
config.

### Who may reach one

Entitlements on an SSH slug are the whole of its safety, so they are held to a
higher bar than any other server's:

- **An SSH slug is never runtime-creatable.** The roster refuses to create one
  from either door (`src/config/overlay.ts`). It comes from the checked-in config,
  through a reviewed deploy. A checked-in slug's `entitlements:` and `tools:`
  cannot be moved by a runtime write, and removing and re-creating it does not
  get around that.
- **Production hosts are `entitlements: [admin]`**, meaning a human, never an
  agent role.
- **Whoever can write the slug's namespace decides the host and the pin.**
  `SSH_HOST` and `SSH_HOST_KEY` re-pointed together send the next command to a
  machine of the writer's choosing. Seed them in the console as a human, and keep
  `/strad/{env}/mcp/ssh-*/` out of any namespace the [`secrets`
  server](/operate/secrets/)'s credential can write.
- **On a root account, `ssh_upload` is a shell.** A writable cron file,
  `authorized_keys`, or a `mode` of `4755` is code execution. A read-only tier
  is `tools: { allow: [ssh_connection_info, ssh_check_connection, ssh_list_directory, ssh_download] }`;
  there is no meaningful "write but not execute" tier on root.

:::caution[`ssh-tadasant-zimmer-prod` stays unreachable from Zimmer sessions]
Zimmer sessions run **on** that host, and root there is reserved for human
break-glass. Its slug must be entitled to `admin` only, never to the `zimmer`
role or any role a Zimmer session holds, and its description keeps the "DANGER -
PRODUCTION SSH" wording. The same `admin`-only default is suggested for
`ssh-tadasant-obs-prod` (root on the production observability droplet). Whether
any agent role ever gets that one is the operator's decision, made in the
checked-in config.
:::

## Setup

Seed these under the slug's own namespace in the console (`/ui/secrets`, the
slug, `static/<NAME>`):

| Name                  | Required | What it is                                                                                                                                          |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SSH_HOST`            | yes      | Hostname or IP.                                                                                                                                     |
| `SSH_USERNAME`        | yes      | The account to log in as.                                                                                                                           |
| `SSH_PRIVATE_KEY`     | yes      | The private key, OpenSSH (`-----BEGIN OPENSSH PRIVATE KEY-----`) or PEM. Pasted with real newlines, as one line with literal `\n`, or as base64.     |
| `SSH_HOST_KEY`        | yes      | The host key to pin: a line from `ssh-keyscan -p <port> <host>`, a bare `ssh-ed25519 AAAA…` key, or a `SHA256:…` fingerprint. One per line, any may match. |
| `SSH_PORT`            | no       | Default `22`.                                                                                                                                       |
| `SSH_PASSPHRASE`      | no       | Only if the key is encrypted.                                                                                                                       |
| `SSH_TIMEOUT`         | no       | Connect timeout in ms. Default `15000`: a powered-off host usually swallows the connection, so this is how long a call to it waits before saying so. |
| `SSH_COMMAND_TIMEOUT` | no       | Default inactivity timeout for `ssh_execute`, in ms. Default `60000`.                                                                               |
| `SSH_UNREACHABLE_HINT` | no      | Why this host may be down and how to bring it up, quoted in every unreachable error. One line, at most 500 characters. See [below](#a-host-that-is-down). |

Then deploy the config change that adds the slug. A credential rotated later is
picked up on the next instance sync, with no deploy. `ENABLED_TOOLGROUPS` is not
a setting here: the bundle scrubs it from the container, and a value seeded in an
instance's namespace only narrows that instance (an unrecognised value narrows it
to `readonly`). Use `tools:` instead.

**Get the host key out of band.** `ssh-keyscan` over the open internet tells you
what answered, which is the thing being verified. Read it on the host itself
(`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) or from a machine that
already trusts it (`ssh-keygen -F '[host]:port'` in its `known_hosts`), and
compare fingerprints. `ssh_connection_info` shows the fingerprint of every pin.

**Allow the key on the host.** The public half goes in the account's
`~/.ssh/authorized_keys`. A dedicated key per host, generated for strad, is
better than reusing a person's key: it can be removed without locking anyone out.

## Strict host-key checking

There is no trust on first use. A container has nowhere durable to remember a
key and nobody at a prompt to ask, so the key is part of the configuration:

- **No pin, no connection.** `SSH_HOST_KEY` is required. A slug without it
  reports itself unconfigured and opens no socket.
- **The wrong key is refused before authentication.** The check runs during key
  exchange, so a host presenting any other key never receives a signature made
  with ours. The error names both fingerprints and says not to retry.
- **Negotiation asks for the pinned type.** When every pin is a full key, the
  client offers only those key types, so a host with both an RSA and an Ed25519
  key presents the one that was pinned. A fingerprint does not say its type, so
  a pin set that includes one leaves negotiation at the default.

The host field of a `known_hosts` line is not compared with `SSH_HOST`: the pin
already belongs to exactly one slug. `@cert-authority` and `@revoked` lines are
refused, not half-understood.

## Tools

| Tool                  | Group                  | What it does                                                                                     |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `ssh_connection_info` | readonly, write, admin | Slug, host, port, user, key type, pinned fingerprints, what is missing. `test_connection: true` adds the same check as `ssh_check_connection`. |
| `ssh_check_connection` | readonly, write, admin | The retry: connect, verify the pin, log in, disconnect. Returns `ok` and a `status` — `ok`, `unreachable`, `host_key_mismatch`, `not_configured` or `connect_failed` — with the presented fingerprint, or the error and the next step. |
| `ssh_list_directory`  | readonly, write, admin | List a directory over SFTP, sorted, at most 1000 entries.                                        |
| `ssh_download`        | readonly, write, admin | Return a file's content: utf8 for text, base64 otherwise, up to 2 MiB a call, paged by `offset`. |
| `ssh_upload`          | write, admin           | Write a file from `content` (utf8 or base64), up to 2 MiB, with an optional `mode`.              |
| `ssh_execute`         | admin                  | Run a command. Returns exit code, signal, stdout, stderr. Inactivity timeout, 15-minute ceiling. |

The groups are the upstream's. In strad they are not the enforcement: the bundle
runs every mount at full capability and the slug's [`tools:`
policy](/intro/concepts/) decides what it may call, so a read-only slug is
`tools: { allow: [ssh_connection_info, ssh_check_connection, ssh_list_directory, ssh_download] }`.

**Each call is its own connection.** Nothing is pooled, so there is no standing
authenticated session on a production host inside a shared container. The
handshake costs a few hundred milliseconds per call.

**Output is bounded as it arrives.** Each stream keeps its first and last 32 KiB
and reports how many bytes it dropped in between, so `cat` of a huge log costs
the container a fixed amount of memory. A non-zero exit code is a result, not a
tool error.

**The timeout is for inactivity**, as upstream: it restarts on every byte of
output, so a long job that keeps printing finishes, up to a hard ceiling of 15
minutes, which is what ends a `tail -f`. A timed-out command returns its partial
output, `timedOut: true` and `timeout: "inactivity"` or `"ceiling"`, and is sent
`SIGKILL` where sshd supports that.

**A call is also bounded by core.** strad gives up on a slug's call after its
`timeoutMs` — 120 s unless the entry sets one. When it does, the call's SSH
connection is closed with it, so a command nobody is waiting for does not keep a
session on the host. Set `timeoutMs` on an SSH slug (the example uses 960 000,
just over the 15-minute ceiling) if long commands are expected.

**Nothing waits forever on a stuck host.** A connection that closes during the
handshake is an error, not a hang. Every SFTP step, and opening a command's
channel, has the `SSH_COMMAND_TIMEOUT` deadline: a live connection to a host
whose filesystem is hung still answers keepalives, so on expiry the connection is
closed and the error says so. No terminal is allocated, so a command waiting on a prompt
(`sudo`, an editor, a pager) waits until the timeout.

## A host that is down

Some of these hosts are off on purpose: Zimmer staging is spun down whenever
nobody is using it. A host that does not answer is an ordinary state here, not a
failure of the server, and it never fails the MCP connection.

- **`initialize` and `tools/list` never touch the host.** They open no socket
  and wait on nothing, so a slug whose host is off connects, lists all six tools,
  and is usable the moment the host is back. The tool list does not change with
  the host's state, so there is no `tools/list_changed` to wait for.
- **Every call that cannot reach the host says so, and says what to do.** A DNS
  failure, a network error, or no reply at all within `SSH_TIMEOUT` comes back
  as:

  ```
  ssh-tadasant-zimmer-staging: UNREACHABLE: root@staging.zimmer.tadasant.com:2222
  did not answer: no reply within 15000 ms. The host is most likely powered off
  or spun down, or a firewall is dropping this source address. Nothing was sent
  to it and the private key was not used. About this host: <SSH_UNREACHABLE_HINT>
  Once it is up, call ssh_check_connection to confirm, then retry this call — no
  reconnect of the MCP session is needed.
  ```

  With no hint set, "About this host: …" reads "If this host is meant to be
  always on, treat it as an outage." A refused port is `UNREACHABLE` too, worded
  for what it means: the machine is up and nothing listens on the port — sshd is
  down or still starting, or `SSH_PORT` is wrong.
- **`ssh_check_connection` is the retry.** Call it after bringing the host up. It
  makes one fresh connection, and once it reports `"status": "ok"` with the host
  key it saw, every other tool works on its next call, in the same session.
- **A host that drops under a call says so.** If the connection dies during a
  command or a transfer — the host went down, or restarted — the call fails with
  "the connection … was lost", says the command may or may not have run, and
  points at `ssh_check_connection`. It is never reported as a finished command.
- **The other failures stay distinct**, because none of them is fixed by turning
  a machine on:

  | What happened                                                       | The error says                                                              | `ssh_check_connection` status |
  | ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------- |
  | The host presented another key                                       | `REFUSED` … "do not retry"                                                  | `host_key_mismatch`           |
  | A parameter is missing or malformed                                 | `Not configured` and its name                                               | `not_configured`              |
  | TCP connected but no SSH greeting, or it closed before one          | the machine is up and its sshd is stuck, refusing, or behind a firewall     | `connect_failed`              |
  | The host showed the pinned key and the login stalled                | the host is up and slow (overload, reverse DNS, PAM); a retry may work      | `connect_failed`              |
  | The host rejected the key                                           | the key's public half is not in `authorized_keys`                           | `connect_failed`              |

`SSH_UNREACHABLE_HINT` is the per-slug sentence that makes the message specific
— for staging, "Spun down when idle; bring it up with the Deploy staging
workflow." It is text and nothing else: it cannot change the pin, the key or
who may call the slug.

## A host on a Tailscale tailnet

A host whose `SSH_HOST` is a MagicDNS name (`*.ts.net`) or resolves into
Tailscale's ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) has no route from
the internet: Zimmer's droplets are the case here, with `staging.zimmer.tadasant.com`
resolving to a tailnet address and OpenSSH on tailnet port 2222. A MagicDNS
name has to be written in full (`zimmer-staging.tail52556f.ts.net`): the
container does not use the tailnet's DNS, so a short name does not resolve. The tree dials
such a host through the bundle's tailnet sidecar, a userspace `tailscaled`, and
every other host direct, as before. The route is decided by the address alone,
and the pin is checked the same way on both.

The sidecar exists only on a bundle whose config has a `tailnet:` block, and
it is off by default. [Tailnet egress](/operate/tailnet/) covers the
mechanism, the tailnet policy that bounds it, the credential, audit and
rollback. Without it, a call to a tailnet host comes back `Not configured`
("this container has no tailnet egress") and nothing is dialed. With it, the
answers are the ones above, plus two that name the tailnet:

| What happened                                                    | The error says                                                                              | `ssh_check_connection` status |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| The tailnet could not reach the host                             | `UNREACHABLE`: down or offline on the tailnet, or the policy does not allow this port       | `unreachable`                 |
| The sidecar is not accepting connections (starting, restarting)  | the tailnet sidecar is not up; retry, and the bundle's `/healthz` `tailnet` field says why  | `connect_failed`              |

## What changed from `ssh-agent-mcp-server`

- **Authentication is a key from the store.** No SSH agent, no key file, no
  password, no keyboard-interactive prompt. `SSH_AUTH_SOCK` and
  `SSH_PRIVATE_KEY_PATH` are not read; `SSH_PRIVATE_KEY` holds the key itself.
- **The host key is pinned** (`SSH_HOST_KEY`, required). The upstream accepted
  whatever key answered.
- **`ssh_download` returns the content and `ssh_upload` takes it.** Both took a
  `localPath`, a file on the machine the server ran on. Here that machine is a
  shared container nobody can open, so a call that passes `localPath` is refused
  with an error saying so.
- **Output and transfers are capped**, as above, and `ssh_list_directory`
  returns `{ path, total, truncated, entries }` rather than a bare array, with a
  `symlink` / `other` type beside `file` and `directory`.
- **A signal is not exit code 0.** The upstream reported `0` for a command
  killed by a signal; here `exitCode` is `null` and `signal` names it.
- **No startup health check and no `ssh://config` resource.** The upstream
  tried the host at boot and failed to start when it timed out, so a spun-down
  host failed the client's MCP connection. Here nothing connects until a tool is
  called, an unreachable host is an `UNREACHABLE` result that says what to do,
  and `ssh_check_connection` is the health check and the retry.
- **Six tools, not five**: `ssh_check_connection` is new.
- `ENABLED_TOOLGROUPS` does not widen anything here; see [Setup](#setup).
- **Commands have a 15-minute ceiling** beside the inactivity timeout, and every
  SFTP step a deadline. The upstream had neither.

## What has and has not been proven

The suites in `servers/ssh/shared/test/` run the real `ssh2` client against a
real SSH server on loopback (ssh2's server half, with `exec` handed to the local
`sh` and SFTP served from a temporary directory): pinned, mismatched and
fingerprint pins, a host with two key types, a rejected key, a refused port, a
handshake that never completes, a host that closes after its banner, SFTP that
never answers, the output caps, both timeouts, paging across a split character,
and every SFTP path. For a down host they prove that `initialize` and
`tools/list` open nothing and finish fast against a closed port, a silent
listener and a non-routable address, that every tool returns the `UNREACHABLE`
message, and that `ssh_check_connection` turns from `unreachable` to `ok` when
the host comes up on the same port, after which `ssh_execute` works in the same
MCP session. They also prove the classification: a silent listener and a
login that stalls after the host key are reported as up-but-stuck rather than
`UNREACHABLE`, a host that drops mid-command is a lost connection rather than a
result, and a cancelled call closes its SSH session at once. Nothing has
connected to one of the real hosts yet: the first
`ssh_check_connection` after seeding is that check.

Not tested by anything here: OpenSSH's handling of the `SIGKILL` request on
timeout (OpenSSH honours `signal` requests only in recent versions), and whether
a host firewalls SSH by source address — App Platform's egress address is not
fixed, so a host that allowlists sources will refuse this container until its
egress is on the list. See [Known limitations](/limitations/) #137.

The tailnet route is proven to the same depth and no further: the suite in
`tailnet.test.ts` runs the real `ssh2` client through a SOCKS5 proxy to the same
loopback SSH server, with the pin enforced, and covers the three tailnet
failures. A real `tailscaled` carrying a real session has not run yet
([Known limitations](/limitations/) #139).

## Logging

The server logs one thing of its own: a host-key mismatch, with the slug and
the fingerprint the host presented. It never logs a command, a path or file content (those are tool arguments and
results), and every tool error is scrubbed of any key block and of the literal
key and passphrase before it is returned.
