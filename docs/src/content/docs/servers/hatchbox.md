---
title: Hatchbox
description: strad's own Hatchbox server — a Rails app's running env vars over a pinned SSH connection, env-var writes over the Hatchbox API, and deploys over the deploy webhook, one app per slug and one tier per credential.
---

Run a [Hatchbox](https://hatchbox.io) app from an agent: read the environment
the app is actually running with, set and delete its env vars, and trigger and
follow a deploy. The server is strad's own, `servers/hatchbox`, served at
`/hatchbox` in strad's bundle image with one instance per slug.

It is a port of the npm `hatchbox-mcp-server` (pulsemcp/mcp-servers,
`experimental/hatchbox`). It keeps that package's six tool names and arguments,
so a skill written against it calls the same names here. It is WRITTEN
rather than vendored. The upstream is MIT and small, but the part that matters
most is the part strad would have had to rewrite anyway:

- it read env vars by shelling out to `ssh` with `StrictHostKeyChecking=no` and
  a key FILE path;
- it spliced `HATCHBOX_APP_NAME` into the remote command string;
- it gated its tools on `READONLY` / `ALLOW_DEPLOYS` flags, which is how a slug
  came up with zero tools and nothing said so (pulsemcp/pulsemcp#3492).

What is left after replacing those three is a handful of HTTP calls.

## Tools

| Tool            | Credential  | What it does                                                                                       |
| --------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `getEnvVars`    | SSH         | Every env var of the RUNNING app, from its puma process. `names_only: true` returns names, no values |
| `getEnvVar`     | SSH         | One env var of the running app, by `name`                                                          |
| `setEnvVar`     | API key     | Add or update one env var (`name`, `value`). Takes effect on the next deploy                       |
| `deleteEnvVars` | API key     | Delete up to 50 env vars (`names`). Takes effect on the next deploy                                |
| `triggerDeploy` | deploy key  | Deploy the branch's latest commit, or `sha`. Returns the activity id                               |
| `checkDeploy`   | deploy key  | One deploy's status and output, by `activityId`. Long output keeps its last 20,000 characters      |

`getEnvVars`, `getEnvVar` and `checkDeploy` are `readOnlyHint: true`.
`setEnvVar`, `deleteEnvVars` and `triggerDeploy` are `destructiveHint: true`.

**The reads return production secrets.** Hatchbox's API never returns an env
var's value, so the reads take them from the process that uses them, over SSH.
`DATABASE_URL`, `SECRET_KEY_BASE` and `RAILS_MASTER_KEY` come back in the
result, and the `-ro` tier is the most sensitive one to hand out.

**Writes are not live until a deploy.** A value set with `setEnvVar` does not
show up in `getEnvVar` until the next deploy restarts puma. The results say
so.

## Tiers are credentials, and the gateway's policy

All six tools always list, on every slug, whatever is configured. Which ones a
slug can use is decided in two places:

1. **The credentials the slug holds.** Each of Hatchbox's three credentials
   reaches exactly one group of tools, and each group is configured on its own.
   A slug without the API key cannot write an env var, whatever its policy
   says, because the key is not in its environment. A tool whose credential is
   absent fails on call, naming the variables it needs.
2. **The slug's `tools:` allow list**, enforced by the gateway on `tools/list`
   and `tools/call`. This keeps a slug's listing to what it can actually do.

There is no `READONLY` or `ALLOW_DEPLOYS`. A slug that sets either, or upstream's
`WEB_SERVER_IP_ADDRESS` or `SSH_KEY_PATH`, refuses every call and reports
`degraded` on `/healthz` until the variable is removed. The error names what
replaces it. A config carried over with `READONLY=true` would otherwise look
narrowed and not be.

So an empty `tools/list` cannot happen here: the list is six tools, always,
and the smoke check fails the image if it is not. A slug with no credential
group configured at all reports `degraded`, naming every missing variable.

The three tiers a deployment usually wants, for one app:

| Slug                 | Holds                        | `tools: allow`                     |
| -------------------- | ---------------------------- | ---------------------------------- |
| `hatchbox-<app>-ro`  | the SSH key and the host pin | `getEnvVars`, `getEnvVar`          |
| `hatchbox-<app>-deploy` | the deploy key            | `triggerDeploy`, `checkDeploy`     |
| `hatchbox-<app>-rw`  | all three credentials        | none: all six                      |

`checkDeploy` takes the deploy key, which alone can also deploy. That is why it
sits in the deploy tier rather than in `-ro`.

## Configuring a slug

| Variable                   | Group   | What it is                                                                                               |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `HATCHBOX_APP_ID`          | all     | The app's id, in the app's URL in Hatchbox. Required on every slug: it is what makes the instance |
| `HATCHBOX_ACCOUNT_ID`      | API     | The account id, in the account's URL in Hatchbox                                                                         |
| `HATCHBOX_API_KEY`         | API     | An API key from the account settings, sent as `Authorization: Bearer`                                   |
| `HATCHBOX_DEPLOY_KEY`      | deploy  | The deploy key, shown in the URL on the app's Repository tab. The key, not the whole URL              |
| `HATCHBOX_SSH_HOST`        | SSH     | The web server's address                                                                                 |
| `HATCHBOX_SSH_PRIVATE_KEY` | SSH     | A private key (OpenSSH or PEM) whose public half is on the server's `deploy` user                        |
| `HATCHBOX_SSH_HOST_KEY`    | SSH     | The server's host key: a line from `ssh-keyscan <host>`, a bare key, or a `SHA256:` fingerprint          |
| `HATCHBOX_SSH_PASSPHRASE`  | SSH     | Optional, for an encrypted key                                                                           |
| `HATCHBOX_SSH_USERNAME`    | SSH     | Optional, default `deploy`                                                                               |
| `HATCHBOX_SSH_PORT`        | SSH     | Optional, default `22`                                                                                   |
| `HATCHBOX_APP_NAME`        | SSH     | Optional. The app's name as Hatchbox shows it, when the server runs more than one app                    |

Each slug is its own instance on `path: /<its own slug>`, discovered from its
own `<SLUG>__HATCHBOX_APP_ID`. A per-slug instance reads EVERY hatchbox
variable under its own slug's name or not at all, so a `-ro` beside a `-rw` on
one bundle never inherits the `-rw`'s bare API key. The conventional
`/hatchbox` mount is the degraded placeholder once any slug exists.

```yaml
- slug: hatchbox-myapp-ro
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /hatchbox-myapp-ro
  env:
    HATCHBOX_APP_ID: "8540"
    HATCHBOX_SSH_HOST: 203.0.113.7
    HATCHBOX_SSH_PRIVATE_KEY: "${HATCHBOX_SSH_PRIVATE_KEY}"
    HATCHBOX_SSH_HOST_KEY: "ssh-ed25519 AAAA…"
    HATCHBOX_APP_NAME: myapp
  tools:
    allow: [getEnvVars, getEnvVar]

- slug: hatchbox-myapp-deploy
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /hatchbox-myapp-deploy
  env:
    HATCHBOX_APP_ID: "8540"
    HATCHBOX_DEPLOY_KEY: "${HATCHBOX_DEPLOY_KEY}"
  tools:
    allow: [triggerDeploy, checkDeploy]

- slug: hatchbox-myapp-rw
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /hatchbox-myapp-rw
  env:
    HATCHBOX_APP_ID: "8540"
    HATCHBOX_ACCOUNT_ID: "1852"
    HATCHBOX_API_KEY: "${HATCHBOX_API_KEY}"
    HATCHBOX_DEPLOY_KEY: "${HATCHBOX_DEPLOY_KEY}"
    HATCHBOX_SSH_HOST: 203.0.113.7
    HATCHBOX_SSH_PRIVATE_KEY: "${HATCHBOX_SSH_PRIVATE_KEY}"
    HATCHBOX_SSH_HOST_KEY: "ssh-ed25519 AAAA…"
    HATCHBOX_APP_NAME: myapp
```

Under `gcp-parameter-store`, each `${…}` is a parameter in that slug's own
namespace, seeded through the console like any other secret.

## The SSH read

This is the same key model as strad's [SSH server](/servers/ssh/): the key is a
value from the store, held in this process, and the host key is PINNED. There
is no first use to trust. A server presenting any other key is refused before
the private key signs anything, so the key is never offered to an impostor and
no env var is read off one. The pin parsing is shared with the ssh server (the
`sshpin` vendored seam), so one pasted line means the same thing to both.

Each read is one connection and one command, closed after:

```sh
pid=$(pgrep -o -f '[p]uma.*myapp'); if [ -z "$pid" ]; then exit 3; fi; printf '%s\n' "$pid"; cat "/proc/$pid/environ"
```

- The oldest matching process is the puma master. Its workers fork from it with
  the same environment.
- `[p]uma` matches puma and not the shell running the command, whose own
  command line contains the pattern. Upstream's `puma.*app` could match that
  shell.
- `HATCHBOX_APP_NAME` is the only variable part. It is held to letters, digits,
  `.`, `-` and `_`, escaped for the regex, and single-quoted. Nothing a caller
  sends reaches the command.
- Output is capped at 1 MiB as it arrives. A connection is given 15 seconds and
  the whole read 45.

Getting the pin: run `ssh-keyscan <host>` from somewhere you trust, then
compare it against the fingerprint Hatchbox or the server's console shows.
Paste every line; any one matching is enough.

## The HTTP calls

| Tool            | Request                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `setEnvVar`     | `PUT /api/v1/accounts/{account}/apps/{app}/env_vars`, `{"env_vars":[{name,value}]}` |
| `deleteEnvVars` | `DELETE` the same path, `{"env_vars":[names]}`                             |
| `triggerDeploy` | `POST /webhooks/deployments/{deploy key}?latest=true` or `?sha=`           |
| `checkDeploy`   | `GET /apps/{deploy key}/activities/{id}`                                   |

Every call goes to `https://hatchbox.io` and nowhere else. A redirect is
reported as an error, not followed. Upstream called `app.hatchbox.io`, which
answers every GET with a 301 to `hatchbox.io`, so its `checkDeploy` worked only
by following that redirect. A result over 60,000 characters is cut and says
so. Every credential the slug holds is scrubbed from every result and error,
including from the app's own environment.

## What has met the real Hatchbox

Every test runs against fakes: a fake Hatchbox for the HTTP calls, and a real
SSH server on loopback for the reads, which runs the command against fake puma
processes. Against the real Hatchbox, the four routes have been probed with
invalid credentials. The env-var routes answer `401`, an unknown deploy key
answers `404 {"message":"App not found"}`, and an unknown activity answers
`404 {"error":"App not found"}`. Unknown routes answer differently, so all four
routes exist. No success shape has been observed. See
[limitations](/limitations/#170-hatchbox-is-strads-own-server-and-has-met-hatchbox-only-at-its-errors)
and `HACKS.md` #170.
