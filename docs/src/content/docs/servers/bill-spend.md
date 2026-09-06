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
| `list_transactions`      | readonly      | Transactions, filterable by `updated_after`; surfaces `is_locked` and the current coding          |
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

## The write can report success and change nothing

`PUT /v3/spend/transactions/{id}/custom-fields` can answer **HTTP 200
`{"status":"SUCCESS"}` and discard the update.** For an unattended agent working
on someone's books, that is the worst failure available: forty transactions
reported re-coded, none of them changed.

Two things are known, and they point the same way:

- **BILL's documentation contradicts itself.** The API reference says the request
  body's array items are `{customFieldId, selectedValues[], note}`. The
  Transactions guide's worked example says `customFieldUuid`. There is no third
  document that settles it.
- **A community implementer who actually called it** reports that the `tty_…` /
  `tvl_…` UUID forms BILL's own GETs hand back are silently rejected — SUCCESS
  returned, update dropped — and that only the base64 `id` form writes. That is
  unverified, one developer's field note; BILL contradicting itself corroborates
  that the endpoint is finicky.

So this server does not pick a shape. `servers/bill-spend/shared/src/wire.ts`
enumerates them, best first, and the write walks that ladder, **re-reading the
transaction after every attempt and diffing it**. Nothing decides a write
succeeded except the read-back.

A successful result carries `verified: true` and the `wire_variant` that actually
persisted, so which shape BILL honours stops being folklore. When nothing
persists, the tool fails with `persisted: false` and the full attempt table — per
shape, what BILL answered and what the transaction looked like afterwards.

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

When BILL settles its own documentation, `wire.ts` is where the answer goes:
delete the variants that never win.

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

In `infra/strad.staging.yaml` both slugs ship `enabled: false` until the token is
seeded. An unresolved `${REF}` fails the render **deliberately**, and it fails
the whole spec — so an entry that shipped enabled before its secret existed would
take every other server's deploy down with it. Turning this on is three steps:
seed `BILL_SPEND_API_TOKEN` in `/strad/staging/gateway/static/`, delete the two
`enabled:` lines, and add the name to `PROVISIONED_STATICS` in
`test/staging-config.test.ts`.

## Open question

**Whether accounting-integration-mapped custom fields are visible and writable
through the API at all** is not settled, and cannot be settled without a real
company. BILL's `type` enum exposes no GL-account type and no integration-origin
field, and its help-centre articles on the subject are client-side rendered. If
`GET /v3/spend/custom-fields` does not surface the GL field on a company with an
accounting integration connected, that is a genuine blocker rather than something
to work around. It is the first thing to check once a token exists.
