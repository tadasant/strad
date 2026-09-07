---
title: BILL Spend & Expense
description: How strad re-codes BILL Spend & Expense card transactions, why coding lives in custom fields rather than a GL account field, and why every write is read back before it is reported as successful.
---

Re-code a card transaction in BILL Spend & Expense from an agent: a transaction
lands tagged "Internet/Phone", and the right chart-of-accounts mapping is
something else. That is the whole job, and two facts about BILL's API decide the
entire design of this server.

`bill-spend-ro` and `bill-spend-rw` are strad's own MCP server — source in
`servers/bill-spend/`, mounted at `/bill-spend` inside the bundle image.

## The product, and the one that looks like it

This is **BILL Spend & Expense** (formerly Divvy). It is not the AP/AR
"Bill.com" API. They share a gateway hostname and nothing else.

|                   | Spend & Expense (this server)                                | AP/AR                     |
| ----------------- | ------------------------------------------------------------ | ------------------------- |
| Base URL          | `https://gateway.{stage,prod}.bill.com/connect/v3/spend`     | `…/connect/v3`            |
| Auth              | one header, `apiToken`                                       | `sessionId` + `devKey`    |
| Chart of accounts | custom-field **values**                                      | `/v3/classifications/*`   |

If you find yourself wiring four credentials, you are on the other API. Its
`/v3/classifications/*` endpoints are the easiest wrong turn available here: they
look exactly like the chart of accounts, and this token cannot reach them.

## Coding lives in custom fields

**There is no `glAccount` field on a Spend & Expense transaction.** No
`chartOfAccounts` endpoint this token can call, and no `category`. Coding is
carried in `customFields`, and when an accounting integration is connected BILL
pulls the chart of accounts in as custom-field **values**. So "Internet/Phone" is
a value on some custom field, and re-coding a transaction means selecting a
different value on that field.

Which field that is differs per company, and BILL will not say. The custom-field
`type` enum has exactly two members — `CUSTOM_SELECTOR` and `NOTE` — there is no
`GL_ACCOUNT`, and nothing in the payload marks a field as having come from an
accounting integration. `list_coding_fields` therefore returns a
`likely_coding_field` flag derived from the field's **name**, labelled as the
guess it is and used to order the results. Confirm it by looking at the field's
values.

A value carries less than you would hope: `{uuid, value, deleted, id}` and
nothing else. No account number, no account type, no link back to the QuickBooks
or NetSuite account it was imported from. An agent can map a merchant to a
label; it cannot reason about account structure, because the structure is not in
the API.

## Tools

| Tool                     | Tier          | What it does                                                                                      |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------- |
| `list_coding_fields`     | readonly      | The custom fields this company tags transactions with                                             |
| `list_coding_options`    | readonly      | One field's legal values — the chart of accounts. Returns the base64 `id` **and** the `uuid`      |
| `list_transactions`      | readonly      | Transactions, filterable by date, lock and review state; surfaces `is_locked` and the current coding |
| `get_transaction_coding` | readonly      | One transaction's full coding, both identifier forms, and whether it is writable                  |
| `set_transaction_coding` | **readwrite** | Change one transaction's coding — read back and diffed before it reports success                  |

## The tool surface is the security model

The BILL apiToken is **unscoped ADMIN**. The same secret that re-codes a
transaction can issue a virtual card, freeze one, create and move budgets, and
manage users. BILL issues no read-only token and offers no way to narrow one.

So the tool surface is the only boundary between an agent and a new virtual
card. Nothing here issues, freezes or reorders a card. Nothing creates or moves a
budget. Nothing touches users, reimbursements or bank accounts. That is why this
is a first-party server rather than an adopted one — the two community servers
that exist either expose `create_virtual_card` and `freeze_card`, or have no
custom-field support at all, which is the entire job. There is no official BILL
MCP server.

Adding a tool here is a decision about that boundary, not a feature. The tree's
own suite asserts that no tool name mentions a card, a budget, a user, a
reimbursement, a bank or funding, and the bundle's smoke test asserts the exact
five names against the booted image — a count alone would be satisfied by a
surface that swapped a read tool for a card tool.

