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

| Console operation     | API calls                                                                                                                       | Permissions required                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(namespace)`     | PM `parameters.list`, `…/versions` list, `…/versions/{v}` GET                                                                   | `parametermanager.parameters.list`, `parametermanager.parameterVersions.list`, `parametermanager.parameterVersions.get`                                                       |
| `create` — non-secret | PM parameter POST, PM version POST                                                                                              | `parametermanager.parameters.create`, `parametermanager.parameterVersions.create`                                                                                             |
| `create` — secret     | SM `secrets` POST, SM `:addVersion`, PM parameter POST, PM parameter GET, SM `:getIamPolicy` + `:setIamPolicy`, PM version POST | + `secretmanager.secrets.create`, `secretmanager.versions.add`, `parametermanager.parameters.get`, `secretmanager.secrets.getIamPolicy`, `secretmanager.secrets.setIamPolicy` |
| `rotate` — non-secret | PM version GET + POST                                                                                                           | as create, non-secret                                                                                                                                                         |
| `rotate` — secret     | PM versions list + version GET, SM `:addVersion`                                                                                | `parametermanager.parameterVersions.list`, `…get`, `secretmanager.versions.add`                                                                                               |
| `setNote`             | PM version GET + POST                                                                                                           | as create, non-secret                                                                                                                                                         |
| **`reveal` — secret** | PM version GET, then **SM `versions/latest:access`**                                                                            | **`secretmanager.versions.access`** ← the one prod must not hold, on top of the PM reads                                                                                      |
| `reveal` — non-secret | PM version GET only                                                                                                             | `parametermanager.parameterVersions.get`                                                                                                                                      |
| `destroy`             | PM parameter GET, versions list + DELETE, parameter DELETE, SM secret DELETE                                                    | `parametermanager.parameters.get`, `…parameters.delete`, `…parameterVersions.list`, `…parameterVersions.delete`, `secretmanager.secrets.delete`                               |

Two things fall out of this table, and both matter:

Every row also needs the `list` row's Parameter Manager reads, which the console
performs before any mutation; they are not repeated per row. The custom roles
below grant a few permissions no current code path calls (`secrets.list`,
`versions.list`, `parameters.update`) — deliberately, so a future version of the
console does not need an IAM change to enumerate or relabel what it already owns.

**Reveal is the only operation that needs `secretmanager.versions.access`.**
Everything else the console does — create, rotate, note, delete, list — works
without it. So write-without-read is achievable _as a permission set_: the console
keeps managing secrets and loses the ability to display one. It is **not** a
boundary on its own, because a secret create also needs
`secretmanager.secrets.setIamPolicy`, and that permission can grant read back to
its holder — see [the danger note below](#1-prod-console-write-but-never-read).

**`parameterVersions.get` is safe to keep.** It reads the parameter's raw
envelope, and for a secret parameter that envelope holds a `__REF__` pointer, not
a value. Listing keeps working; nothing in it dereferences.

:::note[Permission names are Google's, not ours]
Parameter Manager reads a version's payload with **`parameterVersions.get`**.
There is no `parametermanager.parameterVersions.access` — that spelling borrows
Secret Manager's verb (`secretmanager.versions.access`) and Parameter Manager does
not use it. `gcloud iam roles create` rejects a permission name it does not know,
so a custom role containing it fails to create at all rather than creating a role
that grants nothing.
:::

:::caution[The second read path is OPEN — `versions.access` alone is not the boundary]
Parameter Manager's `:render` verb dereferences a `__REF__` into the secret's
value. It does **not** run as the caller — it derefs as the _parameter's own_
principal. So a caller holding `render` and **not** `secretmanager.versions.access`
still gets a secret value back.

`create()` grants each parameter's principal `secretAccessor` on the secret it
points at, so this is the normal state of every secret strad writes, not a
hypothetical. It has to be: without that grant nothing resolves at all — see
[Why a parameter must be granted access to its own secret](#why-a-parameter-must-be-granted-access-to-its-own-secret).

**Withholding `versions.access` is therefore not sufficient** to build a console
that cannot read secret values. It must also be denied
`parametermanager.parameterVersions.render`. The custom role below omits `render`
for exactly this reason, and `roles/parametermanager.admin` **includes** `render`
and is not a safe base role for a write-without-read console.

`src/secrets/parameters/capabilities.ts` probes for `render` as well as
`versions.access` and treats either as "can read a secret value", so the console's
own reporting stays honest about which path is open.
:::

## 1. Prod console: write, but never read

**Goal.** `strad-secrets-admin@strad-secrets-prod.iam.gserviceaccount.com` can
add, rotate, note and delete secrets, and cannot read one back.

**Bonus, and it is a real one.** This service account's key
(`SECRETS_ADMIN_KEY_JSON`) is among the credentials exposed in
`tadasant-internal#215`, and rotating it has been
deliberately deferred. Downgrading the account **shrinks the blast radius of the
un-rotated key**: an attacker holding it could no longer read prod secret values
_by simply asking for them_, only write them. That does not make the key safe and
it is not a substitute for rotation — a write-capable credential is still a
serious one — but it raises the cost of exfiltration and makes it visible. Treat
this change as a partial mitigation of an accepted risk, not only as a feature.

