# slack — a fork, not a vendor copy

Everything else under `servers/bundle-api/` lives in `upstream/` and is copied
verbatim: fixes go upstream, then get re-vendored. This directory is the
exception, and it sits in `fork/` so that the difference is visible from the
path.

**Forked from** [`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers)
`experimental/slack/shared`, commit
[`b1f13fedeb9be97ac03514d637a4616f760b6dee`](https://github.com/pulsemcp/mcp-servers/commit/b1f13fedeb9be97ac03514d637a4616f760b6dee)
— the source of the published `slack-workspace-mcp-server` (`com.pulsemcp/slack`)
v0.0.7. At that commit the vendored copy was byte-identical to upstream.

## Why it is forked

Slack's message format is **mrkdwn**, and mrkdwn is not Markdown. It shares
punctuation with Markdown and disagrees about what the punctuation means. The
disagreement that costs something is `~`: a tilde-delimited span is
STRIKETHROUGH.

An agent posting a travel answer in `#general` used `~` as an "approximately"
sign six times in one message — `~750 som`, `~$9`, `~5000-7000 som`, `~$23-34`.
They paired off with each other and struck through large runs of the message.
Nothing errored. `chat.postMessage` accepted the text, returned `ok`, the tool
reported success, and there was no signal at all until a human read the channel.

Upstream's three write tools describe their text parameter as

> Supports Slack markdown formatting: `*bold*`, `_italic_`, `` `code` ``,
> ` ```code blocks``` `, and `<URL|link text>`.

which calls the format markdown — the exact assumption that produces the bug —
and omits the one construct that silently wrecks a message. A description-only
change can fix that, so it is worth having upstream too; it is not worth waiting
for, because the fix has to reach a running server, and this repo owns the one
Tadas's sessions will talk to.

## The delta

Four files, plus one new module. Nothing else differs from upstream, no tool is
renamed, and no tool is added or removed — the surface is still the same nine
tools the `slack` and `slack-readonly` slugs are carved out of.

| File | Change |
| --- | --- |
| `src/mrkdwn.ts` | **New.** The rules as shared strings, a linter for the constructs that render wrong, and the advisory built from it. |
| `src/tools/post-message.ts` | Description leads with the mrkdwn trap; `text` param carries the rules; a successful post appends the advisory. |
| `src/tools/reply-to-thread.ts` | Same three changes. |
| `src/tools/update-message.ts` | Same three changes, plus the 4,000-character `chat.update` cap — which is what made the original message unrepairable. |
| `src/tools/upload-snippet.ts` | Documents the **opposite**: snippet content is a file body, uploaded verbatim, and no mrkdwn applies to it. |

`test/mrkdwn.test.mjs` pins all of it, including the parts a careless re-vendor
would revert.

### Advise, never rewrite

The server does **not** escape or rewrite the caller's text, and a test asserts
that the bytes handed to `chat.postMessage` are the bytes the caller passed.

`~`, `**` and `[text](url)` all have legitimate uses in a Slack message. A server
that silently edits the words a caller chose fails in exactly the way this fork
exists to prevent — quietly, with a success result — and it fails in a way the
caller cannot detect by reading the response. So the check runs after the send
and reports. Verbatim output of `mrkdwnAdvisory()` over an excerpt of the message
that started this, quoted from a real run rather than written by hand:

```
⚠️ Slack mrkdwn warning: this posted successfully, but Slack does NOT render
it the way it was written. mrkdwn is not Markdown.

• 3 tilde pair(s) — Slack has STRUCK THROUGH the text between each pair
    "750 som each ("
    "500 som pp, or 2000–3000 som ("
    "5000-7000 som for a 4x4; Naryn cars run"
  mrkdwn has no backslash escape: write "approx." or "≈", or wrap the value in `backticks`.

To repair: slack_update_message with channel_id "C0BG98BRH7U" and message_ts "1786453389.428549". Note that chat.update caps text at 4,000 characters — a message long enough to post is not always short enough to edit.
```

Each quoted span ENDS at the closing tilde, which is why they read as fragments:
that is exactly the run of text Slack ate. `test/mrkdwn.test.mjs` pins the first
one character-for-character.

An advisory is the only in-band signal available: the message has already
posted, which is the whole shape of the failure.

### What the linter deliberately does not report

- **Underscore italics.** `_` pairs the way `~` does, so `snake_case_name` really
  can come out italicised. But identifiers, paths and filenames carry underscores
  constantly, and a rule that fires on all of them teaches a reader to skip the
  advisory. The rule is stated in the tool description, where it costs nothing.
- **Anything inside `` ` `` or ` ``` `.** Slack resolves code spans before the
  inline delimiters, so a tilde in there is literal. Two tildes separated *only*
  by a code span still pair up, and still get reported.

## Re-vendoring

There is no sync script and no drift test here, because the point of `fork/` is
that it **has** drifted. To pick up upstream changes, diff
`experimental/slack/shared/src` at the new commit against this tree, apply what
is relevant by hand, re-run `npm test`, and update the commit recorded above. The
tests are the guard rail: they fail if a re-vendor drops the delta.
