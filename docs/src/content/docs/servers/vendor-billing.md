---
title: Vendor billing
description: strad's own read-only billing server — OpenRouter credits and key usage, OpenAI organization costs, and Google Cloud month-to-date spend from a Cloud Billing BigQuery export. Fixed reads, one credential per tool.
---

Read prepaid balances and in-month spend from three vendors without handing an
agent a general-purpose vendor credential. The server is strad's own,
`servers/vendor-billing`, served at `/vendor-billing` in strad's bundle image.
It exists for a cost-collection agent: four reads, each a fixed request, and
nothing an agent can aim somewhere else.

## Tools

Four, all `readOnlyHint: true`. No tool takes a URL, a path, a query, a request
body or a key. Three take no input at all, and an argument a tool does not
declare is refused rather than ignored.

| Tool                       | Request                                                                                   | Returns                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `get_openrouter_credits`   | `GET https://openrouter.ai/api/v1/credits`                                                | `total_credits`, `total_usage`, and `remaining` (credits minus usage), USD                |
| `get_openrouter_key_usage` | `GET https://openrouter.ai/api/v1/key`                                                    | the key's `usage` (all-time, daily, weekly, monthly), BYOK usage, `limit`, `limit_remaining`, `limit_reset` |
| `get_openai_costs`         | `GET https://api.openai.com/v1/organization/costs`, `bucket_width=1d`, `group_by=project_id` | per-day, per-project cost, and totals per currency, over every page                    |
| `get_gcp_month_to_date`    | one fixed BigQuery query over a standard usage cost export                                | for the current `invoice.month`: summed cost, summed credits, net, currency, and `MAX(usage_end_time)` |

- **`get_openai_costs`** takes `start_date` and an optional `end_date`
  (`YYYY-MM-DD`, UTC, both inclusive; `end_date` defaults to `start_date`). The
  range is at most 31 days and may not start in the future. The server walks
  `next_page` to the end and stops after 20 pages rather than loop. Cost OpenAI
  attributes to no project is reported under `(none)`.
- **`get_openrouter_key_usage`** keeps only the usage and limit fields. The
  key's label, creator, organization and workspace identifiers in the same
  answer are dropped. A label is often a masked preview of the key.
- **`get_gcp_month_to_date`** returns one row per currency. The invoice month is
  computed by BigQuery in Pacific Time, the zone Cloud Billing invoices in.
  `latest_usage_end_time` is how fresh the export is: it lags usage by hours.
  Credits are negative, so `net` is `cost + credits`.

The query is this, with the table spliced in after validation:

```sql
SELECT
  invoice.month AS invoice_month,
  currency,
  SUM(cost) AS cost,
  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(usage_end_time), 'UTC') AS latest_usage_end_time
FROM `<project>.<dataset>.<table>`
WHERE invoice.month = FORMAT_DATE('%Y%m', CURRENT_DATE('America/Los_Angeles'))
GROUP BY invoice_month, currency
ORDER BY currency
```

It runs as GoogleSQL with `maximumBytesBilled` at 10 GiB, so a much larger
scan is refused by BigQuery rather than billed.

## Configuring the slug

Each tool is configured on its own. A tool whose variables are absent answers
`not configured`, naming the missing variables by name only, and the other
tools keep working. Nothing here fails a boot, and `tools/list` needs no
variable. The variables are read on each call from the mount's view of the
container environment, which the bundle host copies when the mount loads, so a
rotated value arrives with the next restart. The mount reports itself `degraded` only while none of the four
tools is configured.

| Variable                     | Secret | Tool                       | What it is                                                                 |
| ---------------------------- | ------ | -------------------------- | -------------------------------------------------------------------------- |
| `OPENROUTER_MANAGEMENT_KEY`  | yes    | `get_openrouter_credits`   | An OpenRouter management (provisioning) key                                |
| `OPENROUTER_PI_API_KEY`      | yes    | `get_openrouter_key_usage` | The ordinary OpenRouter API key whose own usage is read                    |
| `OPENAI_ADMIN_KEY`           | yes    | `get_openai_costs`         | An OpenAI organization admin key                                           |
| `GCP_BILLING_SA_KEY_JSON`    | yes    | `get_gcp_month_to_date`    | A service-account key file's JSON contents                                 |
| `GCP_BILLING_EXPORT_PROJECT` | no     | `get_gcp_month_to_date`    | The project holding the export dataset. The query job runs here too        |
| `GCP_BILLING_EXPORT_DATASET` | no     | `get_gcp_month_to_date`    | The export's BigQuery dataset                                              |
| `GCP_BILLING_EXPORT_TABLE`   | no     | `get_gcp_month_to_date`    | The standard usage cost export table, `gcp_billing_export_v1_…`            |

