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
all show that one name. Without attachments the message has the
same structure upstream builds (deltas 2 and 3 change its `From:` header
and its body encoding).

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

---

## 3. Plain-text bodies are reflowed and sent with an HTML rendering, and every text part is quoted-printable

**Upstream.** The body is sent exactly as given, in a part with no
`Content-Transfer-Encoding`. Agents hard-wrap prose at 72-80 columns, and a
`text/plain` part without `format=flowed` shows each of those newlines as a
hard break: on a phone every wrapped line wraps once more, and a paragraph
reads as alternating long and two-word lines. A paragraph that is NOT wrapped
goes out as one line of any length, past RFC 5322's 998-octet limit if it is
long enough, which a relay is free to fold.

**Here.** `src/gmail-client/lib/body-text.ts` (new), called from
`buildBodyEntity` in `src/gmail-client/lib/mime-utils.ts`:

- `reflowPlainText` joins the lines of a `plaintext_body` paragraph that were
  cut by a wrap: a line is joined onto the one before only when that one is at
  least 40 characters, the block's widest line is between 50 and 100, and the
  next line's first word would not have fit after it, and the line before does
  not end in a colon. Blank lines, list items (a wrapped item's continuation is
  joined into the item), `>` quotes, headings, `|` table rows, rules, bare
  URLs, label rows (`Status: merged`), sign-offs (`Best regards,`), `P.S.`
  lines, indented lines outside a list, fenced code and everything below a
  `-- ` signature separator are kept as written. `html_body` is never
  reflowed.
- `encodeQuotedPrintable` sends every text part, plain and HTML,
  `Content-Transfer-Encoding: quoted-printable`. Lines on the wire stay within
  76 characters, and a soft break never splits one character's bytes; the
  soft breaks disappear when the recipient decodes, so a
  paragraph stays one logical line.
- A `plaintext_body` sent without an `html_body` goes out as
  `multipart/alternative`: the reflowed text, and `plainTextToHtml` of it.
  Gmail lays out a `text/plain`-only message at about 70 columns of its own,
  with a hard break at each, whatever the line on the wire was, and it ignores
  `format=flowed`; the reflow alone could not fix that. On 2026-10-16 a reply
  whose Sent copy held each paragraph on one line reached Gmail's app with a
  break every ~70 columns, and the quote in the answer to it carried those
  breaks as `<br>`. The HTML rendering escapes the text, keeps each of its
  line breaks as a `<br>` and each indent as `&nbsp;`, and links bare
  `http(s)` URLs with the URL as their text, so the two parts say the same
  thing. A caller's own `html_body` is sent as given and nothing is generated.
- The `send_email` and `upsert_draft_email` descriptions ask callers to write
  each paragraph as one line, and to put links in `html_body` as anchors with
  descriptive text, beside a matching `plaintext_body`.

What the heuristic gets wrong is `HACKS.md` #121.

**Tests.** `images/bundle-google/test/gmail-body-text.test.ts`: the reflow
rules, the HTML rendering, the encoding (wire line lengths and a decode round
trip), the MIME headers for each body shape, the 2026-10-16 reply as a
regression, and the raw message `sendMessage` and
`createDraft` hand Gmail.

---

## 4. `get_email_conversation` returns the headers that say who sent a message

**Upstream.** The tool returns Subject, From, To, Cc, Date, Labels and the
body. `From:` is text the sender wrote, and nothing in the output says whether
the receiving server believed it.

**Here.** A `## Sender Verification Headers` section, placed after the ID,
thread and Gmail URL lines and BEFORE `## Headers`, carries a JSON block:
`headers` is every instance of `Received`, `Authentication-Results`,
`ARC-Authentication-Results`, `Received-SPF`, `DKIM-Signature`, `From`,
`Sender`, `Reply-To`, `Return-Path`, `Message-ID`, `In-Reply-To`,
`References`, `Auto-Submitted` and `List-Id`, in message order, each as
`{ index, name, value }`, where `index` is the header's position in the whole
header list (0 is the topmost) and `name` and `value` are exactly what Gmail
returned. `absent` names the ones the message does not carry. Nothing is
merged, deduped, reordered or reduced to an empty string.

- **Why the order matters.** The receiving server (mx.google.com) prepends its
  `Authentication-Results` above every header the sender wrote, so the topmost
  is its verdict and a lower one may be forged.
