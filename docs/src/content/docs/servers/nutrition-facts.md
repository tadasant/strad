---
title: Nutrition facts
description: Sourced calorie and macro evidence for foods and restaurant items — USDA FoodData Central, MenuStat and FatSecret side by side, scaled to the amount, with a low / expected / high range.
---

`nutrition-facts` is strad's own MCP server for nutrition numbers when there is
no label or official restaurant data to hand. Source in
`servers/nutrition-facts/`, served at `/nutrition-facts` inside the bundle
image, slug `nutrition-facts`.

It is a fallback that shows its work. The caller is an LLM, so the server
returns the evidence — each source's best match, what it assumed, and where
the sources disagree — beside a suggested range, rather than one opaque
number. The caller breaks a free-form meal into components; the server looks
them up, scales them, and adds them up. There is no LLM call inside it, no
food diary, no barcode lookup, and no nutrient beyond the eight below.

## Sources

| Source | Covers | How it gets here | Data year |
| --- | --- | --- | --- |
| USDA FoodData Central — Foundation, SR Legacy, FNDDS | ingredients and generic mixed dishes | built into the image (below) | per food: 2018 for SR Legacy, the publication year otherwise |
| USDA FoodData Central — Branded | US packaged foods | **live** FDC API, only with `USDA_FDC_API_KEY`, only for a named brand | the record's publication year |
| MenuStat | ~100 US chains' menus | built into the image | 2017 or 2018 — the latest year MenuStat has the item |
| FatSecret Platform API (Basic) | generic, branded and restaurant foods | **live**, cached | current |

Every result reports each source as `answered`, `no_match`, `unavailable` (with
the reason) or `not_queried`. A missing source never fails a call: with no
credentials at all the server still answers from its local data.

### How the local data ships

At **image build time**. The bundle Dockerfile's `nutrition-facts` stage runs
`npm run data`, which downloads four public files, checks each against a
SHA-256 pinned in `servers/nutrition-facts/shared/src/data/sources.ts`, and
writes two gzipped JSON files — about 2 MB together — into the tree:

- `usda.json.gz`: 13,602 foods from the Foundation (2026-04-30), SR Legacy
  (2018-04) and FNDDS (2024-10-31) CSV releases, 3–6 MB each to download.
- `menustat.json.gz`: 43,177 items from NYC Open Data's copy of MenuStat
  (dataset `qgc5-ecnb`, 2017–2018, 96 chains). menustat.org itself sits behind
  a bot challenge a build cannot pass; NYC DOHMH maintains MenuStat and
  publishes this copy as open data.

Nothing large is in git, nothing is fetched at boot, and there is no volume.
A download that changes under its URL fails the image build by name. Moving to
a newer USDA release is a PR that changes a URL, a digest and a release label.

**USDA Branded is not baked.** Its release is a 449 MB zip of ~3 GB of CSV and
~450,000 foods: hundreds of MB on an image every bundle component pulls,
minutes on every bundle build, and an in-memory index the bundle could not hold
beside Chromium. So Branded is read from the live FDC API instead, and only when
a component names a `brand` (or `kind: "branded"`). Without a key, brand
lookups still get FatSecret's brand foods and USDA's local entries, and the
result says Branded was not searched.

The files load lazily on the first call that needs them (~60 MB of heap), not
at boot. If one is missing — an image built wrong — the mount reports itself
`degraded` and every local lookup says `unavailable` with the path.

## Tools

All four only read.

| Tool | Input | Sources |
| --- | --- | --- |
| `estimate_components` | 1–25 components: `name`, `quantity`, `unit`, optional `brand`, `kind`, `food_id` | USDA, FatSecret |
| `estimate_restaurant_item` | `restaurant`, `item`, optional `size`, `quantity`, `buffer_pct` | MenuStat, FatSecret; USDA FNDDS as fallback |
| `search_foods` | `query`, optional `sources`, `restaurant`, `brand`, `kind`, `limit` | any |
| `get_food` | one candidate id (`usda:…`, `menustat:…`, `fatsecret:…`) | that id's source |

