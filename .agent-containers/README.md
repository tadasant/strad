# `.agent-containers/` — containerized strad dev environment

An isolated, containerized strad workspace — a clone, a Node toolchain and a set
of credentials that belong to one session and collide with nothing. `ac.sh`
orchestrates several of them at once, each on its own dynamically assigned host
port.

## Do you need this?

Often not, and that is worth saying plainly. strad is a stateless Node process:
no database, no cache, no worker, no build step in dev. If you have Node 22, the
whole dev environment is

```bash
scripts/agent-dev.sh
```

which picks a free port, boots against `strad.config.dev.yaml`, and prints the
console URL. No Docker, no root, no services. That is the path an agent session
should reach for first.

Reach for this directory when you want the heavier thing it actually buys:

- **Parallelism with real separation** — N sessions, N clones, N containers, N
  ports, N dependency trees, no shared state to corrupt.
- **A toolchain you did not install** — the image carries git, `gh`, tmux,
  ripgrep, jq and Claude Code, so a machine with only Docker on it is enough.
- **A blast radius** — an agent running `--dangerously-skip-permissions` does it
  inside a container, against a clone, not against your checkout.

## Quick start

```bash
# Boot a new isolated session named "spike".
.agent-containers/ac.sh clone spike

# See its assigned host port and health.
.agent-containers/ac.sh status spike

# Open the console (dev bypass, admin).
.agent-containers/ac.sh open spike

# Attach the Claude Code tmux window (if `claude` is installed).
.agent-containers/ac.sh attach spike

# Tail the gateway log.
.agent-containers/ac.sh logs spike

# Tear it all down (removes the node_modules volume too).
.agent-containers/ac.sh destroy spike
```

`ac.sh` commands: `clone`, `status`, `open`, `attach`, `logs`, `stop`, `destroy`.
Run `.agent-containers/ac.sh` with no arguments for the full list. Sessions clone
into `~/.strad-dev-sessions/<name>` by default (override with `AC_WORKSPACE_DIR`).

## Manual setup (no `ac.sh`)

One stack against your current checkout. This is a **single shared stack**
(project `strad-dev-local`) — for several isolated instances in parallel, use
`ac.sh`, which gives each its own project and port.

```bash
cd <repo root>

# Build + start the workspace container (it runs `sleep infinity`).
# APP_PORT=0 picks a random free host port; set APP_PORT=8080 to pin it.
APP_PORT=8080 docker compose -f .agent-containers/docker-compose.dev.yml up -d --build

# One-time prepare: npm ci into the container's own node_modules volume.
docker compose -f .agent-containers/docker-compose.dev.yml exec app .agent-containers/setup.sh

# Start the gateway (backgrounded via nohup, logging to /app/.logs/app.log).
docker compose -f .agent-containers/docker-compose.dev.yml exec app .agent-containers/run.sh

# Confirm it's up.
curl -fsS http://localhost:8080/healthz && echo
```

Find the assigned port when you used `APP_PORT=0`:

```bash
docker compose -f .agent-containers/docker-compose.dev.yml port app 8080
```

Tear down — **`-v` is not optional**, or the `node_modules` volume leaks:

```bash
docker compose -f .agent-containers/docker-compose.dev.yml down -v
```

## What's in the stack

One service. `app` is a long-lived workspace container that does **not**
auto-start the gateway — `setup.sh` prepares it and `run.sh` starts the dev
server inside it, which is what lets the two be re-run independently.

There is no `db` and no `redis` here, unlike zimmer's equivalent. strad stores
nothing: the config is a file, tokens are an env var, and every server it fronts
is somebody else's process. A service with nothing to serve is dead weight in a
dev stack, so it isn't in one.

The container has no compose healthcheck, deliberately. Until `run.sh` runs there
is nothing listening, so a healthcheck would report a correctly-idle workspace as
unhealthy. `ac.sh` polls `/healthz` after `run.sh` instead — the moment the answer
starts meaning something.

## The docker socket is NOT mounted

zimmer's dev container mounts `/var/run/docker.sock` because zimmer's own code
drives Docker. strad's does not, and the mount is not free: **a container that
can reach the docker socket has root-equivalent access to the host.** It can
start a privileged sibling container that mounts `/`, which is the whole
filesystem, which is everything. That is a real cost, worth paying for a real
capability and not for a hypothetical one.

So the socket is absent here, and the image ships no Docker CLI either. If you
ever add one, add the other, and say in the same commit what it is for.

## Credentials

`~/.claude` and `~/.config/gh` are mounted from the host so an agent inside the
container is already signed in. Both are optional; the stack boots without them.

Everything the gateway itself needs is in the compose file's `environment:` block
and none of it is sensitive — a bootstrap token that opens a console onto a
gateway with one echo server in it. Real secrets never live here. In a
deployment they arrive as App Platform SECRET env vars or from the GCP parameter
store, depending on `gateway.secrets.provider`; see
[Secrets](../docs/src/content/docs/operate/secrets.md).

It is an `environment:` block rather than an `env_file:`, on purpose: strad's
`.gitignore` matches `.env.*`, so a committed `.agent-containers/.env.dev` would
be silently untracked and the stack would boot with none of it.

## Design notes

- **`node_modules` is a named volume, not part of the bind mount.** The repo is
  live-mounted at `/app`, so without that volume a `npm ci` inside the container
  would overwrite the host's tree — and on a macOS host that means Linux binaries
  landing in the checkout you also run `npm test` against. `down -v` drops it;
  `stop` keeps it.
- **The `servers/` trees are not built here.** Each supplementary MCP server tree
  has its own lockfile and its own image, and the bundle image assembles ten
  dependency trees behind one Chromium. None of that belongs in a dev workspace
  for the core; if you're working on a server, build its image.
- **The `strad-dev-` project prefix is a convention.** In zimmer it is load
  bearing — a reaper job matches on it. Nothing in strad reaps by it; it exists
  so `docker compose ls` groups these obviously.

## See also

- [`VERIFY.md`](VERIFY.md) — a playbook for confirming this actually boots.
- [Local development](../docs/src/content/docs/start/local.md) — the docs page,
  covering both this and the no-Docker path.
