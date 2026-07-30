# secrets — a parameter store whose MCP surface *cannot* read a secret

A store-agnostic secrets MCP server. Google Cloud is the first (and, today, only)
implementation, over a **two-store model**: Parameter Manager indexes every
managed variable, and Secret Manager holds the bytes of the ones that are secret.
The name is deliberately not `gcp-secrets` — the store is an implementation
detail, and we may add others.

This tree is the MCP/agent channel. **Its surface is derived from what its
credential may actually do**, asked of Google at startup
(`projects:testIamPermissions` — see `shared/src/capabilities.ts`) rather than
declared in config. A flag can claim a capability the key does not have; a probe
cannot.

In **production** the credential is a Parameter Manager *viewer*, so the surface
is four read-only tools and — the part that matters — it **cannot read a secret
value, because the credential it runs as could not fetch one if it tried**:

```
tools:  list_managed_namespaces   list_parameters   get_parameter   open_secrets_manager
```

In **staging** the credential is read+write on a project that holds nothing
sensitive, so the same image additionally offers `create_parameter`,
`set_parameter_value`, `set_parameter_note`, `delete_parameter` and
`get_secret_value`. That is deliberate and scoped to staging: it is what makes the
store testable end to end over `/mcp` instead of only through the console.

**Fail closed.** A probe that cannot run — no credential, Cloud Resource Manager
not enabled, a network fault — yields no capabilities, and the surface is the
read-only four. Nothing is opened by a failure.

Secret values are added, rotated, revealed and deleted by a **human**, in strad's
SSO-gated console, using a **different service account that never reaches the MCP
container**. A separate runtime **resolver** assembles each server's env from these
parameters — a **third** credential, also outside this tree.

## The two-store model

A **parameter** is one managed variable, addressed by a canonical namespace path:

```
/strad/{env}/mcp/{server-slug}/{kind}/{VARIABLE_NAME}
```

`kind` is always `static` for now. Two examples for one server:

```
/strad/staging/mcp/remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL   (non-secret)
/strad/staging/mcp/remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY     (secret)
```

**Parameter Manager is the index of everything.** Each variable is one Parameter
Manager parameter, `format: "JSON"`, labelled `managed-by: strad` and
`secret: "true"|"false"`. Its latest version's payload is base64 of a JSON
**envelope**:

```json
{ "path": "<canonical path>", "secret": false, "note": "<optional>", "value": "<literal>" }
```

- For a **non-secret** parameter, `value` is the literal value. Non-secrets are
  configuration (a service-account email, a bucket name), not credentials — the
  viewer may read them, and `get_parameter` returns them.
- For a **secret** parameter, the bytes live in **Secret Manager**, and the
  envelope's `value` is a Parameter Manager reference to them:

  ```
  __REF__("//secretmanager.googleapis.com/projects/<PROJECT>/secrets/<secretId>/versions/latest")
  ```

  Parameter Manager's `:render` dereferences that ref and returns the secret. In
  **prod** this server never renders and could not — the read path is not on its
  surface and its credential could not back it. In **staging** `:render` is how
  `get_secret_value` works. Which of the two you get is decided by the probe, not
  by this paragraph.

The exact `path` is stored *inside* the envelope, so a listing never decodes an id
back into a path — it reads the envelope and filters on the path it finds there.

## The posture, stated as a claim you can check

> An agent talking to **production**'s `/mcp` cannot obtain a **secret** value from
> this server. Not because we did not write the tool — because the credential in
> that process lacks `secretmanager.versions.access`, and Google answers 403 to the
> only call that would return one. The tool is not listed there either, because the
> probe reports that the credential cannot back it; but the listing is the
> courtesy and IAM is the reason.

Three locks, in order of how much they are worth:

1. **IAM (the real one).** In prod the MCP component's service account holds
   Parameter Manager *viewer* access: it can `parameters.list` and
   `parameterVersions.get` (the envelope), and **nothing** that reads a secret's
   bytes. There are exactly **two** ways a secret value comes out, and prod's
   credential holds neither: Secret Manager's `versions.access`, and Parameter
   Manager's `:render`. Those are checked differently and it matters — `:render`
   needs `parametermanager.parameterVersions.render` on the CALLER *and*
   `secretAccessor` on the parameter's own principal, so withholding
   `versions.access` alone is not what shuts it. A bug, a bad merge or a prompt
   injection that reaches for a secret value gets `403 PERMISSION_DENIED`.
2. **No code path on the read client.** `shared/src/parameter-manager.ts` has one
   HTTP verb (`get`), no `render`, and no method that dereferences a `__REF__`.
   The `:render` call lives in `write-client.ts`, which is constructed only when
   the probe reports the capability.
