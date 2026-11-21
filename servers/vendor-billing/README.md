# vendor-billing MCP server

strad's own server for a cost-collection agent: prepaid balances and in-month
spend from three vendors, as four fixed reads. No tool takes a URL, a path, a
query, a request body or a key, so the credentials behind it never become a
general-purpose client.

| Tool                       | Request                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| `get_openrouter_credits`   | `GET https://openrouter.ai/api/v1/credits` (management key)                     |
| `get_openrouter_key_usage` | `GET https://openrouter.ai/api/v1/key` (the API key reads itself)               |
| `get_openai_costs`         | `GET https://api.openai.com/v1/organization/costs`, `bucket_width=1d`, `group_by=project_id`, every page |
| `get_gcp_month_to_date`    | one fixed BigQuery query over a Cloud Billing standard usage cost export        |

## Environment

Each tool is configured on its own. A tool missing a variable answers
`not configured`, naming the variable, and the others keep working.

| Variable                     | Secret | Tool                       |
| ---------------------------- | ------ | -------------------------- |
| `OPENROUTER_MANAGEMENT_KEY`  | yes    | `get_openrouter_credits`   |
| `OPENROUTER_PI_API_KEY`      | yes    | `get_openrouter_key_usage` |
| `OPENAI_ADMIN_KEY`           | yes    | `get_openai_costs`         |
| `GCP_BILLING_SA_KEY_JSON`    | yes    | `get_gcp_month_to_date`    |
| `GCP_BILLING_EXPORT_PROJECT` | no     | `get_gcp_month_to_date`    |
| `GCP_BILLING_EXPORT_DATASET` | no     | `get_gcp_month_to_date`    |
| `GCP_BILLING_EXPORT_TABLE`   | no     | `get_gcp_month_to_date`    |

The variables are read on every call, never at boot. Every credential, and the
access token a Google call mints, is scrubbed from every result and error.

The full page, with the minimum permissions each credential needs, is
`docs/src/content/docs/servers/vendor-billing.md`.

## Tests

```
cd servers/vendor-billing && npm ci && npm test
```

Every test runs against fake vendors (`HACKS.md` #158).