### The two slugs

| Slug             | `tools: allow`                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `bill-spend-ro`  | `list_coding_fields`, `list_coding_options`, `list_transactions`, `get_transaction_coding`     |
| `bill-spend-rw`  | _(no policy — all five, `set_transaction_coding` included)_                                    |

`bill-spend-ro` is the tier to hand out. A sweep can be planned, costed and
reviewed on it and cannot change a ledger. Capability is enforced by the
gateway's per-slug `tools:` policy, not by a container variable — one mount runs
at full capability and strad decides, per slug and per call, what may run.

## Reading a window of transactions

`list_transactions` is what a re-coding sweep reads, and two things about BILL's
read side shape it.

### Date filters are day-granular, and the window is widened

`GET /v3/spend/transactions` takes one `filters` parameter. Its grammar is
`{field}:{op}:{value},{field}:{op}:{value}` — positional, split on `:` and `,`,
with **no quoting and no escape sequence**. A value carrying either separator is
not a filter that matches something else; it is a request BILL rejects outright:

```
filters=occurredTime:gte:2026-09-01T00:00:00Z
-> 422 Invalid filter request format. Expect (field:operator:value).
```

An ISO-8601 instant is four colons long, so no date filter can be expressed as
an instant. What BILL accepts on a time field is a bare `yyyy-MM-dd` and nothing
finer, with `gte` and `lte` as the only operators — `gt`, `lt`, `eq`, `in` and `isnull` are each a 400 naming the
operator.

**A date means the instant the day starts at, not the day it covers.** Against a
company whose transactions all occurred at `2026-09-06T06:03Z`,
`occurredTime:lte:2026-09-06` matched nothing and `occurredTime:lte:2026-09-07`
matched all of them. So truncating an instant to its own date drops a sweep's
most recent day.

So `occurred_after`, `occurred_before`, `updated_after` and `updated_before` take
a date **or** an instant, and each bound is floored to its UTC day and moved
**outward**: the window strad asks BILL for can only be too wide, never too
narrow. The result echoes the terms actually sent as `filters_applied`, and rows
outside the exact instant come back — narrow against each row's own
`occurred_time` if the day is not enough.

**The two moves are different sizes, and that is the correctness argument.** A
lower bound goes back one day and an upper bound forward two, because flooring
has already moved the bound backwards by its own time of day — the safe direction
below, the dangerous one above. A single day on the upper bound would leave
`2026-09-06T23:00Z` bounded by midnight on the 7th, an hour of margin, which any
zone east of UTC eats. The sizes are what make the window bracket the caller's
instant under **every** offset from UTC-12 to UTC+14, which matters because BILL
does not document which zone its midnight is in and a company has its own locale,
so the boundary is a per-company fact strad cannot carry. Too wide is a row a
caller can see and discard; too narrow is a transaction nobody learns about. See
[limitations](/limitations) for the rest.

### Review status is readable, barely, and not settable

A sweep can re-code a transaction and cannot tick it off. `is_reviewed` works as
a **filter**, so a run can skip what a human already reviewed in the BILL web
app — but BILL does not return the field on a transaction, so a row in the result
does not say which side it fell on.

**Nothing in the Spend & Expense v3 API sets it.** There is no review or approval
endpoint; the one transaction mutator, `PUT /v3/spend/transactions/{id}`, takes
`budgetId` and nothing else, and answers 200 to a review-shaped body it discards
whole. strad ships no tool for it rather than one that reports success and
changes nothing — the same standard the write below is held to.

## The write can report success and change nothing

`PUT /v3/spend/transactions/{id}/custom-fields` can answer **HTTP 200
`{"status":"SUCCESS"}` and discard the update.** For an unattended agent working
on someone's books, that is the worst failure available: forty transactions
reported re-coded, none of them changed.

