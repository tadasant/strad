---
title: Secrets IAM
description: The exact grants behind strad's secrets surfaces, and the gcloud to apply them.
---

strad's secrets surfaces are governed by **two independent layers**, and neither
substitutes for the other:

- A **feature flag** decides what a surface _offers_. `SECRETS_REVEAL_ENABLED`
  turns the console's reveal control on; absent means off. It is convenience and
  clarity — a deployment that has decided not to display production secrets in a
  browser should not render a button that does.
- A **service-account grant** decides what is _possible_. A flag is a UI decision
  and a reader can talk themselves past it. An IAM permission that does not exist
  cannot be talked past.

Where the two disagree, strad fails closed and says which way they disagree,
because the two directions call for opposite fixes. See
[the console's reveal posture](/operate/secrets/#reveal) for what the page shows.

This page is the second layer: the exact permission each operation needs, the
`gcloud` to apply it, and an assertion to prove it landed. It requires project
IAM admin on the two secrets projects, which no strad process holds — these are
human commands.

## What each operation actually calls

Derived from `src/secrets/parameters/gcp.ts`, not from the role names. This is the
table the grants below are built from.

| Console operation     | API calls                                                                    | Permissions required                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(namespace)`     | PM `parameters.list`, `…/versions` list, `…/versions/{v}` GET                | `parametermanager.parameters.list`, `parametermanager.parameterVersions.list`, `parametermanager.parameterVersions.access`                      |
| `create` — non-secret | PM parameter POST, PM version POST                                           | `parametermanager.parameters.create`, `parametermanager.parameterVersions.create`                                                               |
| `create` — secret     | SM `secrets` POST, SM `:addVersion`, then the two PM POSTs                   | + `secretmanager.secrets.create`, `secretmanager.versions.add`                                                                                  |
| `rotate` — non-secret | PM version GET + POST                                                        | as create, non-secret                                                                                                                           |
| `rotate` — secret     | PM versions list + version GET, SM `:addVersion`                             | `parametermanager.parameterVersions.list`, `…access`, `secretmanager.versions.add`                                                              |
| `setNote`             | PM version GET + POST                                                        | as create, non-secret                                                                                                                           |
| **`reveal` — secret** | PM version GET, then **SM `versions/latest:access`**                         | **`secretmanager.versions.access`** ← the one prod must not hold, on top of the PM reads                                                        |
| `reveal` — non-secret | PM version GET only                                                          | `parametermanager.parameterVersions.access`                                                                                                     |
| `destroy`             | PM parameter GET, versions list + DELETE, parameter DELETE, SM secret DELETE | `parametermanager.parameters.get`, `…parameters.delete`, `…parameterVersions.list`, `…parameterVersions.delete`, `secretmanager.secrets.delete` |

Two things fall out of this table, and both matter:

Every row also needs the `list` row's Parameter Manager reads, which the console
performs before any mutation; they are not repeated per row. The custom roles
below grant a few permissions no current code path calls (`secrets.list`,
`versions.list`, `parameters.update`) — deliberately, so a future version of the
console does not need an IAM change to enumerate or relabel what it already owns.

**Reveal is the only operation that needs `secretmanager.versions.access`.**
Everything else the console does — create, rotate, note, delete, list — works
without it. So write-without-read is achievable: the console keeps managing
secrets and loses the ability to display one.

**`parameterVersions.access` is safe to keep.** It reads the parameter's raw
envelope, and for a secret parameter that envelope holds a `__REF__` pointer, not
a value. Listing keeps working; nothing in it dereferences.

:::caution[The second read path, and why it is not open today]
Parameter Manager's `:render` verb dereferences a `__REF__` into the secret's
value. It does **not** run as the caller — it derefs as the _parameter's own_
principal — so a caller without `secretmanager.versions.access` could still get a
secret value back from `:render` **if that principal had been granted
`secretAccessor`**.

strad never makes that grant, which is why no such path exists right now — and it
is also exactly what [issue #49](https://github.com/tadasant/strad/issues/49)
proposes to fix. **The day #49 lands, withholding `versions.access` alone stops
being sufficient**, and the console SA must additionally be denied
`parametermanager.parameterVersions.render`. The custom role below already omits
`render` for this reason, so applying it now is future-proof; `roles/parametermanager.admin`
includes `render` and is therefore not a safe base role for a write-without-read
console.

`src/secrets/parameters/capabilities.ts` probes for `render` as well as
`versions.access` and treats either as "can read a secret value", so the console's
own reporting stays honest whichever path is open.
:::

## 1. Prod console: write, but never read

**Goal.** `strad-secrets-admin@strad-secrets-prod.iam.gserviceaccount.com` can
add, rotate, note and delete secrets, and cannot read one back.

**Bonus, and it is a real one.** This service account's key
(`SECRETS_ADMIN_KEY_JSON`) is among the credentials exposed in
`tadasant-internal#215`, and rotating it has been
deliberately deferred. Downgrading the account **shrinks the blast radius of the
un-rotated key**: an attacker holding it could no longer read prod secret values,
only write them. That does not make the key safe and it is not a substitute for
rotation — a write-capable credential is still a serious one — but it converts
"can exfiltrate every production secret" into "can corrupt them", which is both
less bad and far more visible. Treat this change as a partial mitigation of an
accepted risk, not only as a feature.

No predefined role gives Secret Manager create + delete + add-version _without_
`versions.access`, so this needs two custom roles.

```bash
PROJECT=strad-secrets-prod
SA=strad-secrets-admin@${PROJECT}.iam.gserviceaccount.com

# --- Secret Manager: create, delete, add versions. NOT versions.access. -------
cat > /tmp/strad-console-sm.yaml <<'YAML'
title: strad secrets console (Secret Manager, write-only)
description: Create/delete secrets and add versions. Deliberately excludes secretmanager.versions.access.
stage: GA
includedPermissions:
  - secretmanager.secrets.create
  - secretmanager.secrets.delete
  - secretmanager.secrets.get
  - secretmanager.secrets.list
  - secretmanager.versions.add
  - secretmanager.versions.list
YAML
gcloud iam roles create stradSecretsConsoleSm \
  --project="${PROJECT}" --file=/tmp/strad-console-sm.yaml

# --- Parameter Manager: full management. NOT parameterVersions.render. --------
cat > /tmp/strad-console-pm.yaml <<'YAML'
title: strad secrets console (Parameter Manager)
description: Manage parameters and read raw envelopes. Deliberately excludes parametermanager.parameterVersions.render.
stage: GA
includedPermissions:
  - parametermanager.parameters.create
  - parametermanager.parameters.delete
  - parametermanager.parameters.get
  - parametermanager.parameters.list
  - parametermanager.parameters.update
  - parametermanager.parameterVersions.access
  - parametermanager.parameterVersions.create
  - parametermanager.parameterVersions.delete
  - parametermanager.parameterVersions.list
  - parametermanager.parameterVersions.update
YAML
gcloud iam roles create stradSecretsConsolePm \
  --project="${PROJECT}" --file=/tmp/strad-console-pm.yaml

# --- Swap the broad roles for the narrow ones --------------------------------
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" \
  --role="projects/${PROJECT}/roles/stradSecretsConsoleSm"
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" \
  --role="projects/${PROJECT}/roles/stradSecretsConsolePm"

gcloud projects remove-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.admin"
gcloud projects remove-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" --role="roles/parametermanager.admin"

# The probe needs this API enabled, in both projects. Without it the console
# reports "capability unverified" and withholds reveal, which is safe but opaque.
gcloud services enable cloudresourcemanager.googleapis.com --project="${PROJECT}"
```

**Audit assertion.** Run as the service account itself; the second block is the
one that matters.

```bash
gcloud auth activate-service-account --key-file=/path/to/prod-console-key.json

# MUST be empty — no read path, by either route.
gcloud projects test-iam-permissions "${PROJECT}" \
  --permissions=secretmanager.versions.access,parametermanager.parameterVersions.render \
  --format='value(permissions)'

# MUST list all four — the console still manages secrets.
gcloud projects test-iam-permissions "${PROJECT}" \
  --permissions=secretmanager.secrets.create,secretmanager.versions.add,parametermanager.parameters.create,parametermanager.parameters.delete \
  --format='value(permissions)'
```

The first command printing nothing is the whole point of this section. strad's own
console reports the same fact on the page, from the same probe.

## 2. Staging MCP server: read and write

**Goal.** The `secrets` MCP server on staging can read secret values _and_ write
parameters, so the store can be exercised end to end through the agent surface
rather than only through the console.

**This is scoped to staging on purpose.** `strad-secrets-staging` holds nothing
sensitive. In **prod** the MCP credential stays the Parameter Manager viewer with
no `secretmanager.versions.access`, so the property from
`tadasant-internal#202` — the `/mcp` channel cannot
read a secret value — is unchanged there. That property is load-bearing and this
does not weaken it.

```bash
PROJECT=strad-secrets-staging
SA=strad-secrets-viewer@${PROJECT}.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.admin"
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" --role="roles/parametermanager.admin"

gcloud services enable cloudresourcemanager.googleapis.com --project="${PROJECT}"
```

**Audit assertion.** All six must be listed; the MCP server's tool surface is
derived from exactly this answer.

```bash
gcloud auth activate-service-account --key-file=/path/to/staging-viewer-key.json
gcloud projects test-iam-permissions "${PROJECT}" \
  --permissions=secretmanager.versions.access,secretmanager.versions.add,secretmanager.secrets.create,secretmanager.secrets.delete,parametermanager.parameters.create,parametermanager.parameterVersions.create \
  --format='value(permissions)'
```

There is no flag to set for this. The server probes at startup and lists the tools
the credential supports — `get_secret_value`, `create_parameter`,
`set_parameter_value`, `set_parameter_note`, `delete_parameter` — so the grant
above _is_ the configuration. Revoke it and the tools disappear on the next boot.

## Why a probe and not a flag, for the MCP surface

A static flag can disagree with reality, and both directions are bad: claiming
write on a read-only key advertises a tool that 403s on every call, and claiming
read-only on a key that can read is a security property that exists in prose. The
probe asks the authority that will answer the real call, so the surface cannot
drift from the grant.

It fails closed. If `cloudresourcemanager.googleapis.com` is not enabled, or the
probe is refused, or it times out, the server reports no capabilities and serves
the four read-only tools.

Two honest limits on "cannot drift". `projects:testIamPermissions` answers at
**project** level, so a grant bound to an individual secret or parameter reads as
absent — the surface narrows, which is the safe direction, but the audit assertion
below would then be proving the wrong thing. And a **conditional** binding can be
reported as held when its condition would not be met at call time, which widens
the surface relative to reality; the call still fails at Google, but as a 403
rather than a missing tool. Grant at project level, unconditionally, and both go
away. `list_managed_namespaces` carries the reason, so an
agent can tell a human why an expected tool is missing instead of guessing.

## Ordering

The code ships first and the grants follow, in either order, because every state
in between is safe:

1. **Now (prod, flag off, SA still admin).** Reveal is hidden and the POST is
   refused. The console reports this as **drift** — the UI decision holds, the
   boundary does not — and names the fix. The un-rotated key from #215 is still
   read-capable until step 2.
2. **After the prod downgrade.** Reveal is off by configuration _and_ impossible
   by IAM. The console says so. Create, rotate, note and delete keep working; a
   reveal attempt could not succeed even if the flag were flipped by mistake.
3. **After the staging grant.** Staging's MCP surface grows the write tools and
   `get_secret_value` at the next boot. Prod's does not, because prod's credential
   is unchanged.