3. **No tool.** `get_parameter` returns NON-secret values only; on a secret
   parameter it returns an error, not the value — on every deployment, staging
   included. The one tool that _can_ return a secret value, `get_secret_value`,
   is listed only where the probe reports a read capability — and its handler
   re-checks, because a `tools/list` a client cached a minute ago must not be
   treated as an authorization. CI's smoke test runs with no credential, so the
   probe fails closed and the count there is 4
   (`servers/bundle/scripts/smoke.mjs`).

Lock 1 is the one that holds when 2 and 3 are wrong. That is the whole design, and
it is why staging can safely be given a wider credential: nothing about prod's
posture depends on this code declining, so relaxing the code in an environment
whose IAM is relaxed changes prod not at all.

## The three credentials

| Role | Lives in | Can it read a secret value? | Access |
| --- | --- | --- | --- |
| **viewer** (this tree) | the bundle image, answers `/mcp` | **no in prod**, yes in staging | Parameter Manager viewer (prod); admin on both stores (staging) |
| **admin** (the console) | `src/**`, behind SSO, core component only | yes (that is "reveal") | Parameter Manager + Secret Manager admin |
| **resolver** (runtime) | `src/**`, assembles a server's env | yes, at boot | Parameter Manager `:render` |

Only the viewer is this tree's concern. The admin and resolver are separate
service accounts in `src/**`, and the deploy layer keeps their keys off the bundle
component — if the admin or resolver key were injected here, lock 1 would be gone.

## Namespaces, and where the blast radius actually comes from

A namespace is a **canonical-path prefix** — `/strad/staging/mcp/`. The server
refuses to list, and `get_parameter` refuses to read, outside it.

**Be honest about what that prefix is worth: it is a code-level guard, not an IAM
boundary.** The IAM boundary is the **GCP project**. `parameters.list` is checked
on the parent (`projects/N/locations/global`), whose name never starts with a
path prefix, so an IAM condition on the resource name cannot carry the namespace —
it would deny the very call that matters. Conditions work for per-resource
operations and remain useful as *extra* hardening, but they are not the fence.

**So the fence is the project.** Put the managed parameters (and the secrets they
reference) in a **project of their own**, separate from the one holding strad's own
`strad-<env>-*` secrets. Then the project-level bindings *are* the blast radius,
without a caveat: the viewer SA can list every parameter in that project and read
every non-secret one — and read the value of **no** secret in it, ever.

`SECRETS_NAMESPACES` is still **required** for THIS server. An unset one would
mean the empty prefix — every parameter in the project — so it refuses to mount
rather than defaulting to "everything".

On the CONSOLE side the same variable is a list of **suggestions**: an operator
may type any namespace in the project, because the project is the fence and a
code-level list over the same credential would only add a redeploy. The MCP half
keeps the hard scope, because an agent is not an operator.

It is a **list**, and the two halves of this server need not be given the same
one. The bundle's `env:` scopes what an AGENT can enumerate; the core's
`consoleEnv:` seeds the SUGGESTIONS on `/ui/secrets`, whose namespace field is
free text (set `SECRETS_NAMESPACES_STRICT=true` to make the list a limit again). Staging gives the console
`/strad/staging/mcp/,/strad/staging/gateway/static/` and the MCP container only
the first: a human manages the deployment's own `${NAME}` references there, and
an agent has no business listing them.

## Notes

Every parameter carries an optional free-form `note` in its envelope — "which key
is this, who issued it, when does it rotate". **Agents CAN read the note.** That is
the point: an agent should be able to tell you which secret to set, and why,
without holding the secret.

## `open_secrets_manager`

The agent's answer to "how do I help with a secret I must never see" is a **deep
link**:

```json
{ "url": "https://staging.strad.tadasant.com/ui/secrets?param=%2Fstrad%2Fstaging%2Fmcp%2F..." }
```

The agent hands the human a URL. The human signs in and does the thing. The value
never crosses the agent channel.

## Logging

No secret value is logged, anywhere, on any path: the MCP server never holds one
(it cannot fetch one); errors carry an HTTP status and a request path, and secret
bytes travel in neither; a malformed service-account key is reported by shape
(`"is not valid JSON"`), never by content; and strad's telemetry records shape and
identity only (`src/telemetry/redact.ts`).

## Layout

```
servers/secrets/
  shared/src/parameter-manager.ts  # read-only Parameter Manager client (GET only; no :render)
  shared/src/config.ts             # env -> config; fails closed with no namespace
  shared/src/tools.ts              # the four tools
  shared/src/server.ts             # createMCPServer({ server, registerHandlers })
  shared/test/                     # incl. a fake Parameter Manager that models the two-store split
```

