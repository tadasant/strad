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

  Parameter Manager's `:render` would dereference that ref and return the secret.
  **This viewer never renders**, and could not: its credential lacks
  `secretmanager.versions.access`, so the deref is a 403.

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

1. **IAM (the real one).** The MCP component's service account holds Parameter
   Manager *viewer* access: it can `parameters.list` and `parameterVersions.get`
   (the envelope), and **nothing** that reads a secret's bytes. A secret's value
   only comes out of Secret Manager's `versions.access` or Parameter Manager's
   `:render`, and both check `secretmanager.versions.access` — which this
   credential does not hold. A bug, a bad merge or a prompt injection that reaches
   for a secret value gets `403 PERMISSION_DENIED`.
2. **No code path.** `shared/src/parameter-manager.ts` has one HTTP verb (`get`),
   no `render`, and no method that dereferences a `__REF__`. There is nothing to
   call.
3. **No tool.** `get_parameter` returns NON-secret values only; on a secret
   parameter it returns an error, not the value. The one tool that _can_ return a
   secret value, `get_secret_value`, is listed only where the probe reports
   `secretmanager.versions.access` — and its handler re-checks, because a
   `tools/list` a client cached a minute ago must not be treated as an
   authorization. CI's smoke test runs with no credential, so the probe fails
   closed and the count there is 4 (`servers/bundle/scripts/smoke.mjs`).

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

`SECRETS_NAMESPACES` is still **required**. An unset one would mean the empty
prefix — every parameter in the project — so the server refuses to mount rather
than defaulting to "everything".

It is a **list**, and the two halves of this server need not be given the same
one. The bundle's `env:` scopes what an AGENT can enumerate; the core's
`consoleEnv:` scopes what a HUMAN can address on `/ui/secrets`, which offers a
picker over every entry. Staging gives the console
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
| `SECRETS_NAMESPACES` | bundle + core | yes | CSV of managed path prefixes, e.g. `/strad/staging/mcp/`. Unset = refuse to mount. |
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

## Per-environment IAM: what each identity may do, and how to grant it

Two surfaces derive their behaviour from these grants rather than from a config
flag, so getting them right is what makes the model real:

- the **console** offers reveal only if `SECRETS_REVEAL_ENABLED` is on **and** its
  service account holds `secretmanager.versions.access` (`src/ui/reveal.ts`);
- the **MCP server** derives its tool surface from
  `projects:testIamPermissions` on its own credential
  (`servers/secrets/shared/src/capabilities.ts`).

Both fail closed. A permission that is absent produces a narrower surface, never
an error at call time.

### The target state

| Identity | Project | Read secret values | Write | Effect |
| --- | --- | --- | --- | --- |
| MCP (`strad-secrets-viewer`) | **prod** | ❌ | ❌ | four read-only tools; `/mcp` cannot read a secret value |
| MCP (`strad-secrets-viewer`) | **staging** | ✅ | ✅ | read + write tools; the store is testable end to end |
| console (`strad-secrets-admin`) | **prod** | ❌ | ✅ | add and rotate, never display |
| console (`strad-secrets-admin`) | **staging** | ✅ | ✅ | reveal works |

`cloudresourcemanager.googleapis.com` must be enabled in **both** projects or the
probe cannot run and every surface degrades to read-only:

```bash
gcloud services enable cloudresourcemanager.googleapis.com --project "$PROJECT"
```

### 1. Prod console: write **without** read

The console still has to add and rotate secrets; it must never be able to display
one. `roles/secretmanager.admin` grants `versions.access`, so it has to go, and
the pieces have to be added back individually.

`roles/secretmanager.secretVersionAdder` is the right predefined role for the
write half — it grants `secretmanager.versions.add` and nothing that reads. It
does **not** grant `secretmanager.secrets.create`, which a first-time create also
needs, so pair it with `roles/secretmanager.secretCreator`.

`roles/parametermanager.admin` is safe to keep: it grants
`parametermanager.*` only. It does **not** independently open a read path to
secret bytes — a `:render` that dereferences a `__REF__` is authorized against
**Secret Manager**, so a caller without `secretmanager.versions.access` is refused
by Secret Manager no matter what Parameter Manager allows. That is the same
mechanism the viewer split has always relied on.

```bash
PROJECT=strad-secrets-prod
SA="serviceAccount:strad-secrets-admin@$PROJECT.iam.gserviceaccount.com"

# Remove the role that grants versions.access.
gcloud projects remove-iam-policy-binding "$PROJECT" \
  --member "$SA" --role roles/secretmanager.admin

# Add back only the write halves.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "$SA" --role roles/secretmanager.secretCreator
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "$SA" --role roles/secretmanager.secretVersionAdder

# Parameter Manager admin stays: it is the index, and it reads no secret bytes.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "$SA" --role roles/parametermanager.admin
```

