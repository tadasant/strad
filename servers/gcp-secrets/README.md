# gcp-secrets — a secrets store whose MCP surface *cannot* read a secret

A Google Cloud Secret Manager MCP server. It lists secret **names**, **notes** and
**metadata**. It has no tool that returns a value, and — the part that matters —
**the service account it runs as could not fetch one if it had.**

```
tools:  list_managed_namespaces   list_secrets   open_secrets_manager
```

Values are added, rotated, revealed and deleted by a **human**, in strad's
SSO-gated console at `/ui/gcp-secrets`, using a **different service account that
never reaches the MCP container**.

## The posture, stated as a claim you can check

> An agent talking to `/mcp` cannot obtain a secret value from this server. Not
> because we did not write the tool — because the credential in that process
> lacks `secretmanager.versions.access`, and Google answers 403.

Three locks, in order of how much they are worth:

1. **IAM (the real one).** The MCP component's service account holds
   `roles/secretmanager.viewer` on the secrets project. That role grants
   `secrets.get`, `secrets.list`, `versions.get`, `versions.list` — and **not**
   `secretmanager.versions.access`, the only permission that returns a payload. A
   bug, a bad merge or a prompt injection that reaches for a value gets
   `403 PERMISSION_DENIED`.
2. **No code path.** `shared/src/client.ts` has one HTTP verb (`get`) and no
   value-reading method. There is nothing to call.
3. **No tool.** Nothing in `tools.ts` accepts or returns a value. CI pins the tool
   count at 3 (`servers/bundle/scripts/smoke.mjs`), so a fourth tool on a secrets
   server fails the build.

Lock 1 is the one that holds when 2 and 3 are wrong. That is the whole design.

## Why the console is a *different* service account

The console can read a value (that is what "reveal" means) and write one. So it
needs `roles/secretmanager.admin`. If that key were injected into the MCP
container, lock 1 would be gone — the process an agent talks to would be holding a
credential that CAN read secrets, and only our code would be standing between the
two.

strad's deploy layer broadcasts every SECRET env var to **every** component
(`src/deploy/appspec.ts`), so "just give core the key" would have done exactly
that. Hence `consoleEnv:` — a config scope that lands on the **core component
alone**:

```yaml
- slug: gcp-secrets
  kind: supplementary-image
  env:                                            # -> the bundle (answers /mcp)
    GCP_SECRETS_PROJECT_ID: "${GCP_SECRETS_PROJECT_ID}"
    GCP_SECRETS_NAMESPACES: "mcp-"
    GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON: "${GCP_SECRETS_VIEWER_KEY_JSON}"
  consoleEnv:                                     # -> core ONLY (serves /ui)
    GCP_SECRETS_PROJECT_ID: "${GCP_SECRETS_PROJECT_ID}"
    GCP_SECRETS_NAMESPACES: "mcp-"
    GCP_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "${GCP_SECRETS_ADMIN_KEY_JSON}"
```

`test/appspec.consoleEnv.test.ts` asserts the admin key appears on `core` and on
no other component. The console also refuses to **fall back** to the viewer key if
the admin key is missing: a console silently running as the viewer would 403, and
the tempting "fix" for that 403 is to widen the MCP server's IAM.

## Namespaces, and where the blast radius actually comes from

GCP secret ids are flat (`[A-Za-z0-9_-]{1,255}`), so a namespace is a **name
prefix** — `mcp-`. The server refuses to list an unmanaged namespace, and the
console refuses to act on a name outside one.

**But be honest about what that prefix is worth: it is a code-level guard, not an
IAM boundary.** The IAM boundary is the **GCP project**.

It is tempting to make the prefix load-bearing with an IAM condition
(`resource.name.startsWith("projects/N/secrets/mcp-")`). Do not. Google evaluates
a condition against the resource the permission is checked on, and the two
permissions this server lives or dies by are checked on the **parent project**,
not on a secret:

| operation | permission | checked on |
| --- | --- | --- |
| `list_secrets` (MCP) | `secretmanager.secrets.list` | `projects/N` |
| create (console) | `secretmanager.secrets.create` | `projects/N` |