:::danger[This role can escalate to read. Say it out loud.]
A secret create has to grant the parameter's own principal `secretAccessor`, so
the console's role includes **`secretmanager.secrets.setIamPolicy`**, bound at
**project** level. That permission lets its holder write any binding onto any
secret in the project — **including granting itself
`roles/secretmanager.secretAccessor`**. So "cannot read a secret value" is true of
the permissions it holds and **false as a security boundary**: it is two API calls
away from full read.

This is not a flaw in the role list; it is inherent to a console that can create
secret parameters at all. What is a flaw is claiming otherwise, so:
**write-without-read here is a speed bump and an audit signal, not a wall.** It
means a bug, a bad merge or a prompt injection does not read a secret by accident,
and that an attacker who does read one must first take a conspicuous, logged
policy-write action. It does not mean a determined holder of this key cannot read
production secrets.

**Close it properly with an IAM deny policy**, which is evaluated before any allow
and cannot be self-granted around:

```bash
PROJECT_ID=strad-secrets-prod
SA=strad-secrets-admin@${PROJECT_ID}.iam.gserviceaccount.com
cat > /tmp/strad-console-deny.json <<JSON
{
  "displayName": "strad console: never read a secret value",
  "rules": [{
    "denyRule": {
      "deniedPrincipals": ["principalSet://goog/subject/${SA}"],
      "deniedPermissions": [
        "secretmanager.googleapis.com/versions.access",
        "parametermanager.googleapis.com/parameterVersions.render"
      ]
    }
  }]
}
JSON
gcloud iam policies create strad-console-no-read \
  --attachment-point="cloudresourcemanager.googleapis.com/projects/${PROJECT_ID}" \
  --kind=denypolicies --policy-file=/tmp/strad-console-deny.json
```

Note the deny policy names permissions in their **fully-qualified** `service/verb`
form, which is a different spelling from the allow-side names used everywhere else
on this page. Until this is applied, the un-rotated key from `#215` should be
treated as read-capable. Tracked as [Known limitations](/limitations/) #31.
:::

No predefined role gives Secret Manager create + delete + add-version _without_
`versions.access`, so this needs two custom roles.

```bash
PROJECT=strad-secrets-prod
SA=strad-secrets-admin@${PROJECT}.iam.gserviceaccount.com

# --- Secret Manager: create, delete, add versions. NOT versions.access. -------
cat > /tmp/strad-console-sm.yaml <<'YAML'
title: strad secrets console (Secret Manager, write-only)
description: Create/delete secrets, add versions, and grant a parameter access to its own secret. Deliberately excludes secretmanager.versions.access.
stage: GA
includedPermissions:
  - secretmanager.secrets.create
  - secretmanager.secrets.delete
  - secretmanager.secrets.get
  - secretmanager.secrets.list
  # The IAM half of a secret create. `create()` grants the PARAMETER's own
  # principal secretAccessor on the secret it points at; without these two the
  # create fails partway and rolls back, and the console cannot write a secret
  # at all. Neither READS a value — but setIamPolicy can GRANT the ability to,
  # to this same principal. See the danger note above; the deny policy is what
  # actually closes that, not this role's contents.
  - secretmanager.secrets.getIamPolicy
  - secretmanager.secrets.setIamPolicy
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
  - parametermanager.parameterVersions.create
  - parametermanager.parameterVersions.delete
  - parametermanager.parameterVersions.get
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

# Enable this API in both projects. It backs BOTH the runtime probe AND the audit
# commands below — they are the same call. Without it, the console reports
# "capability unverified" and withholds reveal (safe but opaque), and the audit
# itself answers 403 instead of answering the question.
gcloud services enable cloudresourcemanager.googleapis.com --project="${PROJECT}"
```

