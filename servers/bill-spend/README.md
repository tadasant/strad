# BILL Spend & Expense MCP server

strad's server for **re-coding card transactions** in BILL Spend & Expense: read
the custom fields a company tags transactions with, read the values those fields
can take, read the transactions, and change one transaction's coding — verifying
the change actually landed before reporting success.

It is a first-party server rather than an adopted one for a reason that is
stated up front in the security section: the credential is unscoped admin, and
the tool surface is the only boundary there is.

## The product, and the one that looks like it

This is **BILL Spend & Expense** (formerly Divvy). It is not the AP/AR
"Bill.com" API. They share a gateway hostname and nothing else — separate
products, separate credentials, separate auth schemes.

| | Spend & Expense (this server) | AP/AR |
| --- | --- | --- |
| Base URL | `https://gateway.{stage,prod}.bill.com/connect/v3/spend` | `…/connect/v3` |
| Auth | one header, `apiToken` | `sessionId` + `devKey` |
| Chart of accounts | custom-field **values** | `/v3/classifications/*` |

If you find yourself wiring four credentials, or reading about
`/v3/classifications/*`, you are on the other API. Those classification
endpoints are the easiest wrong turn available here: they look exactly like the
chart of accounts and this token cannot reach them.

## How GL coding is actually modelled

**There is no `glAccount` field on a Spend & Expense transaction.** There is no
`chartOfAccounts` endpoint this token can call, and no `category`. Coding is
carried in `customFields`, and when an accounting integration is connected BILL
pulls the chart of accounts in as custom-field **values**. So "Internet/Phone" is
a value on some custom field, and re-coding a transaction means selecting a
different value on that field.

Which field that is differs per company, and BILL will not say. The `type` enum
has exactly two members — `CUSTOM_SELECTOR` and `NOTE` — there is no
`GL_ACCOUNT`, and nothing in the payload marks a field as having come from an
accounting integration. `list_coding_fields` therefore returns a
`likely_coding_field` flag derived from the field's NAME, labelled as the guess
it is. Confirm it by looking at the field's values.

What a value carries is also less than you would hope: `{uuid, value, deleted,
id}` and nothing else. No account number, no account type, no link back to the
QuickBooks or NetSuite account it was imported from. A merchant can be mapped to
a label; the account structure cannot be reasoned about, because it is not there.

## Tools

| Tool | Group | What it does |
| --- | --- | --- |
| `list_coding_fields` | readonly | The custom fields this company tags transactions with |
| `list_coding_options` | readonly | One field's legal values — the chart of accounts. **Returns the base64 `id` beside the `uuid`** |
| `list_transactions` | readonly | Transactions, filterable by `updated_after` for an incremental sweep; surfaces `is_locked` and current coding |
| `get_transaction_coding` | readonly | One transaction's full coding, both identifier forms, and whether it is writable |
| `set_transaction_coding` | **readwrite** | Change one transaction's coding — read back and diffed before it reports success |

### What is deliberately absent

The apiToken is **unscoped ADMIN**. The same secret that re-codes a transaction
can issue a virtual card, freeze one, create and move budgets, and manage users.
BILL offers no read-only token and no way to narrow one, so **the tool surface is
the only boundary between an agent and a new virtual card.**

Nothing here issues, freezes or reorders a card. Nothing creates or moves a
budget. Nothing touches users, reimbursements or bank accounts. That is why this
server exists at all rather than adopting one of the two community servers —
`tbarsness/billcom-spend-mcp-server` exposes `create_virtual_card` and
`freeze_card`; `civicteam/bill-mcp-server` is read-only but has no custom-field
support, which is the entire job. There is no official BILL MCP server.

Adding a tool here is a decision about that boundary, not a feature.
`test/config.test.ts` asserts that no tool name mentions a card, a budget, a
user, a reimbursement, a bank or funding.

## ⚠️ The write can report success and change nothing

`PUT /v3/spend/transactions/{id}/custom-fields` can answer **HTTP 200
`{"status":"SUCCESS"}` and discard the update.** For an unattended agent working
on someone's books this is the worst failure mode available: forty transactions
reported re-coded, none of them changed.