That is measured, not inferred. Sending two values to a single-select field
against a live BILL sandbox company comes back `200 SUCCESS` and **the field is
exactly as it was** — the update dropped whole, no error, no warning. Probed
across an empty field, a coded one, two values, three, and a list containing the
value already selected: every one SUCCESS, every one discarded. It is the mistake
an agent makes by treating a single-select field as multi-select, and BILL
reports it as a success.

So this server does not trust the reply. `servers/bill-spend/shared/src/wire.ts`
holds the body shapes it knows how to send, best first, and the write walks that
ladder **re-reading the transaction after every attempt and diffing it**. Nothing
decides a write succeeded except the read-back.

A successful result carries `verified: true` — meaning the read-back was done —
and, when the transaction moved, the `wire_variant` that moved it. When nothing
reaches the requested state, the tool fails with `persisted: false` and the full
attempt table: per shape, what BILL answered and what the transaction looked like
afterwards.

**"Did not persist" and "did not change" are different claims, and the error
checks the second one.** Usually nothing moved and "treat this as uncoded" is the
right advice. But this server runs unattended against a company real people also
use, so a person can edit the same transaction in the BILL web app between the
PUT and the read-back — and then the transaction moved while this write did not.
That failure carries `changed: true` alongside `persisted: false`, with the
before and after, rather than telling a caller a row somebody just coded is
uncoded.

Everything else about the write follows from that:

- **Ids, not names.** `set_transaction_coding` takes value ids from
  `list_coding_options`. A name would have to be resolved somewhere, and a silent
  resolution is how the wrong identifier form gets sent.
- **Ids are resolved against the field's own catalog first**, so an id belonging
  to a different field is refused by name before a PUT is sent. That is the
  likeliest real cause of a write BILL accepts and drops.
- **A locked transaction is refused without a write attempt.** "You cannot update
  custom fields in a locked transaction" is documented, the check is one GET, and
  no API call unlocks one — a human does it in the BILL web app.
- **An unnecessary write is not sent.** A transaction already carrying exactly
  these values comes back `changed: false`, so re-running a sweep costs reads.
- **The winning shape is memoised** for the life of the process, so a sweep pays
  for the ladder once. The read-back still runs on every write, and a memoised
  shape that stops working simply loses its attempt and hands back to the ladder.
- **`changed` is a diff against the state read before the PUT**, not against the
  state that was requested. Asking for the state a field is already in satisfies
  "matches what was asked for" vacuously — most easily by writing only a note to
  a `CUSTOM_SELECTOR` field, where BILL stores the values (none) and discards the
  note — and calling that a change would be the same lie one size down.

### What the ladder is actually for

Two rungs, both proven against a live company, and the choice between them is
about which identifier forms a caller holds rather than about which one BILL
prefers:

| Rung | Body | When it is the one that writes |
| --- | --- | --- |
| `customFieldId/id` | `{customFieldId: "<base64>", selectedValues: ["<base64>"]}` | The ordinary case — what `list_coding_options` returns |
| `customFieldId/uuid` | `{customFieldId: "tty_…", selectedValues: ["tvl_…"]}` | When only uuids are on hand, as for a field read out of a `list_transactions` result |

Two claims that shaped the original design turned out to be wrong, and both were
settled by calling the endpoint:

- **`customFieldUuid` — the key name in BILL's Transactions guide — is a hard
  `400 customFieldId: must not be null`.** The guide's worked example does not
  work, and that rung is gone.
- **The uuid forms are not silently dropped.** A community field note claimed the
  `tty_…` / `tvl_…` forms BILL's own GETs hand back are accepted and discarded
  while only the base64 `id` writes. Every uuid form persisted, in both slots,
  mixed freely.

The read-back is not what those findings undo. It is what caught the
single-select case above, and it is the only thing that separates "coded" from
"coded as something else".

## Rate limits

**60 calls per token per minute.** Low enough that a sweep reaches it. The client
retries a 429 with exponential backoff, honouring `Retry-After` when BILL sends
one, then surfaces a typed rate-limit error telling the caller to slow down.

