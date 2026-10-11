# nutrition-facts MCP server

strad's server for **nutrition evidence** when there is no label or official
restaurant data: USDA FoodData Central, MenuStat and FatSecret side by side,
each scaled to the requested amount with that source's own portions, plus a
low / expected / high range, a disagreement flag and totals. A tree in the
strad bundle image, mounted at `/nutrition-facts`.

The full description — sources, matching, scaling, the range rules, FatSecret's
quota, attribution and IP allowlist — is the docs page,
`docs/src/content/docs/servers/nutrition-facts.md`.

## Tools

| Tool | What it does |
| --- | --- |
| `estimate_components` | Components with quantities → USDA + FatSecret evidence, ranges, totals |
| `estimate_restaurant_item` | A restaurant and a menu item → MenuStat + FatSecret, USDA FNDDS fallback, 15% buffer on `high` |
| `search_foods` | Ranked matches per source, to find a better candidate |
| `get_food` | One candidate's full nutrients, portions and provenance |

All four only read.

## Configuration

Every variable is optional; with none set the server answers from local data
and reports FatSecret `unavailable`. FatSecret needs all three of its variables:
there is no direct call without the proxy.

| Variable | What it is |
| --- | --- |
| `FATSECRET_CLIENT_ID`, `FATSECRET_CLIENT_SECRET` | FatSecret Platform API OAuth 2.0 client, Basic tier |
| `FATSECRET_PROXY_URL` | The forward proxy EVERY FatSecret request goes through (`http://user:password@host:port`; in strad, a BrightData dedicated-IP zone). Its exit IPs are the FatSecret key's allowlist. Unset means FatSecret is never called. Never logged. |
| `USDA_FDC_API_KEY` | api.data.gov key, for live USDA Branded lookups |
| `NUTRITION_FACTS_DATA_DIR` | Where `usda.json.gz` and `menustat.json.gz` are (default `./data`) |

## Data

```sh
npm ci
npm run build
npm run data                           # download the pinned sources, write ./data
npm run data -- --from <dir>           # or build from downloads already on disk
```

`shared/src/data/sources.ts` pins every download by SHA-256. The bundle
Dockerfile runs `npm run data` at image build time; `data/` is git-ignored.

## Layout

`shared/` is the whole server: `createMCPServer({ version, env, dataDir, fetch })`
returns `{ server, registerHandlers }`, the shape the strad bundle host mounts.
`missingCredentials()` (always empty), `missingDataFiles()` and `toolNames()`
are exported beside it.

```sh
npm test   # tsc, then vitest — fixtures and fakes, no network
```
