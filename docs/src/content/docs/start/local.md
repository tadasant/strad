---
title: Local development
description: Two ways to run strad on your own machine — a Node process on a free port, or a containerized workspace per session. What each is for, and which one you want.
sidebar:
  order: 1
---

strad runs locally as a plain Node process. There is no database, no cache, no
background worker and no build step in development — `npm run dev` executes the
TypeScript directly under `node --watch`. That is the whole dependency list, and
it is why the fast path here is genuinely fast.

There are two supported ways to run it. They are not alternatives to be chosen
once; they answer different questions.

|                  | [The Node process](#the-node-process) | [The containerized workspace](#the-containerized-workspace) |
| ---------------- | ------------------------------------- | ----------------------------------------------------------- |
| Needs            | Node 22                               | Docker with the compose plugin                              |
| Time to a screen | seconds                               | a build, then seconds                                       |
| Isolates         | nothing                               | clone, toolchain, credentials, port                         |
| For              | "boot it and look at it"              | several sessions at once, or a machine with only Docker     |

## The Node process

```bash
scripts/agent-dev.sh
```

That picks a free port, boots against `strad.config.dev.yaml`, and prints the
console URL. It is deliberately dull: no Docker, no root, no services, nothing to
install beyond `npm ci` — which it runs for you if `node_modules` is missing.

```
[agent-dev] config:  /…/strad.config.dev.yaml
[agent-dev] url:     http://localhost:36341
[agent-dev] console: http://localhost:36341/ui?token=change-me
[agent-dev] tokens:  no system tokens — /mcp will reject every request.
```

Useful flags and overrides:

- `--background` — `nohup` the process, log to `.logs/app.log`, and return once
  `/healthz` answers. A boot **crash** is reported as a failure with the tail of
  the log, rather than as a cheerful line above a dead process.
- `PORT=8080 scripts/agent-dev.sh` — pin the port. The default asks the kernel
  for a free one, which is what lets two clones run on one box, but it means the
  URL changes every boot.
- `ADMIN_BOOTSTRAP_TOKEN`, `STRAD_INTERNAL_TOKEN`, `STRAD_CONFIG` — all
  defaulted, all overridable.

`npm run dev` remains what it always was: the same process against
`strad.config.yaml`, on 8080, with none of the above.

### The dev config

`strad.config.dev.yaml` exists because `strad.config.yaml` — the config baked
into the stock image — has **zero servers**, which is correct for a shipped
artifact and useless to look at. The dev config is the smallest one that gives
you something to point a client at:

- `auth.consoleDevBypass.enabled: true`, so the console is a screen rather than
  a 401. The bypass takes three aligned locks (see
  [Auth architecture](/auth/overview/)): this flag, `ALLOW_DEV_AUTH=true`, and
  `ADMIN_BOOTSTRAP_TOKEN`. The two dev boot paths set the other two.
- `auth.consoleTokenLogin.enabled: true`, so an agent driving the console can be
  handed a single-use login token instead of the bootstrap token. See
  [Signing in as an automated actor](#signing-in-as-an-automated-actor).
- the `echo` builtin, in-process, needing no credential and no network — so
  `tools/list` returns a real tool instead of an empty array.

It resolves no `${NAME}`, so it needs no secrets and boots offline. It is checked
by the same `npm run config:check` CI gate as every other config in the repo, and
it is deployed nowhere.

### Signing in

`http://localhost:<port>/ui?token=<ADMIN_BOOTSTRAP_TOKEN>` is the entry point: it
moves the token into an `HttpOnly` cookie and redirects to the console.
`/console?token=…` authenticates the same way but answers JSON — it is the
session endpoint, not the screen.

From there the [nav
bar](/auth/overview/#what-the-console-serves-and-how-you-get-between-the-pages)
carries the other four destinations — `/`, `/connectors`, `/playground` and
`/tokens` — so the one URL above reaches the whole console. `/connectors` says the
roster editor is off on this config, which is correct: the dev config sets no
`gateway.configStore:`.

### Signing in as an automated actor

An agent driving the console with Playwright should not hold the bootstrap token.
Mint it a single-use login token instead, and let it exchange that for a
30-minute session:

```bash
curl -s -X POST "http://localhost:$PORT/console/tokens" \
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_TOKEN"
# → {"token":"<jti>.<secret>", …}   hand the agent the token, nothing else
```

The agent posts `{"token": "…"}` to `/console/token-login` from its browser
context (`context.request.post(…)` in Playwright), which sets the
`strad_console_token` cookie, then navigates to `/ui`. The token works once, and
only within ten minutes of the mint, and the session it opens can view the
console but not reveal, write or delete a stored value. See
[Auth architecture](/auth/overview/#console-login-tokens-the-automated-actors-door).

### Calling `/mcp`

The console bypass **cannot** authenticate `/mcp`, by design. That needs a minted
system token:

```bash
npm run token:mint -- --label dev --roles admin
```

It prints the token once and a JSON record to put in `STRAD_TOKENS`. Both halves
are needed: the record so strad recognises the token, the token so you can send
it.

On a deployment with `auth.staticTokens.store: parameter-store`, the console at
`/tokens` does both steps in one — it mints and files the record, with no
redeploy. Locally there is no parameter store, so this command is the way.

## The containerized workspace

`.agent-containers/` holds a Docker Compose dev environment: one workspace
container per session, each in its own git clone, on its own dynamically assigned
host port.

```bash
.agent-containers/ac.sh clone spike     # create + boot an isolated session
.agent-containers/ac.sh status          # every session, with port and health
.agent-containers/ac.sh open spike      # the console URL
.agent-containers/ac.sh attach spike    # the Claude Code tmux window
.agent-containers/ac.sh logs spike      # tail the gateway log
.agent-containers/ac.sh destroy spike   # tear it down, volumes and clone included
```

This is the heavier path, and worth it for three things: running several sessions
with real separation, getting a full toolchain (git, `gh`, tmux, ripgrep, jq,
Claude Code) on a machine that only has Docker, and giving an agent a blast
radius that is a container and a clone rather than your checkout.

The stack is **one service**. strad stores nothing — the config is a file, tokens
are an env var, and every server it fronts is somebody else's process — so there
is no `db` and no `redis` in it, unlike the equivalent stack in zimmer that this
one is shaped after.

`.agent-containers/README.md` is the full reference and `VERIFY.md` is the
playbook for confirming it boots.

### The docker socket is not mounted

Some dev containers mount `/var/run/docker.sock` so the container can drive the
host's Docker daemon. strad's does not, and the omission is the point: **a
container that can reach the docker socket has root-equivalent access to the
host** — it can start a privileged sibling that mounts `/`. strad's own code
drives no containers, so there is no capability on the other side of that trade,
and the image ships no Docker CLI either.

If a future change needs it, add the socket and the client together, and say in
the same commit what it is for.

## What is not here

- **A production-shaped local run.** These paths run the core gateway from
  source. The supplementary MCP servers under `servers/` each have their own
  lockfile and their own image, and the bundle image assembles fourteen dependency
  trees behind one shared Chromium; none of that is built by either path. See
  [Adding a server](/servers/adding/).
- **Real secrets.** Nothing local resolves a `${NAME}`. How secrets reach a
  deployed container — App Platform SECRET env vars, or the GCP parameter store
  at runtime — is [Secrets](/operate/secrets/).