**Audit assertion.** Run as the service account itself; the first command is the
one that matters.

There is no `gcloud` subcommand for this. `testIamPermissions` is a method on the
resource, not a CLI verb, so the audit is a REST call to Cloud Resource Manager —
the same endpoint `capabilities.ts` uses at runtime, which is what makes the
assertion and the console's own report the same fact.

```bash
gcloud auth activate-service-account --key-file=/path/to/prod-console-key.json
CRM="https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions"

# MUST print {} — no read path, by either route.
curl -sS -X POST "${CRM}" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["secretmanager.versions.access","parametermanager.parameterVersions.render"]}'

# MUST list all six — the console still manages secrets. The two IAM-policy
# permissions are part of a secret CREATE (see the section below); a role missing
# them reports writeSecretValues=false and the console withholds the create.
curl -sS -X POST "${CRM}" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["secretmanager.secrets.create","secretmanager.versions.add","secretmanager.secrets.getIamPolicy","secretmanager.secrets.setIamPolicy","parametermanager.parameters.create","parametermanager.parameters.delete"]}'
```

The response carries only the subset the caller holds, so "none of them" comes back
as an empty body — `{}`, not a list of `false`. The first command printing `{}` is
the whole point of this section. strad's own console reports the same fact on the
page, from the same call.

A `403` from either command is not an answer about the grant. It means the Cloud
Resource Manager API is not enabled on the project — the `gcloud services enable`
line above — or that this credential has no access to the project at all. It is the
same 403 the runtime probe reports as "capability unverified".

## Why a parameter must be granted access to its own secret

This is the least guessable thing on this page, and getting it wrong produces an
error that points at the wrong credential.

A secret parameter's Parameter Manager payload holds a `__REF__` pointer, and
`:render` dereferences it **as the parameter**, using a principal minted with the
parameter itself. The caller's permissions authorise the `:render` _call_; they
have nothing to do with reaching the secret. So a secret must grant
`roles/secretmanager.secretAccessor` to:

```
principal://parametermanager.googleapis.com/projects/PROJECT_NUMBER/uid/locations/global/parameters/PARAMETER_UID
```

Without it, every resolution of that parameter fails with
**`400 SECRET_REFERENCE_ERROR`** — while the resolver holds every permission the
message seems to implicate, and a `testIamPermissions` probe of the resolver comes
back completely clean. Nothing about the failure points at the parameter.

