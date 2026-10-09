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
encoded-words, folded so no header line passes 78 characters. Without
attachments the message is byte-for-byte what upstream builds.

- **Limits.** 18 MB decoded across all attachments. Gmail refuses a message
  over 25 MB, and base64 inflates by 4/3. Each download has a 30-second timeout.
- **What a URL may reach.** `https:` only, on every hop. Redirects are followed
  by hand, at most 5, and each hop is checked before it is requested. A literal
  loopback, private, link-local or CGNAT address is refused, as are `localhost`
  and `*.internal`. DNS names are not resolved first, so a public name pointing
  at a private address is not caught here. Inside strad's bundle the components
  talk plain `http` on the private network, which the `https:`-only rule
  refuses.
- **When it is resolved.** Before the confirmation prompt, on `send_email`. Bad
  input fails without asking anyone, and the prompt lists the filenames that
  will actually go out. A `from_draft_id` send ignores `attachments`; the draft
  carries its own.
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
the validation, the download rules and both tools. The two tests in
`images/bundle-google/test/confirm.test.ts` that name the upload URI hold the
send gate to it.

**Source.** Ported from `pulsemcp/mcp-servers` commit `8eeb47f` (branch
`tadasant/gmail-send-attachments`, the closed PR above), which was written
against the same `0ed34de` base. The `shared/src` diff applied without change.