`"projects/N"` does not start with `"projects/N/secrets/mcp-"`, so a conditional
binding is liable to deny exactly the two calls that matter — and a security
control you have not verified end to end is not a control. Conditions do work for
per-secret operations (`versions.access`, `versions.add`), so they remain useful
as **extra** hardening, but they are not the fence.

**So the fence is the project.** Put the `mcp-` secrets in a **project of their
own**, separate from the one holding strad's own `strad-<env>-*` secrets
(`STRAD_TOKENS` among them). Then the project-level bindings below *are* the blast
radius, unambiguously and without a caveat:

- the viewer SA can list and describe **every secret in that project** — and read
  the value of **none of them**, ever;
- the admin SA can do anything **in that project** — and cannot see strad's own
  secrets at all, because they are somewhere else.

`GCP_SECRETS_NAMESPACES` is still **required**. An unset one would mean the empty
prefix, so the server refuses to mount rather than defaulting to "everything".

## Notes, and why they are annotations

Every secret carries an optional free-form note, stored as the **`note`
annotation** on the Secret resource. Verified against Google's docs before
choosing:

| | annotations | labels |
| --- | --- | --- |
| purpose | "arbitrary, non-identifying metadata" | "sorting, filtering and grouping" |
| charset | unrestricted | restricted (lowercase, `-`, `_`) |
| size | all keys+values on one secret < **16 KiB** | 63 chars per value |

A note is prose, so it is an annotation. We cap one at 4 KiB so a single note can
never eat the 16 KiB budget. Written with `PATCH ?updateMask=annotations`, which
replaces the map — so clearing a note really clears it. No side database: the note
lives on the secret, moves with it, and is deleted with it.

**Agents CAN read the note.** That is the point — "which key is this, who issued
it, when does it rotate" is exactly what an agent should be able to tell you
without holding the key.

## `open_secrets_manager`

