# good-eggs MCP server — shared module

The tool logic: the Playwright client, the 11 tools, and the basket read they
all depend on. `remote/` imports `createMCPServer()` from here; nothing is
reimplemented there.

This is a **fork**, not a vendor copy — strad owns it, and fixes land here.
[`../FORK.md`](../FORK.md) has every delta from upstream and the incident behind
each.

## Structure

```
shared/
├── src/
│   ├── index.ts        # public exports
│   ├── server.ts       # the Playwright client + createMCPServer()
│   ├── basketState.ts  # the authoritative basket read (FORK.md #1)
│   ├── tools.ts        # the 11 tool definitions and handlers
│   ├── appUi.ts        # the MCP-App (io.modelcontextprotocol/ui) surface
│   ├── telemetry.ts    # browser-span instrumentation
│   ├── logging.ts      # stderr logging helpers
│   └── types.ts        # shared types and the Zod input schemas
└── build/              # built output (tests run against this)
```

## Building and testing

```bash
npm install
npm run build
npm test          # builds, then runs test/*.test.mjs with node:test
```

The tests need no browser and no Good Eggs login. They are the only thing
defending the fork's deltas against a careless re-vendor, so a change to the
cart read, the add reconciliation, the removal path, the login or the favorites
read belongs with one. `login.test.mjs` and `favorites-truthfulness.test.mjs`
both drive the real client over a fake page, through the
`setSharedBrowserProvider` seam, so the post-login wait, the verdict it feeds and
the favorites read that follows are covered without either. The in-page DOM
scrape is the one part stubbed, because it runs in a browser.
