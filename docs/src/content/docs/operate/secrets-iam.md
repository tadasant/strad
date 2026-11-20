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
[the console's reveal posture](/operate/secrets/#reveal-and-why-a-flag-is-not-a-boundary)
for what the page shows.

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
| **`resolve`**         | the `list` row, then **PM `…/versions/{v}:render`** per parameter                                                               | **`parametermanager.parameterVersions.render`** ← the resolver's whole reason to exist, on top of the PM reads                                                                |

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

One console feature is a reveal under another name: an `oauth:` connector reads
its own OAuth client through it, so a connector needs `versions.access` on its two
client secrets and nowhere else. That is the one exception to §1, granted per
secret — see
[An `oauth:` connector reads its own OAuth client](#an-oauth-connector-reads-its-own-oauth-client).

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

## Token admin

`/tokens` mints, revokes and forgets `/mcp` tokens by rewriting one secret
parameter, `/strad/{env}/gateway/static/STRAD_TOKENS`. Each of those is a
read-modify-write, and the two halves use different credentials:

| Half      | Credential                                                                    | What it calls                                                         | Permissions                                                                                           |
| --------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **read**  | the gateway's **resolver** (`STRAD_PARAMS_RESOLVER_SERVICE_ACCOUNT_KEY_JSON`) | PM versions list + GET, then `…/versions/{v}:render` on that one path | the resolver's roles below, plus the parameter's own principal holding `secretAccessor` on its secret |
| **write** | the console's **admin** (`SECRETS_ADMIN_KEY_JSON`)                            | the `rotate` row above, or the `create` row on the first mint         | §1's custom roles, unchanged                                                                          |

**Why not the console's own read.** On prod the console holds no read path (§1),
so a `reveal()` through it is a 403. Granting it one, even `secretAccessor` on
this one secret, would put a standing read of the gateway's access-control list
on a credential that never needs to display it, and §1's deny policy blocks that
grant anyway. The resolver already holds exactly this read: `/mcp` makes it on
every request, because the token store cannot work without it. Borrowing it adds
no grant anywhere.

**So there is nothing to apply for `/tokens`.** A deployment where `/mcp`
accepts its tokens already has every grant a mint or revoke needs. If `/tokens`
reports the resolver was refused, `/mcp` is failing the same read; fix it with
[the resolver's roles](#the-resolvers-roles-parameterviewer-is-not-enough) and
[the parameter's own grant](#why-a-parameter-must-be-granted-access-to-its-own-secret).
If it reports the parameter would not render (`400`), the parameter's own
principal lacks `secretAccessor` on its secret — the shape of a parameter seeded
outside strad; see
[Backfilling](#backfilling-parameters-created-before-strad-made-this-grant).
If it reports the console's admin credential was refused, the console is
missing the write half of §1.

## Never grant the `secrets` MCP credential `parameterAccessor`

:::danger[This is the one grant that would open `/mcp` to prod secret values]
`:render` returns a secret value, and `create()` now makes the grant that lets it
(see [below](#why-a-parameter-must-be-granted-access-to-its-own-secret)). That was
necessary — nothing resolves without it — but it means **the only thing keeping the
`/mcp` channel away from a prod secret value is that prod's MCP credential holds
`parameterViewer` (get/list) and not `parameterAccessor` (which carries `render`)**.
Before that grant existed, two independent things blocked that path. Now one does.

The trap is that granting it looks reasonable. The credential is _for reading
parameters_, and `parameterAccessor` is named as though it is the role for that. It
is not: `parameterViewer` is the read role, and `parameterAccessor` is specifically
the deref. This repo has now misstated that distinction in four separate documents,
so assume the next person will too.

If the `secrets` server ever appears unable to read something in prod, that is the
design working. The fix is never to widen this credential.

**Be precise about what is and is not enforced.**
`test/parameters.store.test.ts` asserts the MODEL: a viewer-scoped client is
refused both read paths even with the parameter's own grant in place. It pins
strad's understanding of the boundary, so a code change that stops honouring it
fails CI.

It does **not** pin the deployment. CI has no visibility into the prod viewer
service account's IAM policy, and nothing in this repo does. A human running
`add-iam-policy-binding --role=roles/parametermanager.parameterAccessor` against
that account is exactly what this section forbids and exactly what no test can
see. That is why the audit below exists: it is the only thing that can catch it.

**Audit assertion — the prod `secrets` MCP credential.** Run as that service
account. It MUST print `{}`: neither read path, by either route.

```bash
PROJECT=strad-secrets-prod
gcloud auth activate-service-account --key-file=/path/to/prod-viewer-key.json
curl -sS -X POST \
  "https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["secretmanager.versions.access","parametermanager.parameterVersions.render"]}'
```

A non-empty answer here means `/mcp` can read production secret values. There is
no second line of defence behind it.
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
add, rotate, note and delete secrets, and cannot read one back. The one exception
is an `oauth:` connector's own OAuth client, which the console has to read to run
the consent. It is granted secret by secret, never here at project level, and the
console makes that grant itself — see
[An `oauth:` connector reads its own OAuth client](#an-oauth-connector-reads-its-own-oauth-client),
which is also where the deny policy below stops it.

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

## The custody deposit route needs no grant of its own

`POST /_strad/deposit/{slug}/{VARIABLE}` is how strad-hostd's custody server
stores a credential it captured
([custody and deposit](/servers/hostd-custody/)). It writes with the
**console's admin credential**, through the same `store.create()` the console's
create form calls. So it needs exactly the create permissions in the table at
the top of this page, which §1 already grants, and nothing else. The
per-parameter `secretAccessor` grant is made by `create()` as for any console
create.

The write-only property is enforced by the route, not by IAM. The Mac holds no
GCP credential at all, only a bearer derived from its custody slug's key, and
the route will only create a secret parameter under
`/strad/<env>/mcp/<slug>/static/`. It never reads, never overwrites, and never
touches an `oauth/` name. The one gateway name it can create is a bundle's
`tailnet.authKey` that the custody slug lists in `deposit.gatewayVariables:`,
create-only, under `/strad/<env>/gateway/static/`. It writes through the
same console store, so it needs no new grant either, but that store's
`consoleEnv.SECRETS_NAMESPACES` has to cover `/strad/<env>/gateway/static/`.
Without it, the route answers 503 `store_unavailable`. A GCP key on the laptop could not be made
write-only this cleanly: creating a secret needs `secretmanager.secrets.setIamPolicy`,
and anything holding that can grant itself read. That is the "speed bump, not a
wall" this page closes with a deny policy for the console. Keeping the GCP
identity on core is what keeps that deny policy the only one to maintain.

## An `oauth:` connector reads its own OAuth client

A server with an [`oauth:` connector](/operate/connectors/) has a **Connect**
button, and the flow behind it reads the slug's own OAuth client — the client id
and client secret seeded under `/strad/{env}/mcp/<slug>/static/`. It reads them
through the console's store, with the console's credential, using `reveal()`. The
connect POST reads the client id before it sends anyone to the provider, and the
callback reads both to exchange the code.

For a **secret** parameter, `reveal()` is Secret Manager's
`versions/latest:access`, and that needs `secretmanager.versions.access`: the
permission §1 withholds. So on a console run the way §1 says, a connector whose
client values are secret parameters lists as ready, and pressing **Connect**
refuses. The page names the permission and the exact Secret Manager resource, and
`strad.connector_connect_failed` records `reason: client_unreadable` with
`status: 403` (see [Connectors](/operate/connectors/#telemetry)).

**strad makes this grant itself.** Both halves of it:

- **On create.** Creating a secret parameter whose path is a declared
  connector's `oauth.clientIdVariable` or `oauth.clientSecretVariable`, under
  that slug's own `static/` namespace, also binds the console's service account
  `secretAccessor` on that one secret. The console derives which paths qualify
  from the config's `oauth:` blocks — no field on the create form can ask for
  it — so a connector seeded from `/ui/<secrets-slug>` today is connectable
  without anyone opening a terminal.
- **On the connector's own page.** Every connector that already exists was
  seeded before that, so a slug whose client is present and unreadable gets a
  **Grant read on this client** button beside the refusal it just produced. It
  binds the same member on the same two secrets, and then **reads the values
  back** before it claims anything.

**The read-back is the point, not a formality.** The deny policy in §1 is
evaluated before any allow, so on a deployment that applied it the `setIamPolicy`
succeeds and the read still fails. The page says exactly that — it names the
permission, the resource and the deny policy — rather than reporting success and
letting **Connect** fail after the human has consented. Two records say so in the
logs: `strad.connector_client_granted` (`slug`, `variable`, `result`) when it
worked, and `strad.connector_client_grant_failed` at ERROR with
`reason: denied` when the binding landed and bought nothing.

**This is only coherent on a deployment that accepts §1's posture.** §1 is
explicit that write-without-read there is a speed bump and an audit signal rather
than a wall: the console holds `setIamPolicy` at project level and is two API
calls from granting itself read. The button changes how ergonomic that self-grant
is, not whether it is possible. A deployment that closed the escalation properly
with the deny policy has decided its connectors need a human, and it gets told
that instead of a button that cannot work. What the button costs is the
conspicuousness of the act, and what replaces it is the exported record above.

**The `oauth/` kind is never granted**, for either path. The client id and client
secret are values a human typed and holds a copy of; the credential strad mints
and stores under `oauth/` is one no person has ever seen, and the console being
unable to read it back is the whole meaning of the kind. A client hand-seeded
under `oauth/` is refused by the button, with a sentence saying so, and keeps the
manual grant below.

**The fallback: the same grant by hand.** For a client under `oauth/`, for a
store this console does not front, or for any deployment that would rather not
press the button, it is `roles/secretmanager.secretAccessor` for the console's
service account, bound on **that slug's own client-id and client-secret secrets
only**:

```bash
PROJECT=strad-secrets-prod
SA=strad-secrets-admin@${PROJECT}.iam.gserviceaccount.com
SLUG=google-sheets-personal-ro
ENV=prod

for VAR in GOOGLE_SHEETS_OAUTH_CLIENT_ID GOOGLE_SHEETS_OAUTH_CLIENT_SECRET; do
  # A secret's id is the parameter id: strad's fold of the canonical path. Past
  # 63 characters the fold keeps a 54-character head and appends a hash, so the
  # two ids share a head and differ only in the hash — compute them, don't guess.
  SECRET=$(node --experimental-transform-types --no-warnings -e \
    'import("./src/secrets/parameters/wire.ts").then((w) => console.log(w.parameterId(process.argv[1])))' \
    "/strad/${ENV}/mcp/${SLUG}/static/${VAR}")
  gcloud secrets add-iam-policy-binding "${SECRET}" --project "${PROJECT}" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor
done
```

Run it from a checkout of this repo, since the fold is strad's — which is most of
why this is the fallback rather than the procedure. The refusal page names the
client id's resource verbatim (`projects/<project>/secrets/<id>`), but nothing
reads the client secret's until the callback, after the human has already
consented, so that id has to be computed rather than read off a refusal. Grant
both before anyone presses **Connect**. If the client id is seeded as a
**non-secret** parameter, it has no secret to grant on, and the loop needs only
the second name. A client id is not a secret: it goes out in every authorization
URL.

**Why not a project-wide accessor.** `roles/secretmanager.secretAccessor` on the
project gives the console every secret value in it: every other slug's
credentials, every refresh token a connector has stored, strad's own. Removing
exactly that is what §1 is for. The per-secret binding gives the console two
values it has to read anyway, for one slug, and nothing else. The tokens a
connector writes under `oauth/` stay unreadable to it, and those are the
credentials worth protecting.

Four consequences to know:

- **The §1 audit cannot see this grant, in either direction.**
  `projects:testIamPermissions` answers at project level, so it still prints `{}`
  after a per-secret binding. Audit the binding on the secret itself:
  `gcloud secrets get-iam-policy "${SECRET}" --project "${PROJECT}"`.
- **The deny policy in §1 overrides it.** Deny is evaluated before allow, so with
  `strad-console-no-read` applied, this binding grants nothing and **Connect**
  refuses with the same 403 — whether the binding was written by hand or by the
  button, which is why the button verifies instead of assuming. A deny rule's
  condition can match resource tags but not resource names. Keeping both means
  tagging the connector's client secrets and exempting that tag in the rule's
  `denialCondition`, and strad has neither built nor tested that. Decide which one
  a deployment wants before applying the deny policy.
  [Known limitations](/limitations/) #99 has the trade.
- **The console's reveal control reaches the same two values.** The grant is on
  the console's credential, and reveal uses that credential too. With
  `SECRETS_REVEAL_ENABLED` on, a signed-in session could display this slug's
  client id and secret. It is off in production, and the flag is what keeps
  those two values off a screen.
- **The binding lives on the secret, not the version.** Rotating the client
  secret adds a version and keeps it. Deleting the parameter deletes its secret
  and the binding with it — and since a create now makes the grant, re-seeding
  from scratch restores it on its own.

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

Two other 400s are not this bug, and the message does not distinguish them:

- `INVALID_ARGUMENT … injection detected` means the secret's bytes broke the JSON
  payload they were substituted into — a value carrying `"`, `\`, `{`, `}` or a
  newline, written before strad encoded secret values. Rotating it through the
  console or the `secrets` MCP server re-writes it encoded and fixes it. See
  [Secrets](/operate/secrets/#what-a-secret-value-looks-like-in-the-store).
- The rendered `value` coming back as base64url rather than the value is not an
  error at all: that is the encoding, and strad's own readers decode it. Pipe it
  through `base64 -d` if you are reading by hand.

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
the grant in the previous section is for.

Prod's resolver **does** currently hold it, alongside the two Parameter Manager
roles, and that is fine — it grants nothing the resolver uses. Say so out loud
because its presence is actively misleading during debugging: it looks like the
thing that makes rendering work, so someone checking IAM sees it, concludes the
grants are correct, and stops one step short of the parameter-side binding that is
actually missing.

**Audit assertion.** Run as the resolver; both must be listed.

```bash
gcloud auth activate-service-account --key-file=/path/to/resolver-key.json
curl -sS -X POST \
  "https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:testIamPermissions" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"permissions":["parametermanager.parameterVersions.list","parametermanager.parameterVersions.render"]}'
```

**Holding `render` is not the same as rendering.** The permission is the caller's
half; the parameter's own principal must additionally reach the referenced secret
(the section above), and that is a property of the parameter rather than of this
credential — so no probe of this service account can tell you whether it is in
place. Prove the round trip rather than the binding, with the credential the
container will hold:

```bash
npm run store:check -- --config infra/strad.staging.yaml --resolve
```

It reports, by name and never by value, which of the namespace's names the
resolver can actually turn into a value — and reports a credential that cannot
render at all as a render failure rather than as a namespace full of missing
names, because the two have unrelated fixes. See
[Secrets](/operate/secrets/#is-the-namespace-complete-store-check).

## 2. Staging MCP server: read and write

**Goal.** The `secrets` MCP server on staging can read secret values _and_ write
parameters, so the store can be exercised end to end through the agent surface
rather than only through the console.

**This is scoped to staging on purpose, and what scopes it is the project.**
`strad-secrets-staging` is separate from the project holding strad's own
`strad-<env>-*` secrets, so the blast radius stops at its boundary. Inside that
boundary sit the per-server credentials staging's servers run on, so
`get_secret_value` returns a real secret and the write tools can delete or rewrite
a parameter a `params: true` server resolves at deploy time, breaking the next
staging deploy. The bound is separation, not harmlessness.

In **prod** the MCP credential stays the Parameter Manager viewer with neither
`secretmanager.versions.access` **nor
`parametermanager.parameterVersions.render`**, so the property from
`tadasant-internal#202` — the `/mcp` channel cannot
read a secret value — is unchanged there. That property is load-bearing and this
does not weaken it.

:::caution[Do not copy these commands to a prod service account]
The grant below is `roles/parametermanager.admin` + `roles/secretmanager.admin`,
and `parametermanager.admin` **includes `parameterVersions.render`**. That is
deliberate for staging and would be a prod secret-value leak: `render` is the half
that is load-bearing now, not `versions.access`. See
[Never grant the `secrets` MCP credential `parameterAccessor`](#never-grant-the-secrets-mcp-credential-parameteraccessor).
:::

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
the four read-only tools — plus `refresh_gateway`, which the probe does not
govern because it touches nothing in the store: it is offered wherever the
bundle host can reach core, and only there.

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