- **Why `Received`.** When the receiving server wrote no
  `Authentication-Results`, a sender-written one is the topmost. Only the hop
  trail shows that: Google's sits directly under the `Received` in which
  mx.google.com accepted the message. `HACKS.md` #123.
- **Why before `## Headers`.** Gmail decodes RFC 2047 in header values, so a
  Subject can carry a newline and a whole fake section. Nothing the sender
  controls comes before this one, so the first section in the output is
  always the real one.
- **Why JSON.** `JSON.stringify` keeps a value on one line, so a newline or a
  code fence in a value cannot end the block. C1 controls, format characters
  (zero-width, bidi, tags) and U+2028/U+2029, which it passes through, are
  written as `\u` escapes.
- **Backward compatible.** Every line upstream emits is unchanged; the section
  is added.

What a reader still has to get right is `HACKS.md` #123.

**Files.** `src/utils/sender-verification.ts` (new),
`src/tools/get-email-conversation.ts`.

**Tests.** `images/bundle-google/test/gmail-sender-verification.test.ts`: a
message whose real top `Authentication-Results` fails DMARC above a forged
lower one that passes, a Subject carrying a forged section, a value carrying
newlines, a fence, bidi, C1, zero-width and astral format characters, a
forged `Authentication-Results` with none of Google's above it, the `absent`
list, and upstream's lines unchanged.

---

## 5. Deleting a draft is its own tool, `delete_draft_email`

**Upstream.** A draft is deleted through `upsert_draft_email` with
`delete: true` and a `draft_id`. Nothing in the tool's name says it can
delete, so agents did not find it and asked a person to discard a stale
draft by hand. A tool policy also could not allow drafting without allowing
deletion, since both are one tool. And the `draft_id` went into the request
path as given: `fetch` resolves `..`, so `drafts/../messages/<id>` would have
been a `DELETE` on a message (Gmail refuses that to a `gmail.modify`
credential, which is the only thing that stopped it).

**Here.**

- `delete_draft_email` takes a required `draft_id`. It reads the draft first
  (`GET users/me/drafts/<id>`), and a 404 there, which is what a message ID, a
  thread ID or an already-deleted draft gets, is refused with nothing changed.
  Then it sends `DELETE users/me/drafts/<id>`, Gmail's `users.drafts.delete`,
  and answers with the draft's ID, thread, `To` and `Subject`.
- It deletes the draft and nothing else: no message, no thread, no trash.
  Gmail deletes a draft permanently; it does not go to Trash.
- It is in the `readwrite` and `readwrite_external` groups, beside
  `upsert_draft_email`. `drafts.delete` is authorized by `gmail.modify` or
  `gmail.compose`, which every writing credential already holds, so it needs
  no new scope. It asks no human, the same as `upsert_draft_email`, which can
  already overwrite a draft's whole content.
- `upsert_draft_email` does not take `delete`. It creates and updates, and a
  call that still sends `delete` is refused, naming `delete_draft_email`,
  rather than read as an update.
- Every draft call (`getDraft`, `updateDraft`, `deleteDraft`) refuses an ID
  outside `[A-Za-z0-9_-]` (`DRAFT_ID_PATTERN`) before it builds a URL.

What it costs is `HACKS.md` #130.

**Files.** `src/tools/delete-draft-email.ts` (new), `src/tools.ts`,
`src/tools/draft-email.ts`, `src/tools/list-draft-emails.ts`,
`src/gmail-client/lib/drafts.ts`.

**Tests.** `images/bundle-google/test/gmail-delete-draft.test.ts`: the read
before the delete, the refusal of a non-draft ID with no delete sent, the
traversal guard at every draft call, the exact requests (a `GET` and a
`DELETE` on `/drafts/<id>`), and `upsert_draft_email` without `delete`. The
tool lists in `images/bundle-google/test/gmail.test.ts` and
`images/bundle-google/test/standalone.test.ts` hold the groups. It has run
against stubs only. No draft was deleted to test it.

---

## 6. `download_email_attachments` returns the bytes, and writes nothing to disk

**Upstream.** By default the tool writes every attachment to
`/tmp/gmail-attachments-<email_id>/` on the machine the server runs on and
answers with those paths. `inline=true` returns the content instead, as one
text block: text types decoded, binary types as a base64 code block.