There is **no Dockerfile and no standalone image**: strad deploys exactly one
supplementary image — `servers/bundle` — and this is a **tree in the bundle
image**, mounted like every other server there.

## Environment

| Var | Where | Required | Notes |
| --- | --- | --- | --- |
| `SECRETS_PROJECT_ID` | bundle + core | yes | The GCP project holding the parameters (and their secrets). |
| `SECRETS_NAMESPACES` | **bundle** | yes | CSV of managed path prefixes, e.g. `/strad/staging/mcp/`. A HARD scope here. Unset = refuse to mount. |
| `SECRETS_NAMESPACES` | **core** | yes | The console's namespace SUGGESTIONS. Free text unless `SECRETS_NAMESPACES_STRICT`. Unset = the console reports a misconfiguration. |
| `SECRETS_NAMESPACES_STRICT` | core | no | `true` restores the list as a hard limit on the console. Default off. |
| `SECRETS_SERVICE_ACCOUNT_KEY_JSON` | **bundle only** | yes | The **viewer** key. Parameter Manager viewer; no Secret Manager access. |
| `SECRETS_CONSOLE_URL` | bundle | no | Deep-link target for `open_secrets_manager`. |
| `SECRETS_PM_API_BASE` / `SECRETS_TOKEN_URL` | either | no | **Test seams.** Point at a stub Parameter Manager. Not a production knob. |

The admin and resolver keys are **not** listed here — they land on `src/**`
components, never on this one, and are that code's concern.

## Provisioning

Use a **dedicated project** for the managed parameters and their secrets (the
project, not the path prefix, is the real fence). Enable both APIs, then create the
viewer identity and bind it to Parameter Manager viewer **and nothing that grants
`secretmanager.versions.access`**:

```bash
PROJECT=strad-secrets-staging
# A brand-new project needs billing linked before these two managed APIs will
# enable, and creating it under an org needs --organization.
gcloud services enable parametermanager.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com --project "$PROJECT"

gcloud iam service-accounts create strad-secrets-viewer \
  --display-name "strad secrets (MCP, viewer: parameters + non-secret values)" --project "$PROJECT"

# Parameter Manager viewer: list parameters and read versions (the envelopes),
# and NOT secretmanager.versions.access. That single omission is the whole model.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:strad-secrets-viewer@$PROJECT.iam.gserviceaccount.com" \
  --role roles/parametermanager.parameterViewer

# The console's ADMIN identity (a DIFFERENT service account, never on the MCP
# container). The predefined role is roles/parametermanager.admin — there is no
# `parameterAdmin`. Pair it with roles/secretmanager.admin so it can write secret
# values too.
gcloud iam service-accounts create strad-secrets-admin \
  --display-name "strad secrets (console admin: read/write both stores)" --project "$PROJECT"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:strad-secrets-admin@$PROJECT.iam.gserviceaccount.com" \
  --role roles/parametermanager.admin
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:strad-secrets-admin@$PROJECT.iam.gserviceaccount.com" \
  --role roles/secretmanager.admin
```

## Per-environment IAM

**The grants live in one place: [`docs/operate/secrets-iam.md`](../../docs/src/content/docs/operate/secrets-iam.md).**
That page derives each permission from the actual API calls in
`src/secrets/parameters/gcp.ts` and this tree's `write-client.ts`, and carries the
`gcloud` plus an audit assertion for both halves — the prod console's
write-without-read downgrade, and staging's read+write grant for this server.

It is deliberately not duplicated here. Two copies of an IAM spec is how one of
them ends up wrong, and the wrong one gets applied.

One point from it is worth repeating, because it is the part that is easy to get
backwards: **`roles/parametermanager.admin` is NOT a safe base role for a
write-without-read console.** It includes `parametermanager.parameterVersions.render`,
and `:render` dereferences a `__REF__` as the *parameter's own* principal rather
than as the caller — so a caller holding `render` but not
`secretmanager.versions.access` still gets a secret value back, as soon as that
principal is granted `secretAccessor`. Nothing grants it today, which is the only
reason the path is shut; granting it is exactly what issue #49 proposes. The
custom role in the spec omits `render` so the boundary survives #49, and
`capabilities.ts` probes for both permissions so the reported posture stays right
either way.


## Test

```bash
cd servers/secrets && npm ci && npm test
```

They drive the server through a real MCP client, and the HTTP client against a
**fake Parameter Manager that models the two-store split** — a secret's bytes are
never in a parameter payload, only a `__REF__` — so "the viewer cannot obtain a
secret value" is asserted by actually trying and coming up empty, not by trusting a
comment.