That is measured, not inferred. Sent to a live sandbox company: two values on a
single-select field come back `200 SUCCESS` with **one of them stored and the
other silently gone.**

So this server does not trust the reply. `shared/src/wire.ts` holds the body
shapes it knows how to send, best first, and `setTransactionCoding` walks that
ladder, **re-reading the transaction after every attempt and diffing it**.
Nothing decides a write succeeded except the read-back. A result carries
`verified: true` and the `wire_variant` that actually persisted; when nothing
persists, the tool fails with `persisted: false` and the full attempt table —
per shape, what BILL answered and what the transaction looked like afterwards.

Everything else about the write follows from that:

- **Ids, not names.** `set_transaction_coding` takes value ids from
  `list_coding_options`. A name would have to be resolved somewhere, and a silent
  resolution is how the wrong identifier form gets sent.
- **Ids are resolved against the field's own catalog first**, so an id belonging
  to a different field is refused by name before a PUT is sent. That is the
  likeliest real cause of a write BILL accepts and drops.
- **A locked transaction is refused without a write attempt.** "You cannot
  update custom fields in a locked transaction" is documented, the check is one
  GET, and there is no API call that unlocks one — a human does it in the web
  app.
- **An unnecessary write is not sent.** A transaction already carrying exactly
  these values comes back `changed: false`, so re-running a sweep costs reads.
- **The winning shape is memoised** for the life of the process, so a sweep pays
  for the ladder once. The read-back still runs on every write, and a memoised
  shape that stops working simply loses its attempt.
- **`changed` is a diff against the state read before the PUT**, not against the
  state requested. Asking for the state a field is already in satisfies "matches
  what was asked for" vacuously — most easily by writing only a note to a
  `CUSTOM_SELECTOR` field, where BILL stores the values (none) and discards the
  note — and calling that a change would be the same lie one size down.

### Two rungs, and what settled the rest

| Rung | Body | When it writes |
| --- | --- | --- |
| `customFieldId/id` | `{customFieldId: "<base64>", selectedValues: ["<base64>"]}` | The ordinary case — the form `list_coding_options` returns |
| `customFieldId/uuid` | `{customFieldId: "tty_…", selectedValues: ["tvl_…"]}` | When only uuids are on hand, as for a field read out of `list_transactions` |

Both persist. The choice between them is about which identifier forms a caller
holds, not about which one BILL prefers — and two claims that shaped the original
design were settled by calling the endpoint and are gone:

