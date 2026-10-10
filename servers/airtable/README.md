# Airtable MCP server

strad's own Airtable server: list and search records, read and edit table
schema, write and delete records, comment, and upload attachments, over one
Airtable personal access token. It serves as `strad-airtable`.

It replaces the npx package `airtable-mcp-server@1.13.0` (MIT, by domdomegg).
The sixteen tool names and their argument names are the same, camelCase
included, so a prompt written against that package works unchanged here. What
differs is listed under [Deltas](#deltas-from-the-npx-package).

## Environment

| Variable             | Required | What it is                                                                           |
| -------------------- | -------- | ------------------------------------------------------------------------------------ |
| `AIRTABLE_API_KEY`   | yes      | An Airtable personal access token, sent as `Authorization: Bearer`.                  |
| `ENABLED_TOOLGROUPS` | no       | `readonly`, `readwrite`, or both. Unset serves all sixteen; a typo serves the reads. |

To get the token, create a personal access token at
<https://airtable.com/create/tokens> with the scopes `data.records:read`,
`data.records:write`, `data.recordComments:read`,
`data.recordComments:write`, `schema.bases:read` and `schema.bases:write`, and
grant it access to each base it should see. A token sees no base it was not
explicitly given. A read-only deployment can leave out the three `:write`
scopes, and then the token is a second fence behind the gateway's `tools:`
policy rather than the only one.

The token is read when a tool is called, never at boot, from the env the
server was given. `tools/list` works without it; a call without it fails,
names the variable and says how to get it, and sends nothing to Airtable. In
the strad bundle that env is a snapshot fixed at boot, so a rotated token is
not picked up by a running container — rotation takes a redeploy.

API calls go to `https://api.airtable.com`. Attachment uploads go to
`https://content.airtable.com`, the only endpoint Airtable serves from there.

## Tools

| Tool                | Group     | Annotations            | What it does                                               |
| ------------------- | --------- | ---------------------- | ---------------------------------------------------------- |
| `list_bases`        | readonly  | read                   | The bases the token can reach. Pages by `offset`.          |
| `list_tables`       | readonly  | read                   | A base's tables at `detailLevel` (default `full`).         |
| `describe_table`    | readonly  | read                   | One table's fields and views. Takes an ID or a name.       |
| `list_records`      | readonly  | read                   | Records, filtered, sorted, by view. Bounded, resumable.    |
| `search_records`    | readonly  | read                   | Substring search over text fields. Bounded, resumable.     |
| `get_record`        | readonly  | read                   | One record by ID.                                          |
| `list_comments`     | readonly  | read                   | A record's comments, one page per call.                    |
| `create_record`     | readwrite | write                  | One record, typecast.                                      |
| `update_records`    | readwrite | write, **destructive** | Up to 10 records; each named field is replaced. Typecast.  |
| `delete_records`    | readwrite | write, **destructive** | Up to 10 records.                                          |
| `create_table`      | readwrite | write                  | A table, primary field first.                              |
| `update_table`      | readwrite | write, **destructive** | Rename a table or change its description.                  |
| `create_field`      | readwrite | write                  | A field, under `nested.field` (the npx package's shape).   |
| `update_field`      | readwrite | write, **destructive** | Rename a field or change its description. ID or name.      |
| `create_comment`    | readwrite | write                  | A comment on a record, optionally threaded.                |
| `upload_attachment` | readwrite | write                  | A base64 file up to 5 MB, appended to an attachment field. |

"read" is `readOnlyHint: true, destructiveHint: false, idempotentHint: true`.
Every tool carries `openWorldHint: true`. The four destructive tools are the
ones that overwrite or remove data Airtable gives an API caller no undo for:
`update_records` replaces a field's value (a multi-select or link field is set
to exactly the array given, not appended to), `delete_records` removes the
record, and the two `update_*` schema tools replace a name, which breaks any
formula or filter that refers to it. They are also `idempotentHint: true` —
the same call twice lands the same state. The `create_*` tools and
`upload_attachment` add without overwriting and are neither destructive nor
idempotent.

`toolNames(["readonly"])` is exactly the seven reads, so it is what a
read-only slug's `tools:` allow list would be. In strad the gateway's per-slug
`tools:` policy is the enforcement, not this variable.

## Deltas from the npx package

- **Reads are bounded.** The npx package's `list_records` and
  `search_records` walked every page of a table in one call, with no bound but
  an optional `maxRecords`. Here `maxRecords` defaults to 100 (one Airtable
  page) and is clamped at 1000 (ten pages). The result carries `returned`,
  `more`, and, when more match, the `offset` to pass back to continue. Both
  tools take an `offset` argument for that. Airtable's own `maxRecords` is not
  sent, because with it the last page comes back without a cursor and "were
  there more?" has no answer; the page size is sized to what is left instead.
- **A list that stops part-way keeps what it read.** If page 2 or later of a
  `list_records` or `search_records` call is rate-limited or lost in transit,
  the call succeeds with the records read so far, `more: true`, the `offset`
  that re-asks for the failed page, and `stopped_early: "rate_limited"` (with
  `retry_after_seconds`) or `stopped_early: "transport_error"`. A failure on
  the first page is still an error, and any other failure on a later page is
  still an error too.
- **A long formula is sent as a body.** Airtable refuses a URL past 16,000
  characters. When the GET URL would pass 15,000, a list goes as
  `POST /v0/{baseId}/{tableIdOrName}/listRecords` with `pageSize`, `offset`,
  `view`, `filterByFormula`, `sort` and `fields` in a JSON body. It is still a
  read, under the same `data.records:read` scope.
- **An expired cursor says so.** Airtable's
  `LIST_RECORDS_ITERATOR_NOT_AVAILABLE` 422 comes back with a hint to repeat
  the call without `offset`, rather than the generic invalid-request one.
- **`list_bases` pages.** It returns `offset` and takes one, instead of
  returning only Airtable's first page.
- **A 429 is a retryable error.** Airtable allows 5 requests per second per
  base and asks a client that exceeds it to wait 30 seconds. That surfaces as
  `{"error":"RateLimitError","retryable":true,"retry_after_seconds":30}`
  (Airtable's `Retry-After` wins when it sends one), not as a generic failure,
  and it is not slept through inside the call.
- **Every Airtable error is a small document** with `status`, Airtable's
  `type`, `retryable`, and a hint in this server's words. A 403 names the
  scope the call needed and says the base may be missing or simply not granted
  to the token (Airtable answers both the same way). A 401 says whether the
  value looks like a legacy `key…` API key or a truncated token. 5xx is
  retryable. Upstream bodies are capped at 300 characters.
- **Every request times out at 30 seconds**, with an error that says a write's
  outcome is unknown.
- **The token is scrubbed** from every result, success or failure, and error
  text is also scrubbed of anything token-shaped.
- **`tableId` takes a name everywhere it says it does.** The npx package's
  `describe_table` and `search_records` matched IDs only. Path segments are
  URL-encoded, so a table named `Q3 / Plans` works. Airtable's two field
  endpoints take IDs only, so `create_field` and `update_field` resolve a
  table name, and `update_field` a field name, through the base schema first —
  one extra read, skipped when both are already IDs.
- **`search_records` takes field names** in `fieldIds` as well as IDs, and
  returns `searchedFieldIds`. The formula and its escaping are the npx
  package's: `OR(FIND("term", {fldId}), …)` with `"` and `\` backslash-escaped,
  so the term cannot close the string and inject formula. It is a
  case-sensitive substring match, as it was. The term is sent untrimmed, as
  is a comment's `text`; only an empty or whitespace-only one is refused.
- **`list_records` takes `fields`**, to fetch only some columns of a wide
  table.
- **Writes are refused before the call** when they cannot succeed: more than
  10 records, an empty `update_table`, a non-base64 or over-5 MB upload. A
  `data:` URL prefix on an upload is stripped rather than refused, and
  base64url (`-`, `_`, no padding) is normalised to standard base64.
- **Kept as-is:** `typecast: true` on record writes, the `nested.field`
  argument of `create_field`, `detailLevel` defaulting to `full`, and the
  `{id, fields}` record shape — plus `createdTime`, which Airtable sends on
  every record and is passed through.

## Tested only against a fake

Nothing in this tree has talked to the real Airtable API. The suite drives the
client against an injected `fetch` that answers with Airtable's documented
shapes, and drives the server end to end through a real MCP client over an
in-memory transport. The request shapes, the pagination, the error documents,
the formula-by-field-ID search, the `POST …/listRecords` body and the
ID-only field endpoints are what the documentation and the npx package say,
not what was observed.

```sh
npm ci
npm test   # tsc, then vitest
```