**strad makes this grant itself.** `create()` in `src/secrets/parameters/gcp.ts`
(and the matching path in the `secrets` MCP server's `write-client.ts`) reads
`policyMember.iamPolicyUidPrincipal` from the parameter and sets the binding on the
secret, after the parameter exists and before the first version — so a
complete-looking parameter with an unresolvable reference never exists. A grant
that fails rolls the whole create back. The only IAM work a human does is making
sure the writing credential holds `secretmanager.secrets.getIamPolicy` and
`secretmanager.secrets.setIamPolicy`, which the roles on this page include.

### Backfilling parameters created before strad made this grant

Parameters written by an earlier strad have no binding, and nothing repairs them
automatically — `rotate` adds a secret version and does not touch IAM. Repair is
per-parameter and idempotent:

```bash
PROJECT=strad-secrets-staging   # or strad-secrets-prod
LOCATION=global

for ID in $(gcloud parametermanager parameters list \
      --project "$PROJECT" --location "$LOCATION" \
      --format='value(name.basename())'); do
  # Only secret parameters have a secret to bind.
  gcloud secrets describe "$ID" --project "$PROJECT" >/dev/null 2>&1 || continue
  PRINCIPAL=$(gcloud parametermanager parameters describe "$ID" \
    --project "$PROJECT" --location "$LOCATION" \
    --format='value(policyMember.iamPolicyUidPrincipal)')
  # An empty principal means the describe failed; binding "" is an error, not a
  # no-op, and it would abort the loop partway through.
  [ -n "$PRINCIPAL" ] || { echo "no principal for $ID, skipping" >&2; continue; }
  gcloud secrets add-iam-policy-binding "$ID" --project "$PROJECT" \
    --member="$PRINCIPAL" --role=roles/secretmanager.secretAccessor
done
```

**Assert it worked.** Pick one secret parameter and render it: this must print its
real value, not a `__REF__` and not an error. Set `ID` explicitly — do not rely on
whatever the loop above left behind:

```bash
ID=<one secret parameter id from the loop above>
VERSION=$(gcloud parametermanager parameters versions list "$ID" \
  --project "$PROJECT" --location "$LOCATION" \
  --format='value(name.basename())' --limit 1)

gcloud parametermanager parameters versions render "$VERSION" \
  --parameter "$ID" --project "$PROJECT" --location "$LOCATION"
```

A `400 SECRET_REFERENCE_ERROR` here means the binding did not land. **Give it a
minute first** — an IAM change takes up to ~2 minutes to propagate (occasionally
longer), and during that window the failure is indistinguishable from the bug.

## The resolver's roles: `parameterViewer` is not enough

`roles/parametermanager.parameterViewer` does **not** include
`parametermanager.parameterVersions.render`. That permission is in
`roles/parametermanager.parameterAccessor`, and rendering is exactly what the
resolver does — `resolve()` is one `list` plus one `:render` per parameter.

A resolver provisioned with `parameterViewer` alone therefore **lists fine and
403s on every render**, which reads like an intermittent or partial outage rather
than a missing role. It needs both:

```bash
PROJECT=strad-secrets-staging   # or strad-secrets-prod
SA=strad-secrets-resolver@${PROJECT}.iam.gserviceaccount.com

# The parameters and their envelopes (list + get).
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" --role="roles/parametermanager.parameterViewer"

# The deref itself. WITHOUT THIS, every :render is a 403.
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA}" --role="roles/parametermanager.parameterAccessor"
```

**The resolver does not need `roles/secretmanager.secretAccessor`.** It never calls
Secret Manager: the deref happens under the parameter's own principal, which is what
the grant in the previous section is for. Granting it to the resolver as well is
harmless but misleading — it looks like the thing that makes rendering work, and it
is not, so a debugger who sees it present concludes the IAM is fine.

**Audit assertion.** Run as the resolver; both must be listed.

```bash
gcloud auth activate-service-account --key-file=/path/to/resolver-key.json
curl -sS -X POST \
  "https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["parametermanager.parameterVersions.list","parametermanager.parameterVersions.render"]}'
```

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

# Gates the server's startup probe AND the audit below — both are the same call.
gcloud services enable cloudresourcemanager.googleapis.com --project="${PROJECT}"
```

**Audit assertion.** All nine must be listed; the MCP server's tool surface is
derived from exactly this answer. The last three are the IAM half of a secret
create — `roles/secretmanager.admin` and `roles/parametermanager.admin` above
already carry them, so this asserts the grant rather than adding to it.

```bash
gcloud auth activate-service-account --key-file=/path/to/staging-viewer-key.json
curl -sS -X POST \
  "https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["secretmanager.versions.access","secretmanager.versions.add","secretmanager.secrets.create","secretmanager.secrets.delete","parametermanager.parameters.create","parametermanager.parameterVersions.create","parametermanager.parameters.get","secretmanager.secrets.getIamPolicy","secretmanager.secrets.setIamPolicy"]}'
```

There is no flag to set for this. The server probes at startup and lists the tools
the credential supports — `get_secret_value`, `create_parameter`,
`set_parameter_value`, `set_parameter_note`, `delete_parameter` — so the grant
above _is_ the configuration. Revoke it and the tools disappear on the next boot.

**The staging deploy runs this audit for you.** `deploy-staging.yml` ends by
running `scripts/probe-capabilities.ts` — the same probe, against the same two
keys — and printing five booleans for each. It is non-fatal and prints no secret
material. That exists because a grant that did not land is indistinguishable from
a deliberate narrowing from the outside: both are just a smaller tool surface. See
[Operations](/operate/operations/#deploy-stagingyml--put-it-on-app-platform).

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
absent — the surface narrows, which is the safe direction, but the audit assertions
above would then be proving the wrong thing. And a **conditional** binding can be
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