- **`customFieldUuid` is a hard `400 customFieldId: must not be null`.** The
  [Transactions guide](https://developer.bill.com/docs/transaction-management)'s
  worked example does not work; the [API
  reference](https://developer.bill.com/reference/updatetransactioncustomfields)
  is the one that is right.
- **The uuid forms are not silently dropped.** A community field note claimed the
  `tty_…` / `tvl_…` forms BILL's own GETs hand back are *"silently rejected (the
  API returns SUCCESS but the update is dropped)"* and that only the base64 `id`
  form writes. Every uuid form persisted, in both slots, mixed freely.

Neither finding undoes the read-back. It is what caught the single-select case
above, and it is the only thing separating "coded" from "coded as something
else".

## Credentials

Two environment variables; only the first is required.

| Variable | What it is |
| --- | --- |
| `BILL_SPEND_API_TOKEN` | The Spend & Expense API token. Secret, and **unscoped admin on the company**. |
| `BILL_ENVIRONMENT` | `sandbox` (default) or `production`. Picks the gateway host. |

`BILL_ENVIRONMENT` **defaults to sandbox**, and the direction is deliberate: an
unset variable on a deployment meant to be production costs a 401; the other
default would point an unattended agent at real financial records over a missing
line of YAML.

### Getting a token

**Sandbox** — fill in the [Sandbox Access
Form](https://app-dev-bdc-stg.divvy.co/create-sandbox-company). Self-serve, no
approval, instant. It returns an `apiToken`, a `username` (your email) and a
`password`, and creates a **separate empty test company** — not a mirror of any
real data. Sign in to the sandbox web app at
<https://login.stage.us.bill.com/neo/login>.

**Production** — an ADMIN on the Spend & Expense company generates one under **My
account → Settings → Generate new token**. Only ADMIN users can.

Put it straight into the secret store (`/ui/secrets`). Do not paste it into a
commit, an issue, a PR, a chat message or a log line. The client scrubs the
literal value out of every error it constructs, and `redact()` catches
credential-shaped runs at the tool boundary — neither is a reason to be casual
with it.

## Rate limits

**60 calls per token per minute.** Low enough that a sweep reaches it. The client
retries a 429 with exponential backoff, honouring `Retry-After` when BILL sends
one, and then surfaces a typed `RateLimitError` telling the caller to slow down.

A verified write is four to five calls: read the transaction (lock check), read
its coding (the before state and the base64 ids), resolve the field's value
catalog (cached for five minutes), the PUT, and the read-back. Roughly a dozen
transactions a minute. That is the price of not lying about whether a write
landed.

## strad bundle mount

The bundle host mounts this server at `/bill-spend` from
`servers/bill-spend/shared/build/index.js`. It mounts **even with no
credentials**, marked `degraded` on `/healthz`: the tool surface still lists, so
the console and an agent can see what the deployment would offer, and every call
fails with an error naming the variable. One server's missing config must not
cost the other twenty-one their boot.

In `infra/strad.staging.yaml` both slugs ship `enabled: false` until the token is
seeded — an unresolved `${REF}` fails the render, deliberately, and it fails the
WHOLE spec. Seeding `BILL_SPEND_API_TOKEN` in `/strad/staging/gateway/static/`
(the console, `/ui/secrets`), deleting the two `enabled:` lines and adding the
name to `PROVISIONED_STATICS` in `test/staging-config.test.ts` is the whole of
turning this on.

| Slug | `tools: allow` |
| --- | --- |
| `bill-spend-ro` | `list_coding_fields`, `list_coding_options`, `list_transactions`, `get_transaction_coding` |
| `bill-spend-rw` | _(no policy — all five, `set_transaction_coding` included)_ |

`bill-spend-ro` is the tier to hand out. A sweep can be planned, costed and
reviewed on it and cannot change a ledger.

## Tests

```
cd servers/bill-spend && npm test
```

71 tests over a fake BILL company, under Vitest against the TypeScript sources,
run on every PR by the `bill-spend` CI job. The fake is the interesting part: it
answers **200 SUCCESS to every write** and applies only the body shape it has
been told to honour, which is exactly the failure this server is built around. So
the suite covers the shape ladder walking past a silently-dropped write, the
refusal to report BILL's SUCCESS when nothing persisted, a write that moved
nothing being refused the word "changed", the locked transaction refused before
any PUT, a value id from the wrong field refused by name, the empty-array clear,
a field the transaction's budget does not offer, the learned shape being
re-opened when it stops working, the field list staying deduped on an endpoint
that ignores its own `retired` filter, and the filter composition that would
otherwise turn an incremental sweep into a full one.

Every identifier in the fixtures is invented — no real company, transaction,
merchant or account name appears in this repo.

## Verified against a live company

All five tools have been exercised end to end against a real BILL **sandbox**
company through a real MCP client: the custom-field catalog, a field's values,
the transaction list, one transaction's coding, and a re-code that was read back
and diffed. The write persists, the verification is real, and the failure path
fires on a write BILL answers SUCCESS to and half-applies.

Three things the sandbox could not exercise: a **locked** transaction (it seeds
none), the **rate limiter** (60/min was never approached), and — the one that
matters — a **GL field that came from an accounting integration**.

## Open question

**Whether accounting-integration-mapped custom fields are visible through the API
at all** is still not settled, because the sandbox company has no integration
connected and one cannot be connected through this API. What is known, measured:
`GET /v3/spend/custom-fields` takes no origin filter and applies no type gate —
it returns every custom field the company has, so there is no mechanism by which
it could hide one — and the Spend & Expense API has no accounting-integration
endpoint at all (every plausible path 404s). The single-field GET carries no
origin marker either, which is why `likely_coding_field` is a guess about a NAME
and says so.

So a company's GL field should arrive as an ordinary `CUSTOM_SELECTOR`. That is
reasoning, not a measurement: `list_coding_fields` against the production company
is a free read that settles it in one call, and it is the first thing to do
there.