`get_gcp_month_to_date` needs all four of its variables. The three export
variables are configuration, not credentials, but BigQuery cannot bind a table
name as a query parameter, so each is checked before the query is built:

- the project must be a project ID: 6–30 characters of `a-z`, `0-9` and `-`,
  starting with a letter and not ending in `-`. The legacy domain-scoped form
  (`example.com:project`) is refused.
- the dataset and the table must be letters, digits and `_` only.

A value outside those is a `misconfigured` error naming the variable, before
any request is made.

```yaml
- slug: vendor-billing
  kind: supplementary-image
  title: Vendor billing
  description: Prepaid balances and in-month spend for OpenRouter, OpenAI and Google Cloud. Read-only.
  image: ghcr.io/tadasant/strad-bundle:<version>
  bundle: bundle
  path: /vendor-billing
  entitlements: [admin]
  env:
    OPENROUTER_MANAGEMENT_KEY: "${OPENROUTER_MANAGEMENT_KEY}"
    OPENROUTER_PI_API_KEY: "${OPENROUTER_PI_API_KEY}"
    OPENAI_ADMIN_KEY: "${OPENAI_ADMIN_KEY}"
    GCP_BILLING_SA_KEY_JSON: "${GCP_BILLING_SA_KEY_JSON}"
    GCP_BILLING_EXPORT_PROJECT: example-billing-project
    GCP_BILLING_EXPORT_DATASET: billing_export
    GCP_BILLING_EXPORT_TABLE: gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX
  # No `tools:` — all four read.
```

The mount is `/vendor-billing`, one per bundle. It reads the
`VENDOR_BILLING__*` names, the per-slug names of a slug called
`vendor-billing`, and falls back to the bare names, so a slug of another name
on that path works through the bare names. A variable left out of `env:` leaves
its tool unconfigured.

## Minimum vendor-side permissions

| Credential                  | The least it needs                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_MANAGEMENT_KEY` | A management key. OpenRouter has no narrower key that can read `/credits`, and an ordinary key gets `403`. A management key can also create and delete keys; this server never calls those endpoints. |
| `OPENROUTER_PI_API_KEY`     | Any API key. `/key` describes the key that calls it, so it reads its own usage and nothing else.                     |
| `OPENAI_ADMIN_KEY`          | An admin key restricted to read access on the Usage API. The costs endpoint takes only admin keys.                   |
| `GCP_BILLING_SA_KEY_JSON`   | `roles/bigquery.dataViewer` on the export dataset, and `roles/bigquery.jobUser` on `GCP_BILLING_EXPORT_PROJECT`. The token is requested with the `bigquery.readonly` scope. |

## What reaches each vendor

Every URL is built from constants and the validated export address. A
BigQuery poll carries the job id the query answered with, encoded, to the same
fixed host; nothing fetches a URL a caller or a response supplied. A redirect
is refused rather than followed with a credential attached. Each request times
out at 30 seconds, and the two tools that make more than one request,
`get_openai_costs` and `get_gcp_month_to_date`, stop after 90 seconds in all,
so a slow vendor ends in this server's own error rather than the gateway's
tool-call timeout. Each key goes to its own vendor only. The service-account
assertion goes to Google's own token endpoint; the key file's `token_uri` is
not read.

**No credential leaves the server.** Every result and every error is scrubbed
before it is returned: each secret variable's value, the service account's
private key, its key id and every line of its PEM body, and the access token
minted for the call and the signed assertion that minted it. Anything shaped
like a credential is scrubbed too: an `sk-…` key, a `Bearer` header, a Google
access token, a JWT, a PEM block. An upstream
error is quoted only as the vendor's own `message`, cut to 300 characters, and
never with a header. The server logs nothing.

:::caution
Its tests run against fake vendors built from each vendor's published API
documentation. It has not met a real account. See
[Limitations #158](/limitations/).
:::