Lifted from [`reframe-secrets`](https://github.com/reframe-systems/mcp-servers)
(the same architecture over AWS SSM), whose answer to "how does an agent help with
a secret it must never see" is the right one: it returns a **deep link**.

```json
{ "url": "https://staging.strad.tadasant.com/ui/gcp-secrets?secret=mcp-openai-api-key" }
```

The agent hands the human a URL. The human signs in and does the thing. The value
never crosses the agent channel.

## Logging

No value is logged, anywhere, on any path:

- the MCP server never holds one (it cannot fetch one);
- the console's client never interpolates a value into an error — a
  `SecretManagerError` carries an HTTP status and a request path, and values
  travel in the request **body**;
- a malformed service-account key is reported by shape (`"is not valid JSON"`),
  never by content;
- a value is never put in a URL: create / rotate / reveal are all POSTs, so no
  value can reach an access log, a proxy log, a `Referer` header or a bookmark;
- strad's telemetry records shape and identity only, and calls
  `recordException()` nowhere (`src/telemetry/redact.ts`). Nothing here feeds it.

## Layout

```
servers/gcp-secrets/
  shared/src/client.ts   # read-only Secret Manager client (GET only; no :access)
  shared/src/config.ts   # env -> config; fails closed with no namespace
  shared/src/tools.ts    # the three tools
  shared/src/server.ts   # createMCPServer({ server, registerHandlers })
  shared/test/           # incl. a fake Secret Manager that enforces IAM like GCP
```

There is **no Dockerfile and no standalone image**, and that is the one deliberate
deviation from `servers/onepassword/README.md`'s layout. strad now deploys exactly
**one** supplementary image — `servers/bundle` — and PR #26 collapsed thirteen
components into two to get there. A server whose entire job is to list secret
names does not get to re-open that. It is a **tree in the bundle image** (mounted
at `/gcp-secrets`), which is what every other server in that image is too.

## Environment

| Var | Where | Required | Notes |
| --- | --- | --- | --- |
| `GCP_SECRETS_PROJECT_ID` | bundle + core | yes | The GCP project holding the secrets. |
| `GCP_SECRETS_NAMESPACES` | bundle + core | yes | CSV of managed prefixes, e.g. `mcp-`. Unset = refuse to mount. |
| `GCP_SECRETS_SERVICE_ACCOUNT_KEY_JSON` | **bundle only** | yes | The **viewer** key. No `versions.access`. |
| `GCP_SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON` | **core only** | yes | The **admin** key. Console writes and reveals. |
| `GCP_SECRETS_CONSOLE_URL` | bundle | no | Deep-link target for `open_secrets_manager`. |
| `GCP_SECRETS_API_BASE` / `_TOKEN_URL` | either | no | **Test seams.** Point at a stub Secret Manager. Not a production knob. |

## Provisioning the two service accounts

This is the part a deploy cannot do for you. Run it once, per environment, with an
operator credential.

Use a **dedicated project** for the managed secrets (see above — the project, not
the name prefix, is the real fence). It must **not** be the project that holds
strad's own `strad-<env>-*` secrets.

```bash
PROJECT=strad-secrets-staging      # a project that holds ONLY the mcp- secrets
gcloud services enable secretmanager.googleapis.com --project "$PROJECT"

# 1. The MCP container's identity: list/describe, and NOTHING that reads a value.
gcloud iam service-accounts create strad-secrets-viewer \
  --display-name "strad gcp-secrets (MCP, read-only metadata)" --project "$PROJECT"

# 2. The console's identity: add / rotate / reveal / delete, for a signed-in human.
gcloud iam service-accounts create strad-secrets-admin \
  --display-name "strad gcp-secrets (console, human writes)" --project "$PROJECT"

# roles/secretmanager.viewer grants secrets.get/list + versions.get/list, and NOT
# secretmanager.versions.access. That single omission is the whole security model.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:strad-secrets-viewer@$PROJECT.iam.gserviceaccount.com" \
  --role roles/secretmanager.viewer

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:strad-secrets-admin@$PROJECT.iam.gserviceaccount.com" \
  --role roles/secretmanager.admin
```

**Verify the split before trusting it.** This is the whole claim; check it.

```bash
gcloud secrets create mcp-canary --replication-policy=automatic --project "$PROJECT"
printf 'canary' | gcloud secrets versions add mcp-canary --data-file=- --project "$PROJECT"

gcloud iam service-accounts keys create /tmp/viewer.json \
  --iam-account "strad-secrets-viewer@$PROJECT.iam.gserviceaccount.com" --project "$PROJECT"
gcloud auth activate-service-account --key-file /tmp/viewer.json

gcloud secrets list --project "$PROJECT" --filter="name:mcp-"        # -> mcp-canary   ✅ names
gcloud secrets versions access latest --secret mcp-canary --project "$PROJECT"
#   PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied   ✅ THE PROOF
```

The viewer must hold **no other binding** that grants `versions.access` —
`roles/secretmanager.secretAccessor`, `roles/editor` and `roles/owner` all do, and
any one of them silently undoes the entire design:

```bash
gcloud projects get-iam-policy "$PROJECT" \
  --flatten="bindings[].members" \
  --filter="bindings.members:strad-secrets-viewer@$PROJECT.iam.gserviceaccount.com" \
  --format="table(bindings.role)"
# Expect exactly one row: roles/secretmanager.viewer
```

Then seed the two key files into the *strad* Secret Manager project as
`strad-<env>-GCP_SECRETS_VIEWER_KEY_JSON`, `strad-<env>-GCP_SECRETS_ADMIN_KEY_JSON`
and `strad-<env>-GCP_SECRETS_PROJECT_ID`, which is where `deploy-staging.yml` reads
them from.

## Test

```bash
cd servers/gcp-secrets && npm ci && npm test
```

Nine tests. They drive the server through a real MCP client, and the HTTP client
against a **fake Secret Manager that enforces IAM the way Google does** — so
"the credential is refused a value" is asserted by actually trying it and getting
the 403, not by trusting a comment.
