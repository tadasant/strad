# Telegram MCP server

strad's Telegram server reads chats and message history **as a person's own
Telegram account**, over MTProto. It lists the chats the account belongs to,
reads a group's history, searches inside a chat, and — on the read-write slug
only — sends a message.

## Why not the Bot API

The requirement this server exists for is reading a group that Tadas **joined and
does not administer**. A bot cannot do that, at any setting:

- The Bot API delivers a bot only messages sent **after** it was added. There is
  no method to fetch a chat's earlier history.
- A bot in a group runs with **privacy mode** on by default, so it receives only
  messages that address it (commands, replies, @mentions). Turning privacy mode
  off is a change to the bot; a **non-admin** bot still sees nothing from before
  it joined.
- A bot that is a group **admin** sees everything — but making a bot an admin of
  someone else's group is not something a member can do.

MTProto with a **user session** is the only protocol that answers the
requirement. That is why the credential below is a login rather than a token,
and why the security section is the longest one in this file.

## Tools

| Tool               | Group     | What it does                                                        |
| ------------------ | --------- | ------------------------------------------------------------------- |
| `get_me`           | readonly  | The account this server acts as                                     |
| `list_chats`       | readonly  | Chats the account belongs to, filterable by kind and title          |
| `get_chat`         | readonly  | Resolve an id / `@username` / t.me link to the chat it names        |
| `get_chat_history` | readonly  | A chat's messages, oldest first, paged backwards via `offset_id`    |
| `search_messages`  | readonly  | Full-text search **inside one chat**, server-side                   |
| `send_message`     | readwrite | Post to a chat **as the account itself**                            |

Message results carry the sender, the timestamp, the reply-to id, and a `media`
field naming the KIND of any attachment (`photo`, `document`, `poll`, …). This
server never returns file contents.

`search_messages` requires a `chat`. Telegram also offers an account-wide
search, and it is deliberately not exposed: a query that sweeps every private
conversation the account has is a far larger read than the one an agent asking
about a group actually wants.

## The two slugs

Capability is enforced by the strad gateway's per-slug `tools:` policy, not by a
container variable — one mount runs at full capability and strad decides, per
slug and per call, what may run. A withheld tool is refused with `-32600` before
it reaches this server.

| Slug          | `tools: allow`                                                          |
| ------------- | ----------------------------------------------------------------------- |
| `telegram-ro` | `get_me`, `list_chats`, `get_chat`, `get_chat_history`, `search_messages` |
| `telegram-rw` | _(no policy — all six, `send_message` included)_                        |

`telegram-ro` is the tier to hand out. A message sent by `telegram-rw` is
indistinguishable from one the person typed: same account, same name, no marker
anywhere that software sent it. Telegram allows the sender to delete a message
for 48 hours, and nothing after that.

`test/telegram.policy.test.ts` in the repo root proves the split against a real
gateway: a `send_message` call on `telegram-ro` is refused, and the upstream's
call counter does not move.

## Credentials

Three environment variables. All three must be present; the server reports the
missing ones by name and fails every call until they arrive.

| Variable                  | What it is                                             |
| ------------------------- | ------------------------------------------------------ |
| `TELEGRAM_API_ID`         | Numeric app id from <https://my.telegram.org>          |
| `TELEGRAM_API_HASH`       | App hash from the same page. Secret.                   |
| `TELEGRAM_STRING_SESSION` | A logged-in user session. **Equivalent to the account.** |

### Getting the api id and hash

<https://my.telegram.org> → API development tools → create an application. The
id and hash belong to the *application*, not to a chat, and one pair is enough
for every deployment.

### Minting the session string

Run this **once**, on a trusted machine, signed in as the account that is in the
group. It asks for a phone number, the code Telegram sends, and the 2FA password
if one is set.

```js
// node mint-session.mjs   (in a scratch directory: npm i telegram input)
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const client = new TelegramClient(
  new StringSession(""),
  Number(process.env.TELEGRAM_API_ID),
  process.env.TELEGRAM_API_HASH,
  { connectionRetries: 3 },
);

await client.start({
  phoneNumber: () => input.text("phone (+15551234567): "),
  password: () => input.text("2FA password: "),
  phoneCode: () => input.text("code Telegram just sent: "),
  onError: console.error,
});

console.log(client.session.save()); // paste this into the secret store, nowhere else
await client.disconnect();
```

The printed string is the credential. Put it straight into the secret store
(`/ui/secrets`, or `secrets-sync.yml` for staging). Do not paste it into a
commit, an issue, a PR, a chat message or a log line.

### What the session string can do

Everything the account can. It reads every private conversation, sends as that
person, and does not expire. It is revoked from a Telegram client under
**Settings → Devices → terminate session**, and revoking it is the only way to
take it back — this server has no scope to narrow.

That is the honest cost of the requirement: reading a group you are a member of
but do not administer means holding a credential that is the whole account.

## strad bundle mount

The bundle host mounts this server at `/telegram` from
`servers/telegram/shared/build/index.js`. It mounts **even with no credentials**,
marked `degraded` on `/healthz`: the tool surface still lists, so the console and
an agent can see what the deployment would offer, and every call fails with an
error naming the three variables. One server's missing config must not cost the
other nineteen their boot.

In `infra/strad.staging.yaml` both slugs ship `enabled: false` until the three
secrets are seeded — an unresolved `${REF}` fails the render, deliberately.
Seeding them and deleting the two `enabled:` lines is the whole of turning this
on.

## The MTProto library

`telegram` — GramJS. It is what mints the session string this server consumes,
and its `StringSession` is that string's format.

It is also **archived upstream** (last release February 2025); the maintained
fork is [`teleproto`](https://www.npmjs.com/package/teleproto), which is
API-compatible and reads the same session strings. This server keeps the library
behind one function — `createMtprotoClient` in `shared/src/mtproto.ts` — so the
swap is a change to that function and nothing else. Everything above it drives a
structural `MtprotoClient` interface that the tests implement directly. See
`HACKS.md` #49.

## Tests

```
cd servers/telegram && npm test
```

22 tests over a fake MTProto client, under Vitest against the TypeScript
sources, run on every PR by the `telegram` CI job: the group-history read that is
the whole requirement, paging and its cursor, the dialog-scan fallback for an id
whose access hash the session has not learned, the id collision between a user
and a supergroup (the fake resolves numeric peers by SIGN, the way the real
client does, so a wrong-chat write cannot pass), the `t.me/c/` and invite-link
forms, refusal of an unknown `kinds` filter, Telegram's classified failures, the
read-only tier withholding `send_message`, and the no-credentials path. Every
identifier in the fixtures is invented — no real account, group or name appears
in this repo.
