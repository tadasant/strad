---
title: Slack attachments
description: How a caller reads a file attached to a Slack message through strad.
---

A file attached to a Slack message is the common case where a tool result is the
wrong container for an answer. The bytes may be tens or hundreds of megabytes,
they are usually binary, and the caller is on a different machine from the mount
that can fetch them.

`slack_download_file` therefore returns a **URL, not a file and not a path**.

## What a caller does

```
slack_download_file({ file_id: "F0C14TKKJUR" })
```

```json
{
  "name": "2025 documents.zip",
  "mime_type": "application/zip",
  "size_bytes": 39000000,
  "download_url": "https://strad.tadasant.com/mcp-download/slack-zimmer/eyJ2Ijo…",
  "expires_at": "2026-09-11T02:54:31.562Z",
  "single_use": true,
  "curl": "curl -fSL -o '2025_documents.zip' 'https://strad.tadasant.com/mcp-download/slack-zimmer/eyJ2Ijo…'"
}
```

Run the `curl`. It carries **no header, no token and no API key** — the signature
inside the URL is the whole credential, and an agent session holds no strad key
to present anyway.

The link is **single-use and expires in fifteen minutes**. If it expires, has
already been used, or the transfer dies partway, call the tool again; a fresh
link costs one round trip and nothing else.

## Why strad mints the link rather than passing one through

Slack has no URL that would work. `url_private` and `url_private_download` both
require `Authorization: Bearer <bot token>`, so handing one to a caller would mean
handing over the workspace credential. The only unauthenticated form,
`permalink_public`, is minted by `files.sharedPublicURL` — a **user-token** method
our bot token cannot call, which makes the file public to anyone with the link
until somebody calls `files.revokePublicURL`. Wrong on both counts.

## What the signature covers

The token is an HMAC over the file id, an expiry and a random nonce. Three
properties follow, and each closes a specific hole:

- **One file.** The link authorises one attachment, not the workspace.
- **One use.** The nonce is marked spent once Slack has answered. A GET that
  never produced bytes gives the link back, so a Slack failure does not burn it.
- **One mount.** The gateway slug **and a fingerprint of the mount's bot token**
  are folded into the signing key rather than the payload, so a link minted by
  one mount **fails to verify** at another instead of being honoured somewhere
  confusing.

The key is derived from `STRAD_INTERNAL_TOKEN`, which every bundle component
already holds, so there is no new secret to seed and no step outside a deploy.
The credential is in there because the internal token alone would not separate
two workspaces: strad runs this image twice — `slack` and `slack-readonly`
against one workspace, `slack-zimmer` against another — and **both containers
hold the same internal token**. Binding the credential is what makes them two
trust domains rather than one.

Rotating either token invalidates outstanding links, which at a fifteen-minute
life is not a thing anyone notices.

## Sensitivity and retention

This path was built for a case where both mattered: a zip of tax documents
containing SSNs.

**The bytes are never stored.** There is no bucket and no temporary file. The
mount fetches from Slack on the GET and pipes straight through, so the only copy
that exists outside Slack is the one the caller writes. Nothing has to be cleaned
up afterwards, because nothing was kept.

**The filename is never in the URL.** It travels in `Content-Disposition` on the
response instead. A URL ends up in access logs; a response header does not.

**The token is in the URL path**, so it does reach the edge access log. A
fifteen-minute, single-use link is what keeps that from mattering — and it is why
the expiry is minutes rather than days.

Responses are served `Cache-Control: no-store`.

## Size

The bytes stream end to end — Slack to the mount, the mount to core, core to the
caller — and nothing on the path holds the file. A 39MB archive costs the same
memory as a 39KB screenshot.

The bound is silence, not size: a transfer is abandoned only if it **stops
moving** for the upstream timeout, so an artifact of any size arrives as long as
it keeps flowing. A failure partway destroys the connection rather than ending it
cleanly, so a truncated file is reported as a failed transfer instead of arriving
as a short one that looks complete.

## Configuration

One variable, on the component serving the mount:

| Variable            | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `SLACK_PUBLIC_SLUG` | The **gateway** slug this container's `/slack` mount is served as |

It defaults to `slack`, which is right wherever the slug and the mount path are
the same word. It has to be set where they differ — prod's `slack-zimmer` runs
alone on its own component at `path: /slack`, so that component sets
`SLACK_PUBLIC_SLUG: slack-zimmer`.

Leaving it unset where it is needed misaddresses every link that mount hands
out — they name the other container. That is a broken download either way, but it
breaks cleanly: the container receiving a link it did not sign refuses it with a
`403`, rather than accepting it and then failing obscurely against a file id its
workspace has never held.

It is **per container, not per slug**, because the mount is. Where sibling slugs
share one — prod and staging both serve `slack` and `slack-readonly` off the same
mount — every link names the one slug configured there, whichever sibling the
caller selected. They reach the same container against the same workspace, so the
link works either way; the slug in the URL is a routing address, not a statement
about who called.

If `STRAD_PUBLIC_URL`, `STRAD_INTERNAL_TOKEN` or `SLACK_BOT_TOKEN` is absent —
this image running outside a strad deployment, or a mount with no credential —
the tool says attachments cannot be served rather than minting a URL nothing
answers. The boot log names which one was missing.
