# pulse-subregistry — strad bundle tree

`pulse-subregistry` is strad's fork of PulseMCP's Sub-Registry MCP server. It
lists MCP servers and fetches individual server metadata through
`https://api.pulsemcp.com/v0.1`.

It is packaged like `remote-filesystem`: a `shared/` MCP server tree inside the
main `ghcr.io/tadasant/strad-bundle` image. The bundle host serves it at
`/pulse-subregistry`.

## Environment

- `PULSEMCP_SUBREGISTRY_API_KEY` — required for tool calls.
- `PULSEMCP_SUBREGISTRY_TENANT_ID` — optional tenant header.
- `PULSEMCP_SUBREGISTRY_BASE_URL` — optional API base URL, mostly for tests.

The image is credential-free. strad injects the API key onto the bundle component
through the staging/prod config.
