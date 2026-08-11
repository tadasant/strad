# remote-filesystem — strad's artifact store

The server behind the `remote-filesystem-tmp-public` slug. An agent uploads a
screenshot, a recording or a report; it gets back a URL; it hands that URL to a
human. **Link ergonomics and sensitivity handling are the whole product.**

strad's own implementation, not a vendored one. Sensitivity, link life, and the
ability to revive an expired link are the three things it exists to own.

## Two kinds of link

| `is_sensitive` | object state | link | expires |
| --- | --- | --- | --- |
| `false` (default) | private | signed URL on `storage.googleapis.com` | after `expires_in_days`, default **14** |
| `true` | private + `domain-<viewer>` READER ACL | `storage.cloud.google.com/<bucket>/<path>`, plus `?authuser=` when an account is configured | never |

A **signed** link opens instantly for anyone holding it, with no Google account.
That is the good UX and it is what a screenshot should get.

A **restricted** link carries no signature. `storage.cloud.google.com` is GCS's
cookie-authenticated browser front door: an anonymous request is redirected to the
Google sign-in page, and after sign-in the object's ACL decides. Only members of
the configured Workspace domain get in. It does not expire because nothing about
it is time-limited — the grant is.

`storage.googleapis.com` is **not** interchangeable for the restricted case. It
authenticates bearer tokens and signatures only, so it answers an unauthenticated
browser with a bare 403 and no way forward.

### The restricted link names an account

Cookie authentication resolves against **one** of the reader's signed-in Google
accounts, and a bare URL gets the profile's default — usually a personal address
that is not in the granted domain, so Google answers 403. The ACL is correct and
the reader is signed in to an account that would open it; Google never asked that
account, and nothing in the error says so.

With `_SENSITIVE_VIEWER_ACCOUNT` set, restricted links carry
`?authuser=<address>`, Google's account selector, and open against that account
whichever one is default. It is a **hint, not a grant** — the `domain-<viewer>`
ACL still authorises the whole domain. Unset, no `authuser` is emitted, because
naming an account the reader is not signed in to is worse than the bare URL.

Every restricted response also carries `sign_in_hint`: what to tell a human whose
link 403s.

## The seven-day problem

**GCS's V4 signing process caps expiry at seven days** (604800s), enforced by
Google and by the Node SDK. A fourteen-day default is therefore impossible with
V4. It *is* possible with **V2**, the older signing process, which has no such
cap — verified against a real bucket: 14-day and 365-day V2 URLs both serve `200`
anonymously.

So this server picks the process by duration: **V4 for ≤ 7 days, V2 beyond it**,
and reports which one it used in `signing_version`. V4 stays the path for the
common case; V2 is legacy and Google could retire it, at which point links longer
than seven days stop being mintable and the default has to drop to 7.

That is the tradeoff, taken deliberately, and `refresh_link` is what makes it
survivable: a dead link is one tool call away from being alive again. The server
never silently downgrades a 14-day request to 7 — handing back a link that
expires in half the time the caller asked for is the failure this design exists
to avoid.

## Tools

| tool | group | what it does |
| --- | --- | --- |
| `upload_file` | readwrite | store bytes from the MCP call, return a link |
| `get_upload_url` | readwrite | mint a temporary curl-friendly POST URL |
| `refresh_link` | readonly | mint a fresh link for an existing artifact |
| `list_files` | readonly | browse one directory level, to find a path |
| `download_file` | readonly | read an artifact's bytes back |
| `set_sensitivity` | readwrite | re-classify an artifact and re-link it |
| `delete_file` | readwrite | permanently delete (the only true revoke) |

`refresh_link` is `readonly` even though it mints a credential-bearing URL: it
changes nothing about the object, and withholding it from a read-only role would
leave that role able to LIST artifacts it could never open.

`get_upload_url` is the preferred path for any nontrivial payload. It returns an
unguessable `/mcp-upload/<slug>/<token>` POST URL, a short expiry, and a `curl
--data-binary` command. The POST body is stored through the same code path as
`upload_file`, so sensitivity, overwrite handling, content type and returned
browser links behave the same way. One successful POST consumes the URL; an
expired URL stores nothing. The route exists so agents can upload screenshots,
recordings, PDFs and logs from a shell without base64-encoding artifact bytes
through MCP.

Upload leases live in this server process. A restart invalidates them, and a
multi-replica deployment needs sticky routing or one upload-capable replica.
Use the returned curl command promptly and keep the artifact `path` from the POST
response; that path is the durable handle.

## Storage layout

**No root prefix, on purpose.** `GCS_ROOT_PATH` is supported but unset in
production, so uploads land at bucket root and — crucially — every object ever
written to the bucket stays addressable by `refresh_link`. Confining the server to
a prefix would make "dig up that screenshot from June" fail for everything older
than this change.

When `path` is omitted, uploads land at
`uploads/<YYYY>/<MM>/<DD>/<HHMMSS>-<nonce><ext>` — date-partitioned so the bucket
stays browsable, nonce-suffixed so two uploads in one second cannot overwrite each
other.

**Sensitive artifacts are NOT segregated by prefix.** The protection is a
per-object ACL; a `sensitive/` prefix would imply an enforcement that does not
exist, and an object with a mis-set ACL sitting under it would look safe while
being readable.

## Configuration

Every key is read under a **slug-namespaced prefix**, passed by the bundle host as
`envPrefix: "REMOTE_FILESYSTEM_TMP_PUBLIC"`. This server never reads the bare
`GCS_*` names: the `gcs` server owns those in the same container and points at a
different bucket, and one process cannot hold two values of `GCS_BUCKET`.

| variable (after the prefix) | required | meaning |
| --- | --- | --- |
| `_GCS_BUCKET` | yes | the one bucket every operation is scoped to |
| `_GCS_PROJECT_ID` | no | project for billing/quota |
| `_GCS_CLIENT_EMAIL` | no | service-account email (with the key below) |
| `_GCS_PRIVATE_KEY` | no | service-account PEM; escaped newlines are handled |
| `_GCS_ROOT_PATH` | no | prefix confinement. Unset in production |
| `_SENSITIVE_VIEWER_DOMAIN` | for sensitive uploads | Workspace domain that may open a restricted artifact, e.g. `tadasant.com` |
| `_SENSITIVE_VIEWER_ACCOUNT` | no | address a restricted link names via `?authuser=`, e.g. `dana@tadasant.com`. Must be a full address inside `_SENSITIVE_VIEWER_DOMAIN`; a bad one is rejected when the store is first built, which is the first tool call after a deploy |
| `_LINK_DEFAULT_DAYS` | no | default link life. Defaults to 14 |
| `_UPLOAD_BASE_URL` | no | public origin for absolute upload URLs. Falls back to `STRAD_PUBLIC_URL`; if neither is set, `get_upload_url` returns a root-relative path |

Without `_SENSITIVE_VIEWER_DOMAIN`, an `is_sensitive: true` upload is **refused**
rather than stored. Storing a sensitive artifact that nobody can open is a worse
outcome than a loud failure.

## Bucket requirements

- **Uniform bucket-level access must be OFF.** The restricted path is a per-object
  ACL, and UBLA disables object ACLs. IAM Conditions are not an alternative — they
  require UBLA *on*. With UBLA on, every artifact reads as `access: "unknown"` and
  no link is issued at all, which is the intended failure: losing the sign-in gate
  quietly would be worse.
- The service account needs object read/write on the bucket, plus
  `storage.objects.update` to set ACLs, and a private key so URLs can be signed
  locally.

## Build and test

```
npm ci
npm run build
npm test          # a real MCP client over an in-memory transport, plus unit tests
```
