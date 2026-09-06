---
title: Google Sheets
description: strad's own read-and-write Google Sheets MCP server — why it authenticates as a person rather than a service account, how one implementation serves several Google accounts, and what a slug has to supply.
---

Read and edit Google Sheets from an agent, as a specific Google account.

`google-sheets` is strad's own MCP server — source in
`images/bundle-google/vendor/google-sheets-shared/`, mounted at `/google-sheets`
inside the bundle image. It serves eight tools: four that read and four that
write.

## One server, one account per slug

Every other Google server in the bundle (gmail, google-calendar, google-docs)
authenticates as a **service account with domain-wide delegation**: one
credential that can impersonate any user in a Workspace domain. This one does
not. It authenticates as a **person**, with an OAuth refresh token that person
minted for their own account.

That choice has consequences worth stating, because they run in both directions:

- A refresh token reaches exactly one account, including a consumer `gmail.com`
  account, which domain-wide delegation cannot touch at all.
- A refresh token is a human-minted artifact. It does not rotate on its own, and
  when it is revoked — password change, consent withdrawn, or the seven-day
  expiry Google applies to tokens from an app still in "testing" — every call
  fails with `invalid_grant` until a human re-consents and re-seeds it. The
  server says exactly that when it happens rather than reporting a generic auth
  error.
- One token is one account, so **several accounts need several mounts**. That is
  the shape below.

## Six slugs, three accounts, one implementation

