# slack — a fork, not a vendor copy

Everything under `servers/bundle-api/upstream/` is copied verbatim: fixes go
upstream, then get re-vendored. This directory is one of three exceptions, and
it sits in `fork/` so that the difference is visible from the path.

**Forked from** [`pulsemcp/mcp-servers`](https://github.com/pulsemcp/mcp-servers)
`experimental/slack/shared`, commit
[`b1f13fedeb9be97ac03514d637a4616f760b6dee`](https://github.com/pulsemcp/mcp-servers/commit/b1f13fedeb9be97ac03514d637a4616f760b6dee)
— the source of the published `slack-workspace-mcp-server` (`com.pulsemcp/slack`)
v0.0.7. At that commit the vendored copy was byte-identical to upstream.

## Why it is forked

Two reasons, in the order they arrived: the message format upstream describes
wrongly, and the conversation type upstream cannot address at all.

### 1. mrkdwn is not Markdown

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

#### The mrkdwn delta

Four files, plus one new module. No tool is renamed and none is removed.

| File | Change |
| --- | --- |
| `src/mrkdwn.ts` | **New.** The rules as shared strings, a linter for the constructs that render wrong, and the advisory built from it. |
| `src/tools/post-message.ts` | Description leads with the mrkdwn trap; `text` param carries the rules; a successful post appends the advisory. |
| `src/tools/reply-to-thread.ts` | Same three changes. |
| `src/tools/update-message.ts` | Same three changes, plus the 4,000-character `chat.update` cap — which is what made the original message unrepairable. |
| `src/tools/upload-snippet.ts` | Documents the **opposite**: snippet content is a file body, uploaded verbatim, and no mrkdwn applies to it. |

`test/mrkdwn.test.ts` pins all of it, including the parts a careless re-vendor
would revert.

#### Advise, never rewrite

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
that is exactly the run of text Slack ate. `test/mrkdwn.test.ts` pins the first
one character-for-character.

An advisory is the only in-band signal available: the message has already
posted, which is the whole shape of the failure.

#### What the linter deliberately does not report

- **Underscore italics.** `_` pairs the way `~` does, so `snake_case_name` really
  can come out italicised. But identifiers, paths and filenames carry underscores
  constantly, and a rule that fires on all of them teaches a reader to skip the
  advisory. The rule is stated in the tool description, where it costs nothing.
- **Anything inside `` ` `` or ` ``` `.** Slack resolves code spans before the
  inline delimiters, so a tilde in there is literal. Two tildes separated *only*
  by a code span still pair up, and still get reported.

### 2. Upstream cannot address a person

Upstream posts to a channel and replies in a thread. It has no tool that opens or
addresses a DM, so "tell Tadas his Claude account needs re-authenticating" had
nowhere to go but a channel — which is the wrong room for a message meant for one
person, and it is the message Zimmer needs to send when an account falls into
`needs_reauth`.

Slack's DM flow is two calls: `conversations.open` with a user ID returns a `D…`
channel, and then it is an ordinary `chat.postMessage`. Exposing those as two
tools would be the faithful translation and the worse surface — a two-step dance
around an intermediate id, for one message. So `slack_send_dm` takes a person and
some text, and the open is an implementation detail.

#### The DM delta

Four tools added, one shared resolver, six client functions. Upstream's nine
tools are untouched.

| File | Change |
| --- | --- |
| `src/tools/send-dm.ts` | **New.** `slack_send_dm` — resolve, open, post, in one call. Carries the mrkdwn rules and advisory, like every other tool that takes text. |
| `src/tools/get-dm.ts` | **New.** `slack_get_dm` — read the conversation with one person, by name or by `D…` id. |
| `src/tools/get-dms.ts` | **New.** `slack_get_dms` — list the DM conversations, most recently active first. |
| `src/tools/find-user.ts` | **New.** `slack_find_user` — turn "who is Tadas" into a user ID, and say why each candidate matched. |
| `src/tools/resolve-user.ts` | **New.** The one place a recipient becomes an id. Not a tool. |
| `src/slack-client/lib/{open-dm,get-dms,list-users,find-users,get-user,lookup-user-by-email}.ts` | **New.** One function per Slack method, in the shape the rest of `lib/` already has. |
| `src/slack-client/lib/slack-error.ts` | **New.** Carries Slack's `needed` scope into the error message. |
| `src/server.ts`, `src/types.ts`, `src/tools.ts`, `src/slack-client/slack-client.integration-mock.ts` | The interface, the shapes, the registration table, the mock. |

`test/dm.test.ts` pins it.

#### Naming a recipient

One parameter, four forms: a user ID (`U0BFTSUN8MD`), an email address, a handle
with or without the `@`, or a display or real name. Matching is
case-insensitive, exact beats prefix beats substring, and — as the tie-break —
a hit on a handle beats one on a display name beats one on a real name beats one
on an email.

**That second half is load-bearing.** Ranking on closeness alone lets a weak
field win on a technicality: `annoy-bot` is a prefix match for "ann" and the
Joanna whose real name contains it is only a substring match, so a comparison
that ignores WHICH field matched hands the DM to the bot and reports no
ambiguity at all.

**A recipient that is not decisively one person is an error, never a guess.** It
comes back naming the candidates with their IDs and sends nothing. Three things
count as not decisive, and each one refuses:

- a rival as close as the winner. What counts as a rival depends on how strong
  the win is: an EXACT hit is a real claim to be the person named, so only
  another exact hit on the same field ties it — but a prefix or substring hit is
  not a claim, it is a coincidence of letters, so at those ranks any
  equally-close candidate is a rival whatever field it matched on. That is the
  `annoy-bot` case: preferring the handle there would DM a bot on a technicality;
- a non-exact winner found while the directory listing was truncated, because
  the better match may sit on a page that was never read;
- a resolved account that is deactivated (`users.info` and `users.lookupByEmail`
  both return those; `users.list` does not).

This is the one place where the cheaper behaviour — take the best-sorted match —
is unacceptable. A channel post to the wrong room is embarrassing; a private
message to the wrong person is not walkable back.

The id form is `^[UW][A-Z0-9]{7,}$`, case-SENSITIVE and length-bounded, and both
halves matter: a looser `^[UW][A-Z0-9]{2,}$/i` also matches "will", "wes" and
"una" — ordinary handles this very parameter invites — and routes them down the
id path, where they resolve to a fabricated id and die at the send on a Slack
error naming nothing the caller wrote. An id that Slack answers `user_not_found`
for is refused rather than passed on; an id the directory merely could not be
READ for still sends, with the result line saying the identity is unverified.

The cost of the friendlier identifier is a directory scan (`users.list`,
paginated, filtered here — Slack has no server-side user search) and the
`users:read` scope. An email skips it via `users.lookupByEmail`, and a user ID
skips it entirely.

#### Scopes, and the one that is missing

The DM calls are gated on scopes the channel tools never needed:

| Call | Scope |
| --- | --- |
| `conversations.open` | `im:write` |
| `conversations.list?types=im` | `im:read` |
| `conversations.list?types=im,mpim` | `im:read` **and** `mpim:read` |
| `conversations.history` on a `D…` | `im:history` |
| `users.list`, `users.info` | `users:read` |
| `users.lookupByEmail` | `users:read.email` |
| `chat.postMessage` to a `D…` | `chat:write` — already held |

The token installed on the Tadasant workspace holds `im:history`, `im:read`,
`users:read` and `chat:write`, and NOT `im:write`, `mpim:read` or
`users:read.email`.

So `openDm()` treats a refusal to OPEN (`missing_scope`, `not_allowed_token_type`,
`restricted_action`) as a reason to look rather than a reason to stop: it scans
the DMs that are already open and uses the one for that user. A token that can
list an existing DM and post into it can send the message, and refusing would be
refusing work it can plainly do. The scan cannot conjure a FIRST conversation, so
when there is none the error repeats the scope Slack itself named and gives the
other way out — the recipient DMs the bot once, which opens the conversation from
their side. `HACKS.md` #59 is the whole picture.

Every one of these scans is page-capped, and a cap that stops early is reported
rather than swallowed. "No DM exists with this person" and "I stopped looking"
are different answers, and only one of them should make a caller believe a
conversation is absent — so `findDmChannel` throws instead of returning null, and
`slack_find_user` says the directory was larger than it read.

Group DMs are opt-in (`include_group_dms`, default false) for the same reason
from the other end: `mpim:read` is a second scope, and Slack fails the WHOLE
`types=im,mpim` listing without it. Defaulting it on would turn every DM listing
into an error on a token that can list one-to-one DMs perfectly well.

#### Which tier the tools land in

`slack_send_dm` is a write tool. `slack_get_dm`, `slack_get_dms` and
`slack_find_user` are read-only, and `slack_get_dm` is built so that stays true:
it resolves an EXISTING conversation with `conversations.list` rather than
calling `conversations.open`, which would create one. A read-only tier that
leaves a new row in someone's sidebar is not read-only. The `slack-readonly`
slug's allow-list in `infra/strad.staging.yaml` names all three.

## Re-vendoring

There is no sync script and no drift test here, because the point of `fork/` is
that it **has** drifted. To pick up upstream changes, diff
`experimental/slack/shared/src` at the new commit against this tree, apply what
is relevant by hand, re-run `npm test`, and update the commit recorded above. The
tests are the guard rail: they fail if a re-vendor drops the delta.