**Audit assertion.** Deleting a secret also needs `secretmanager.secrets.delete`,
which none of the roles above grant — so after this change the console can add and
rotate but not delete a *secret* parameter's underlying secret. That is the
intended trade; add `roles/secretmanager.secretVersionManager` only if deleting
matters more than the smaller blast radius.

```bash
gcloud projects get-iam-policy "$PROJECT" \
  --flatten="bindings[].members" \
  --filter="bindings.members:strad-secrets-admin@$PROJECT.iam.gserviceaccount.com" \
  --format="value(bindings.role)" | sort
# EXPECT exactly:
#   roles/parametermanager.admin
#   roles/secretmanager.secretCreator
#   roles/secretmanager.secretVersionAdder
# and NOT roles/secretmanager.admin, roles/secretmanager.secretAccessor,
# roles/editor or roles/owner — each of those grants versions.access.

# The proof, run as the admin SA:
gcloud auth activate-service-account --key-file /tmp/prod-admin.json
gcloud secrets versions access latest --secret "$SOME_ID" --project "$PROJECT"
# EXPECT: PERMISSION_DENIED secretmanager.versions.access   ← the boundary
gcloud secrets versions add "$SOME_ID" --data-file=- --project "$PROJECT" <<< "x"
# EXPECT: success                                            ← writes still work
```

The console reports this state on the page: with the flag off and the credential
still able to read, it says so and calls it drift; once the downgrade lands, it
says reveal is off **and** impossible. If you see "not yet a boundary" after
running the above, a broader binding is still in place.

### 2. Staging MCP: read **and** write

`strad-secrets-staging` holds nothing sensitive, and the point is to exercise the
store through `/mcp` rather than only through the console.

```bash
PROJECT=strad-secrets-staging
SA="serviceAccount:strad-secrets-viewer@$PROJECT.iam.gserviceaccount.com"

# Replace the viewer-only binding with admin on both stores.
gcloud projects remove-iam-policy-binding "$PROJECT" \
  --member "$SA" --role roles/parametermanager.parameterViewer
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "$SA" --role roles/parametermanager.admin
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "$SA" --role roles/secretmanager.admin
```

**Audit assertion.** The probe is the assertion — it is what the server will act
on:

```bash
gcloud auth activate-service-account --key-file /tmp/staging-viewer.json
gcloud projects test-iam-permissions "$PROJECT" \
  --permissions=secretmanager.versions.access,secretmanager.versions.add,secretmanager.secrets.create,parametermanager.parameters.create,parametermanager.parameterVersions.create,parametermanager.parameters.delete
# EXPECT all six. `/mcp?servers=secrets` then lists the write tools;
# `list_managed_namespaces` reports what it can do.
```

**This must not be run against prod.** The prod viewer key staying read-only is
the property that makes "an agent cannot read a secret value" true, and it is
enforced by that project's IAM alone.

**Verify the split before trusting it.** Create a secret and a secret parameter
that references it, then confirm the viewer can read the parameter's envelope but
is denied the `:render` that would dereference the secret:

```bash
gcloud auth activate-service-account --key-file /tmp/viewer.json
# parameterVersions.get    -> the envelope, with __REF__ but no bytes            ✅
# parameterVersions.render -> PERMISSION_DENIED secretmanager.versions.access    ✅ THE PROOF
```

The viewer must hold **no other binding** that grants `versions.access`
(`roles/secretmanager.secretAccessor`, `roles/editor`, `roles/owner` all do). Then
seed ONLY the two SA keys into the *strad* Secret Manager project (the one the
deploy reads, where `SLACK_BOT_TOKEN` and friends live — NOT this params project)
as `strad-<env>-SECRETS_VIEWER_KEY_JSON` and `strad-<env>-SECRETS_ADMIN_KEY_JSON`.
The project id and namespace are non-secret config LITERALS in
`infra/strad.<env>.yaml` (like the `gcs` server's `GCS_PROJECT_ID`) — they are not
seeded anywhere.

## Test

```bash
cd servers/secrets && npm ci && npm test
```

They drive the server through a real MCP client, and the HTTP client against a
**fake Parameter Manager that models the two-store split** — a secret's bytes are
never in a parameter payload, only a `__REF__` — so "the viewer cannot obtain a
secret value" is asserted by actually trying and coming up empty, not by trusting a
comment.