A slug's credential is baked onto the container under
[the slug's own variable names](/operate/secrets/#what-a-servers-variables-are-called-on-the-box)
(`GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN`), and the bundle
host mounts one instance of this server per slug it finds the OAuth client id and
secret for — the token is what the mount is _for_, not what summons it.
Nothing forks: the account is a parameter, and so is the tier.

```
                       ┌── /google-sheets-tadas412-ro     ← token: account A
  one implementation ──┼── /google-sheets-tadas412-rw     ← token: account A
  (vendored once)      ├── /google-sheets-tadas-tadasant-ro  ← token: account B
                       ├── ...
                       └── /google-sheets                 ← conventional mount
```

Each slug supplies three variables, for exactly one Google account:

| Variable | What it is |
| --- | --- |
| `GOOGLE_SHEETS_OAUTH_CLIENT_ID` | The GCP OAuth client the consent flow ran against |
| `GOOGLE_SHEETS_OAUTH_CLIENT_SECRET` | That client's secret |
| `GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN` | The token for **this slug's** Google account |

The client id and secret are usually the same across slugs — one OAuth app — and
the refresh token is what differs. A slug missing its refresh token still mounts
and still lists its tools; it is marked `degraded` in `/healthz` and every tool
call fails naming what is absent. That is deliberate: a slug that vanishes when
its credential is late is a slug nobody can diagnose — and the token is always
late, because the console page that mints it is the mount.

The **client id and secret are what the bundle host looks for**, not the token: a
slug the container carries both of under
[its own per-slug names](/operate/secrets/#what-a-servers-variables-are-called-on-the-box)
gets an instance of its own, whether or not it has ever been connected. Seed only
one of the two and there is no mount — the host has no config to read, so a
complete marker set is the only evidence a deployment asked for one.

## The read tier is the gateway's, and can also be Google's

The mount serves all eight tools. A `-ro` slug is that same mount with the four
write tools withheld by strad's
[tool policy](/intro/architecture/), enforced on `tools/list` **and** on
`tools/call`:

```yaml
- slug: google-sheets-tadas412-ro
  kind: supplementary-image
  image: ghcr.io/tadasant/strad-bundle:latest
  bundle: bundle
  path: /google-sheets-tadas412-ro
  entitlements: [zimmer]
  oauth:
    provider: google
    account: tadas412@gmail.com
    scopes:
      - https://www.googleapis.com/auth/spreadsheets.readonly
  tools:
    allow:
      - get_spreadsheet
      - get_sheet_values
      - batch_get_sheet_values
      - find_in_spreadsheet
```

There is no `env:` block, and that is deliberate. The
[`oauth:` connector](/operate/connectors/) owns all three variables: strad reads
them from this slug's own namespace and injects them, each one only if the store
holds it. Writing them as `${NAME}` references is refused by the config gate,
because the refresh token does not exist until a human has consented in the
console — and `render-spec` fails the **whole** app spec on one unresolvable
reference, so a single unconnected slug would take every other server's deploy
with it.

The `-rw` slug is the same entry with no `tools:` block — the full eight are that
tier — its own `path`, and `scopes: [https://www.googleapis.com/auth/spreadsheets]`,
so it holds its own credential consented for the wider scope.

Unlike [1Password](/limitations/#22-onepassword-ro-is-read-only-because-strad-says-so),
where read-only had to become policy when the containers collapsed, this server
can have it be physics as well: because the credential is per slug, a deployment
can seed the `-ro` slug a refresh token consented only for
`https://www.googleapis.com/auth/spreadsheets.readonly`. Google then refuses a
write even if strad somehow did not. The `-rw` slug's token needs the wider
`https://www.googleapis.com/auth/spreadsheets`.

## The tools

Four read:

| Tool | What it does |
| --- | --- |
| `get_spreadsheet` | The map: tabs, their gids and sizes, named ranges. No cell values, so it is cheap on a large file — and it is where A1 tab names come from |
| `get_sheet_values` | One A1 range, rendered as a table addressed with real column letters and row numbers. Takes a tab by gid, so a pasted browser URL is enough |
| `batch_get_sheet_values` | Several ranges in one round trip |
| `find_in_spreadsheet` | Which cells contain a piece of text, as A1 addresses. The Sheets API has no server-side search, so this reads tabs and scans them — name the tabs when you can |

Four write:

| Tool | What it does |
| --- | --- |
| `update_sheet_values` | Overwrite an A1 range. Replaces what is there; nothing shifts |
| `append_sheet_rows` | Insert rows after the end of a table. The safe way to log something |
| `clear_sheet_values` | Empty a range, keeping its formatting |
| `add_sheet` | Add a tab |

There is no tool that deletes a tab, and none that creates or deletes a
spreadsheet **file**. Adding is recoverable and those are not, and a file-level
operation would need Drive scopes this server does not ask for.

Reads are capped and say when they truncate — a retirement model is tens of
thousands of cells, and a whole-tab read that silently returned a prefix would be
worse than one that says it stopped.

## What a human has to do before any of this works

None of it can be done by an agent. The first two steps are in the Google Cloud
console; the rest happen in strad's own.

1. **Enable the Google Sheets API** on the GCP project behind the OAuth client.
2. **Configure the OAuth consent screen** with the Sheets scope, add each Google
   account as a **test user** while the app is unverified, and register strad's
   exact redirect URI — `https://<your gateway>/ui/oauth/callback`. Staging and
   production are different URIs; both need registering.
3. **Seed the client id and secret** for each slug, under that slug's own
   namespace:

   ```text
   /strad/{env}/mcp/<slug>/static/GOOGLE_SHEETS_OAUTH_CLIENT_ID
   /strad/{env}/mcp/<slug>/static/GOOGLE_SHEETS_OAUTH_CLIENT_SECRET
   ```

4. **Click Connect Google** on `/ui/<slug>` in strad's console, once per slug, and
   consent as the account that slug is pinned to. strad writes the refresh token
   into the third parameter itself — see [Connectors](/operate/connectors/).

The refresh token never passes through a human's hands, a shell, or an agent.

Until a slug is connected the mount lists its tools and every call fails naming
what is absent. That is the designed state, not a broken one — and it is what
makes step 4 possible, because the slug has to be deployed before its console page
exists. Step 3 is therefore load-bearing twice over: the two variables it seeds
are the credential's OAuth half **and** the only thing that tells the bundle to
mount the slug at all.

### When it stops working

Google expires a refresh token from an app still in "testing" after seven days,
and revokes on a password change or a withdrawn consent. The server reports
`invalid_grant` and tells you to re-consent; **Reconnect Google** on that slug's
console page is where you do it. It rotates the stored credential, and a failed
attempt leaves the previous one in place.

## Non-native files are invisible to this API

A native Google Sheet's file id is 44 characters. A **binary uploaded to Drive** —
an `.xlsx` or `.csv` — gets a shorter id (around 33) and opens perfectly well in
the Sheets UI, but the Sheets API cannot read it at all: every call returns
`400 FAILED_PRECONDITION`, with a message that says nothing about file types and
reads exactly like a broken mount.

The server turns that response into a recovery hint. The fix is a human one:
open the file in Sheets and use **File → Save as Google Sheets**, which mints a
new, native, 44-character id.
