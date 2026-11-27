# Hatchbox MCP server

strad's own server for one [Hatchbox](https://hatchbox.io) app: read the
environment the Rails app is running with (over SSH, from its puma process),
set and delete its env vars (Hatchbox API), and trigger and check deploys
(deploy webhook). A tree in the strad bundle image: each slug is its own
instance on `path: /<its own slug>`, and the conventional `/hatchbox` is a
degraded placeholder.

A port of the npm `hatchbox-mcp-server` (pulsemcp/mcp-servers,
`experimental/hatchbox`), keeping its six tool names and arguments. Written,
not vendored: its SSH path ran `ssh -o StrictHostKeyChecking=no -i <path>` with
the app name spliced into the command, and its `READONLY` / `ALLOW_DEPLOYS`
flags could leave a slug with zero tools (pulsemcp/pulsemcp#3492). The full
description is [`docs/servers/hatchbox`](../../docs/src/content/docs/servers/hatchbox.md).

## Environment

| Variable                   | Group  | Required            | What it is                                                     |
| -------------------------- | ------ | ------------------- | -------------------------------------------------------------- |
| `HATCHBOX_APP_ID`          | all    | yes, on every slug  | The app's id. It is what makes the instance                    |
| `HATCHBOX_ACCOUNT_ID`      | API    | for the API tools   | The account's id                                               |
| `HATCHBOX_API_KEY`         | API    | for the API tools   | A Hatchbox API key, sent as `Authorization: Bearer`            |
| `HATCHBOX_DEPLOY_KEY`      | deploy | for the deploy tools | The app's deploy key (the key, not the webhook URL)           |
| `HATCHBOX_SSH_HOST`        | SSH    | for the SSH tools   | The web server's address                                       |
| `HATCHBOX_SSH_PRIVATE_KEY` | SSH    | for the SSH tools   | A private key for the server's `deploy` user, as a value       |
| `HATCHBOX_SSH_HOST_KEY`    | SSH    | for the SSH tools   | The server's pinned host key (`ssh-keyscan` line or `SHA256:`) |
| `HATCHBOX_SSH_PASSPHRASE`  | SSH    | no                  | For an encrypted key                                           |
| `HATCHBOX_SSH_USERNAME`    | SSH    | no                  | Default `deploy`                                               |
| `HATCHBOX_SSH_PORT`        | SSH    | no                  | Default `22`                                                   |
| `HATCHBOX_APP_NAME`        | SSH    | no                  | Narrows the puma match when the server runs several apps       |

Every variable is read on each call from the environment the server was given.
`READONLY`, `ALLOW_DEPLOYS`, `WEB_SERVER_IP_ADDRESS` and `SSH_KEY_PATH` are
refused: a slug carrying one fails every call, naming what replaces it.

## Tools and tiers

| Tool            | Group  | Annotations          |
| --------------- | ------ | -------------------- |
| `getEnvVars`    | SSH    | read-only            |
| `getEnvVar`     | SSH    | read-only            |
| `setEnvVar`     | API    | destructive          |
| `deleteEnvVars` | API    | destructive          |
| `triggerDeploy` | deploy | destructive          |
| `checkDeploy`   | deploy | read-only            |

All six always list. A tier is a slug holding only its group's credentials,
plus a `tools:` allow list: `-ro` (SSH: `getEnvVars`, `getEnvVar`),
`-deploy` (deploy key: `triggerDeploy`, `checkDeploy`), `-rw` (everything).

## Layout

| File                     | What it owns                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| `shared/src/config.ts`   | The variables, the three groups, the refused upstream names, the degraded reason |
| `shared/src/host-key.ts` | Host-key pinning, VENDORED from `servers/ssh` (`npm run sshpin:sync`) — do not edit |
| `shared/src/ssh.ts`      | The one SSH exec: the pinned connection, the fixed command, the environ parse    |
| `shared/src/client.ts`   | The Hatchbox API and deploy webhook calls                                         |
| `shared/src/tools.ts`    | The six tools                                                                     |
| `shared/src/server.ts`   | `createMCPServer({ version, env })`, the scrub and the result cap                |

## Tests

```
npm ci && npm test
```

`shared/test/ssh.test.ts` drives the real ssh2 client against a real SSH server
on loopback that executes the command this server sends, against fake puma
processes, so the pin, `pgrep` and `/proc/<pid>/environ` all run for real.
`shared/test/server.test.ts` runs the six tools through a real MCP client against
a fake Hatchbox. Against the real Hatchbox, only the error answers to invalid
credentials have been seen (`HACKS.md` #170).