A verified write is four to five calls: read the transaction for the lock check,
read its coding for the before-state and the base64 ids, resolve the field's
value catalog (cached for five minutes), the PUT, and the read-back. Roughly a
dozen transactions a minute. That is the price of not lying about whether a write
landed.

## Credentials

Two environment variables; only the first is required.

| Variable               | What it is                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `BILL_SPEND_API_TOKEN` | The Spend & Expense API token. Secret, and **unscoped admin on the company**. |
| `BILL_ENVIRONMENT`     | `sandbox` (default) or `production`. Picks the gateway host.                  |

`BILL_ENVIRONMENT` **defaults to sandbox**, and the direction is deliberate: an
unset variable on a deployment meant to be production costs a 401; the other
default would point an unattended agent at real financial records over a missing
line of YAML. Staging declares `sandbox` explicitly anyway, because the value is
the entire difference between a test company and a real one.

**Sandbox token** — fill in the [Sandbox Access
Form](https://app-dev-bdc-stg.divvy.co/create-sandbox-company). Self-serve, no
approval, instant. It returns an `apiToken`, a `username` and a `password`, and
creates a **separate empty test company** — not a mirror of any real data. Sign
in at <https://login.stage.us.bill.com/neo/login>.

**Production token** — an ADMIN on the Spend & Expense company generates one
under **My account → Settings → Generate new token**. Only ADMIN users can.

Seed it in the console at `/ui/secrets`. See [Secrets](/operate/secrets/).

## Not configured is a supported state

The mount comes up **even with no credential**, marked `degraded` on `/healthz`:
the tool surface still lists, so the console and an agent can see what the
deployment would offer, and every call fails with an error naming the variable.
One server's missing config must not cost the other twenty-one their boot.

Both staging slugs are enabled and point at BILL's **sandbox** — a separate empty
test company with its own token, so a sweep run there cannot reach a real ledger
however wrong it gets. An unresolved `${REF}` fails the render **deliberately**,
and it fails the whole spec, so `BILL_SPEND_API_TOKEN` has to exist in
`/strad/staging/gateway/static/` before a deploy runs.

## What has been verified, and what has not

All five tools have been exercised against a live BILL sandbox company end to
end: the custom-field catalog, a field's values, the transaction list, one
transaction's coding, and a re-code that was read back and diffed. The write
persists, the verification is real, and the failure path fires on a write BILL
answers SUCCESS to and discards.

Every date filter has been exercised against that company too, individually and
in combination, including a window that correctly matches nothing — a filter BILL
silently ignored would have matched everything.

Three things were **not** exercised, and each needs something the sandbox does
not have:

- **A GL field that came from an accounting integration.** The sandbox company
  has no integration connected, so no such field exists in it to read. What is
  known is that `GET /v3/spend/custom-fields` takes no origin filter, applies no
  type gate, and returns every custom field the company has — there is no
  mechanism by which it could return a subset — and that the Spend & Expense API
  has no accounting-integration endpoint at all: every plausible path 404s, and
  the single-field GET carries no origin marker. So a company's GL field should
  come through as an ordinary `CUSTOM_SELECTOR`, and `list_coding_fields` on the
  production company is a free read that settles it in one call.
- **A locked transaction.** The sandbox seeds none. The refusal is checked by the
  unit suite against a fake, not against BILL.
- **The rate limiter.** 60 calls per token per minute was never approached.
- **`is_reviewed: true` matching anything.** Every transaction in the sandbox is
  unreviewed, and nothing in the API can review one. The filter is accepted and
  the two branches partition the company exactly — 8 of 8 unreviewed, 0 reviewed
  — but no row has ever been observed on the `true` side.

## Open question

`list_coding_fields` guesses which field is the chart of accounts from its NAME,
and says it is guessing. That is not a gap that a token closes: BILL's
custom-field `type` enum has exactly two members, `CUSTOM_SELECTOR` and `NOTE`,
and **nothing in the payload marks a field as having come from an accounting
integration** — confirmed against the live API, on the list endpoint and the
single-field endpoint alike. Confirm the guess by looking at the field's values.
