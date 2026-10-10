# gmail-shared — what this fork changes, and why

Forked from **`pulsemcp/mcp-servers` `experimental/gmail/shared`** at
**`0ed34de5c42a93317a7d1f7413264102db7d0257`**, the commit this tree was last
verified identical to (`diff -rq` of `src/`, 0 entries, 2026-10-09). That is not
a commit that touched the server.

It is a fork, not a vendor copy. strad owns this code and changes land here. Do
not re-vendor over it: a copy of upstream `src/` reverts every delta below
without a single failing build, and only the tests named under each delta would
notice.

## Why it stopped being a vendor copy

Until this fork the tree was copied verbatim, and strad's own needs lived around
it rather than in it: `src/gmail.ts` (one mailbox per mount) and `src/confirm.ts`
(the per-call confirmation channel), both at the image root. Those still live
there, and still should. They wrap the tree rather than change it, so they never
needed the tree to move.

Attachments are different. They change the MIME the tree builds and the request
it sends, and there is no seam outside the tree to do that from. The first
attempt took them upstream
([pulsemcp/mcp-servers#683](https://github.com/pulsemcp/mcp-servers/pull/683))
to re-vendor afterwards, and that route was declined: strad's servers are
improved here, iteratively, in strad. So the tree is strad's, and the next
delta goes in the same way.

---

## 1. `send_email` and `upsert_draft_email` take attachments

**Upstream.** Both tools build a single-part `text/plain` or `text/html`
message, or `multipart/alternative` when both bodies are given. There is no way
to attach a file.

**Here.** Both tools take an optional `attachments` array, at most 10 items.
Each item gives exactly one of:

- `url`: an HTTPS URL the server downloads, such as a signed artifact-store
  link. A remote agent shares no filesystem with this server, so a local path is
  not an option.
- `content_base64`: the bytes as standard base64, with a required `filename`.

`filename` defaults to the URL's last path segment. `mime_type` defaults to the
response's `Content-Type`, then a guess from the extension, then
`application/octet-stream`. A generic `Content-Type` such as
`application/octet-stream`, which object stores often serve, falls through to
the guess.

With attachments, the message is `multipart/mixed`: the body entity first (the
same single part or `multipart/alternative` as before), then one base64 part per
file, wrapped at 76 characters. A non-ASCII filename is sent as RFC 2047
encoded-words inside the quoted parameter, the form Gmail itself emits, folded
into short lines. Every filename has its control characters, Unicode line
separators, bidi overrides, `"` and `\` replaced with `_`, and is held to 255
characters, keeping the extension; the prompt, the MIME and the tool's answer
all show that one name. Without attachments the message is
byte-for-byte what upstream builds.

- **Limits.** 17 MB decoded across all attachments. Gmail refuses a message
  over 25 MB, and base64 with a CRLF every 76 characters inflates by ~1.37,
  so 17 MB leaves room for the body. Every download in one call shares a
  single 60-second budget, DNS lookups and redirects included.
- **What a URL may reach.** `https:` only, on every hop. Redirects are followed
  by hand, at most 5, and each hop is checked before it is requested: a
  private literal (loopback, RFC 1918, CGNAT, link-local, multicast, and the
  IPv6 forms that carry them, checked with `node:net`'s `BlockList`),
  `localhost`, `*.internal`, and a name ANY of whose resolved addresses is
  private are all refused. The fetch resolves the name again, so DNS rebinding
  between the two lookups is not caught (`HACKS.md` #117).
- **When it is resolved.** Before the confirmation prompt, on `send_email`. Bad
  input fails without asking anyone, and the prompt lists the filenames, types
  and sizes that will actually go out. `from_draft_id` with `attachments` is
  refused: the draft carries its own, and `images/bundle-google/src/confirm.ts`
  lists those in the prompt.
- **Large messages.** A raw message over 5 MB is sent through Gmail's upload URI
  (`/upload/gmail/v1/…?uploadType=multipart`) rather than as inline JSON.
  `images/bundle-google/src/confirm.ts` gates sends by URL, and the upload URI
  still matches it.
- **Updating a draft replaces its attachments.** Gmail's draft update is a full
  replace, so a draft keeps only the attachments the update names.

**Files.** `src/utils/attachments.ts` (new),
`src/gmail-client/lib/raw-message-request.ts` (new),
`src/gmail-client/lib/mime-utils.ts`, `src/gmail-client/lib/send-message.ts`,
`src/gmail-client/lib/drafts.ts`, `src/server.ts`, `src/index.ts`,
`src/tools/send-email.ts`, `src/tools/draft-email.ts`.

**Tests.** `images/bundle-google/test/gmail-attachments.test.ts` for the MIME,
the validation, the download rules (with DNS stubbed) and both tools. In
`images/bundle-google/test/confirm.test.ts`, the two tests that name the
upload URI hold the send gate to it, and one holds a draft send's prompt to
the draft's attachment names.

**Source.** Ported from `pulsemcp/mcp-servers` commit `8eeb47f` (branch
`tadasant/gmail-send-attachments`, the closed PR above), which was written
against the same `0ed34de` base. The `shared/src` diff applied without change;
strad's review then added the resolved-address check, the `BlockList`, the one
download budget, filename sanitizing, the 17 MB cap, and the `from_draft_id`
refusal.

---

## 2. Sent mail and drafts carry the sender's display name

**Upstream.** Every message the tree composes starts `From: <address>`, where
the address is the impersonated user or the OAuth account's profile email.
Gmail sends that header as written. It does not add the account's name to a
bare address, so the recipient sees `zimmer@tadasant.com` and no name, however
the account is named.

**Here.** Before it composes a message, the client reads the account's send-as
settings (`GET users/me/settings/sendAs`, which needs `gmail.readonly`,
`gmail.modify` or `gmail.settings.basic`; a credential holding only
`gmail.send` or `gmail.compose` cannot read it and sends from the bare
address). It takes the `displayName` of the entry whose address matches
the sender, and writes `From: "Display Name" <address>`. The name is the one in
Gmail's settings (Settings → Accounts → Send mail as → edit info), so it is
changed there and not in strad.

- **Quoting.** An ASCII name is an RFC 5322 quoted-string, with `"` and `\`
  escaped. An apostrophe (`Tadas's Assistant`) and a comma need no escaping
  inside the quotes. A non-ASCII name is sent as RFC 2047 encoded-words,
  unquoted and folded, with the address on its own folded line. Control
  characters, Unicode line separators and bidi overrides become spaces, so a
  name cannot inject a header or reorder how it renders. A name is held to 200
  characters.
- **Only the sender's own entry.** Another address's name, even the primary
  one's, is never borrowed. No matching entry, or one with an empty name, means
  the bare address, which is what upstream sends.
- **Cached for 10 minutes per client**, so a rename lands without a restart.
- **A failed lookup costs the name, not the message.** The lookup gives up after
  5 seconds. The message goes out from the bare address, the failure is logged
  to stderr, and the lookup is skipped for a minute before it is tried again.
- **Covers** `send_email` (replies included), `upsert_draft_email` (create and
  update), and so a draft later sent with `from_draft_id`, since a draft keeps the
  `From` it was written with.

**Files.** `src/gmail-client/lib/send-as.ts` (new),
`src/gmail-client/lib/mime-utils.ts` (`formatFromHeader`), `src/server.ts`
(`getFromHeader`).

**Tests.** `images/bundle-google/test/gmail-from-name.test.ts`, covering the
quoting (the apostrophe case included), the encoded-words, the injection guard,
the length cap, the send-as match, the timeout, the retry window, and the real OAuth client's send, reply, draft create and
draft update against a stubbed Gmail. It has run against stubs only. No message
was sent to test it.
