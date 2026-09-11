# Verifying the dev environment

A playbook for confirming both dev paths actually boot a working strad. Section 1
needs nothing but Node 22; sections 2 and 3 need Docker with the compose plugin.

## 1. The no-Docker path (`scripts/agent-dev.sh`)

```bash
# a. Boot in the background; it prints its port and polls /healthz itself.
scripts/agent-dev.sh --background

# b. Pin the port instead, when you want a stable URL.
PORT=8080 scripts/agent-dev.sh --background

# c. The gateway is serving, and echo is mounted and healthy.
curl -s http://localhost:8080/healthz

# d. The console bypass lets you in and reports the admin role.
curl -s "http://localhost:8080/console?token=change-me"

# e. The console UI renders (302 → cookie → the Servers page).
curl -sL -c /tmp/strad-ck "http://localhost:8080/ui?token=change-me" | grep -o '<title>[^<]*</title>'

# f. A single-use login token opens the console without the bootstrap token.
TOKEN=$(curl -s -X POST http://localhost:8080/console/tokens \
  -H "Authorization: Bearer change-me" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -c /tmp/strad-tk -X POST http://localhost:8080/console/token-login \
  -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}"
curl -s -b /tmp/strad-tk http://localhost:8080/ui | grep -o '<title>[^<]*</title>'
curl -s -X POST http://localhost:8080/console/token-login \
  -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}"
```

Expected results:

- (c) `"ok":true`, `"servers":["echo"]`, and a `toolSurfaces` entry showing
  `"slug":"echo","state":"ok","tools":2`.
- (d) `"via":"dev-bypass"` and `"roles":["admin"]`.
- (e) `<title>Servers · strad</title>`.
- (f) `"ok":true` from the exchange, `<title>Servers · strad</title>` with its
  cookie, and `{"error":"token_consumed",…}` from the second exchange — the token
  works once.

`/mcp` is deliberately NOT callable here: it needs a minted system token, and the
console bypass cannot stand in for one. To exercise it, mint one and re-boot:

```bash
npm run token:mint -- --label dev --roles admin   # prints the token and a record
STRAD_TOKENS='[<the record>]' scripts/agent-dev.sh
```

## 2. The containerized path (compose, directly)

```bash
# a. The compose file parses and resolves (no daemon needed for this one).
docker compose -f .agent-containers/docker-compose.dev.yml config >/dev/null && echo OK

# b. Build + start the workspace, pinning the host port so the checks copy-paste.
APP_PORT=8080 docker compose -f .agent-containers/docker-compose.dev.yml up -d --build

# c. The container is up and idle (it runs `sleep infinity` by design).
docker compose -f .agent-containers/docker-compose.dev.yml ps

# d. One-time prepare: npm ci into the container's own node_modules volume.
docker compose -f .agent-containers/docker-compose.dev.yml exec app .agent-containers/setup.sh

# e. node_modules came from the VOLUME, not the host bind mount — the container
#    sees a tree even if the host checkout has none.
docker compose -f .agent-containers/docker-compose.dev.yml exec app \
  sh -c 'ls node_modules | wc -l'

# f. Start the gateway, then confirm it answers.
docker compose -f .agent-containers/docker-compose.dev.yml exec app .agent-containers/run.sh
curl -s http://localhost:8080/healthz

# g. run.sh is idempotent — a second call is a no-op, not an EADDRINUSE crash.
docker compose -f .agent-containers/docker-compose.dev.yml exec app .agent-containers/run.sh

# h. The socket is NOT in the container (see README.md — this is the point).
docker compose -f .agent-containers/docker-compose.dev.yml exec app \
  sh -c 'test -S /var/run/docker.sock && echo PRESENT || echo absent'
```

Expected results:

- (c) `app` shows `running`.
- (e) a non-zero count.
- (f) the same `"ok":true` / `"servers":["echo"]` body as section 1.
- (g) prints `strad already serving on :8080 — nothing to do.`
- (h) `absent`.

## 3. `ac.sh` checks (parallel isolation)

```bash
.agent-containers/ac.sh clone verify-a      # boots an isolated stack + tmux/agent
.agent-containers/ac.sh clone verify-b      # a second one, concurrently
.agent-containers/ac.sh status              # lists both with port + health
.agent-containers/ac.sh open verify-a       # the console URL
.agent-containers/ac.sh destroy verify-a
.agent-containers/ac.sh destroy verify-b
```

Expected: `status` shows both sessions `running` with health `ok`, on **different**
host ports; `destroy` removes the container, the `node_modules` volume, and the
clone directory.

## 4. Teardown

```bash
docker compose -f .agent-containers/docker-compose.dev.yml down -v
docker volume ls | grep strad-dev-local_node_modules || echo "volume removed"
```