**Why that is a defect here.** strad serves this tool from the bundle
container, and no caller shares its disk. The path the tool answers with
names a file only that container can open, so the default mode returned
nothing usable, and left a copy of the mail on the container. A session asked
for a draft purchase agreement PDF (about 1 MB) and reported that it "wouldn't
download into my session", and a person had to send the file by hand.
`inline=true` did carry the bytes, but as roughly 1.4 MB of base64 text, which
a client has to spill to a file and decode, and the tool's own description
steered callers away from it.

**Here.**

- The default (`inline=false`) answers with a text summary, then one MCP
  embedded resource per attachment, `{ type: "resource", resource: { uri,
  mimeType, blob } }`. A `text/*`, JSON or XML attachment carries `text` in
  place of `blob` when it is valid UTF-8 and at most 100 KB. Any other text
  attachment (a Latin-1 CSV, a large log) goes as a blob, so its bytes are
  kept and it is saved to a file rather than poured into the model's context.
- The `uri` is `gmail-attachment://<email_id>/<index>/<filename>`, each segment
  percent-encoded, with `index` the attachment's position on the email so two
  files with one name stay two resources. It names the attachment and cannot
  be fetched.
- `blob` is canonical padded standard base64. Gmail returns base64url, padded
  or not, and it is re-encoded through `Buffer` rather than character-swapped.
  A missing MIME type is sent as `application/octet-stream`.
- MCP clients that handle binary resources save each blob to a local file.
  Claude Code does, with an extension from the MIME type, and gives the model
  the path. That is how the bytes reach the caller's own disk.
- `inline=true` is unchanged, for a client that ignores embedded resources.
- One call carries at most 25 MB, in both modes, since both carry the bytes
  in the result. Gmail receives messages up to 50 MB, so a single attachment
  over 25 MB cannot be fetched at all.
- Nothing is written to the server's filesystem in either mode.

What it costs is `HACKS.md` #134.

**Files.** `src/tools/download-email-attachments.ts`, `src/tools.ts` (the
`Tool` result type admits a resource block).

**Tests.** `images/bundle-google/test/gmail-download-attachments.test.ts`: a
binary attachment as a blob that decodes to the exact bytes, padded and
unpadded base64url, a text attachment as a text resource, non-UTF-8 and
over-100-KB text as a blob, one resource per attachment and two URIs for two
files with one name, the URI encoding, a missing MIME type, `inline=true`
unchanged, and the 25 MB refusal in the default mode. It has also run end to end: the built tree served over stdio to
an MCP SDK client returned the 989,829-byte PDF that prompted it, the same
SHA-256 as the copy Gmail served.

---

## 7. The draft tools link the account's Drafts folder

**Upstream.** `upsert_draft_email` answers with the draft's ID and "find it in
Gmail's Drafts folder". `list_draft_emails` answers with IDs. Neither names the
account. strad serves several mailboxes behind `/gmail`, so a person handed a
draft had to work out which account it was in, open it, and go to Drafts.

**Here.**

- Both tools answer with `**Drafts folder (<email>):**
  https://mail.google.com/mail/u/?authuser=<email>#drafts` (`buildGmailDraftsUrl`
  in `src/utils/email-helpers.ts`). `upsert_draft_email` also names the
  `**Account:**`. `list_draft_emails` gives the link once, above the drafts.
- The account is the one the client acts as, `getAccountEmail()`: the
  impersonated user for a service account, the profile address for OAuth.
- It is selected by address, never by a `/u/<n>/` index, and the address is
  percent-encoded (`encodeURIComponent`), so a `+` is not read as a space and a
  `#` or `&` cannot end the parameter.
- The link is to the folder, not the draft. Gmail documents no single-draft URL,
  and `#drafts?compose=<message-id>` was not confirmed against a live mailbox
  (`HACKS.md` #142).
- The address is read after the draft is saved. If that read fails, the answer
  carries no link and the draft is still reported as saved, never as an error.
- The tools return text only, with no `structuredContent`, so the link is in
  the text and nowhere else.

**Files.** `src/utils/email-helpers.ts`, `src/tools/draft-email.ts`,
`src/tools/list-draft-emails.ts`.

**Tests.** `images/bundle-google/test/gmail-draft-links.test.ts`: the URL shape
and its encoding (round-tripped through `URL`), both tools on create, update
and list, and a failed account read costing the link and not the draft. Stubs
only; no live mailbox was opened.