A single dish ("pad thai", 2 cup) is a valid one-component call. `food_id`
pins a candidate the caller found with `search_foods`, so a better match can
be swapped in.

### Matching

- Names are matched by word overlap after folding case, punctuation and
  plurals. USDA's "this is the plain one" qualifiers — "no added fat", "NS as
  to …", "NFS" — do not count against a name. A prefix is not a word: "apple"
  does not find Applebee's.
- `kind` steers which USDA dataset wins a near-tie: `ingredient` favours
  Foundation and SR Legacy, `dish` favours FNDDS, `branded` (or a `brand`) adds
  USDA Branded and FatSecret's brand foods. USDA's names lead with the food,
  so a name that leads with the query's first word ranks above one that only
  mentions it ("Egg, whole" over "Bread, egg").
- If the top text match cannot be scaled to the requested unit and one within
  0.1 of it can, the scalable one is the source's best match.
- Restaurants are matched loosely, by letters only: "mcd" and "maccas" find
  McDonald's, "chick fil a" finds Chick-Fil-A, "bk" finds Burger King by its
  initials. A matched chain's menu is then searched for the item, size words
  included ("large fries").

### Scaling

Quantities become grams through each source's **own** portions. A mass unit
converts itself. A volume converts through a volume portion the source
published (its "1 cup = 158 g" fixes the food's density, so "3 tbsp" follows).
A count word ("medium", "slice", "whole") converts only through a portion with
that word; "serving" means the source's serving, FNDDS's "Quantity not
specified", a branded label's serving, or a single-serve package. Nothing is
guessed: when no portion converts, the component has no estimate, is flagged
`needs_grams`, and each candidate carries `per_100g`, so the caller can ask
again in grams.

Every candidate says `grams_assumed` and, in words, how it got there
(`grams_basis`: `2 cup via source portion "1 cup" = 200 g`).

### The estimate

Per component:

- `candidates` — each source's best match, scaled: id, source, dataset, name,
  brand or restaurant, data year, `match` (`exact` / `strong` / `partial` /
  `weak` / `pinned`), grams assumed and the eight nutrients.
- `alternatives` — the runners-up per source (default 2, up to 5).
- `range` — `low` / `expected` / `high` for calories, protein, carbs, fat,
  fiber, sugar, saturated fat and sodium. `expected` comes from the best match
  (`expected_from`); `low` and `high` span the candidates in the range. A
  candidate enters the range when it matches well (score ≥ 0.65) and could be
  scaled. When none does, a partial match (≥ 0.5) sets the estimate and the
  component is flagged `low_confidence_match`.
- `disagreement` and the flag `sources_disagree` — when two sources' calories
  differ by more than 20%.

Then `totals` across components (with `components_without_estimate` when one
had none), `sources`, and FatSecret's attribution when its data was used.

**Restaurant buffer.** Every restaurant estimate — chain or independent —
widens `high` by `buffer_pct`, 15 by default, for the oil and butter a kitchen
adds. The result says so in `buffer`; `expected` is never buffered.

**Independent restaurants.** When no chain menu item matches well (on MenuStat
or FatSecret), the expected value is the closest USDA FNDDS generic dish and the
component is flagged `independent_restaurant_estimate`. A chain that is in
MenuStat but has no close item (Chipotle's menu is listed as components, so
"chicken burrito" finds only "Chicken") takes the same path, and the note says
which. When a chain item does match, the USDA dish is still shown as evidence
with `in_range: false`.

## Configuration

Every variable is optional.

| Variable | What it is |
| --- | --- |
| `FATSECRET_CLIENT_ID`, `FATSECRET_CLIENT_SECRET` | A FatSecret Platform API OAuth 2.0 client (Basic tier). Token from `https://oauth.fatsecret.com/connect/token`, scope `basic`. |
| `FATSECRET_PROXY_URL` | The forward proxy every FatSecret request goes through, credentials included: `http://user:password@host:port`. Its exit IPs are the ones on the FatSecret key's allowlist. Without it FatSecret is not called at all. |
| `USDA_FDC_API_KEY` | A free api.data.gov key (`https://fdc.nal.usda.gov/api-key-signup`), for live USDA Branded lookups. |
| `NUTRITION_FACTS_DATA_DIR` | Where the data files are. Default: the tree's own `data/`. |

In strad the bundle hands the mount a snapshot of its environment taken at
boot, so a credential seeded later reaches it on the next deploy. Staging
declares all four under `mayBeUnseeded:`, so the slug deploys enabled before
any of them is in the store.

## FatSecret

**Two calls per component at most**: one `foods.search` (v1, the Basic
version) and one `food.get` (v5) for the best match. Runners-up come from the
search page's own summary line, which carries only calories and the three
macros (`calories_and_macros_only`).

**The quota is 5,000 calls a day.** Every response is cached in process for 23
hours — FatSecret's terms allow nutrient values to be kept for at most 24 —
and a counter stops calling at 4,500 a UTC day, reporting FatSecret
`unavailable` until midnight. The margin is for what the counter cannot see:
other bundle instances and restarts each start from zero. The access token
(24 hours) is reused until a minute before it expires, and minted once more if
FatSecret rejects it.

**Attribution is required on Basic**, wherever FatSecret content is shown.
Every result that carries FatSecret data has:

```json
"attribution": {
  "text": "Powered by fatsecret Platform API",
  "url": "https://platform.fatsecret.com",
  "html": "<a href=\"https://platform.fatsecret.com\">Powered by fatsecret Platform API</a>"
}
```

and the tool descriptions tell the caller to show it.

**Every FatSecret request goes through a forward proxy.** A FatSecret key
answers only the IP addresses allowlisted in the FatSecret Platform console —
single addresses on Basic, no CIDR ranges — and strad's App Platform components
have no fixed egress IP of their own. So the OAuth token request and every API
call leave through `FATSECRET_PROXY_URL`: an ordinary HTTP forward proxy (CONNECT
for https) with dedicated exit IPs — strad's deployment uses a BrightData
dedicated-IP zone, `http://brd-customer-<id>-zone-<zone>:<password>@brd.superproxy.io:33335`.
Those exit IPs are the ones on the key's allowlist. It has to be a plain proxy:
BrightData's Web Unlocker API, which `strad-fetch` uses, rotates its exit IPs
and is built for GET scraping, so it can neither hold a stable allowlisted IP
nor carry the token POST.

There is no direct fallback. With `FATSECRET_PROXY_URL` unset, FatSecret is
unconfigured — reported `unavailable`, with the variable named — and nothing is
sent to it; a direct call would only come back as error 21. A proxy that fails
(refused, unreachable, a `407` from bad proxy credentials) is reported as
`the FatSecret proxy (FATSECRET_PROXY_URL) failed — …`, which reads differently
from a FatSecret API error (`FatSecret error 21: …`). The URL carries the proxy
password, so it is never logged and is scrubbed from every message. USDA and
MenuStat are local and never touch the proxy; USDA Branded goes to api.data.gov
directly. See [known limitations #122](/limitations/#122-nutrition-facts-ships-its-data-in-the-image-and-calls-fatsecret-only-through-a-proxy).

## What is proven, and what is not

The data builders are tested over CSV fixtures shaped like each real release,
quirks included — FNDDS writes nutrient numbers into its `nutrient_id`
column, Foundation's `food.csv` is mostly lab samples, and 91 Foundation foods
carry no energy value (they get 4/4/9 from their macros, flagged
`calories_computed_from_macros`). The real files were built and queried end to
end while writing this. The four tools run through a real MCP client against a
fake FatSecret and a fake FDC built from their published docs.

The proxy path is tested with undici's real `ProxyAgent` against a local
forward proxy that tunnels CONNECT: the token POST and the API GET both arrive
through it, with the proxy's credentials, and an unreachable proxy is reported
as the proxy's failure.

**Neither live API has been called by this server.** FatSecret's and FDC's
response shapes, FatSecret's error codes and its single-object-instead-of-array
quirk are taken from the documentation. A live FatSecret call needs the proxy's
dedicated IPs on the key's allowlist and the three FatSecret variables seeded.
