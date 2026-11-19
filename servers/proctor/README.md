# proctor — strad bundle tree

PulseMCP's Proctor MCP server: run an exam against an MCP server
(`run_exam`), list the runtimes and exams available (`get_proctor_metadata`),
and manage the Fly machines exams run on (`get_machines`, `destroy_machine`,
`cancel_exam`), through the Proctor API on `https://admin.pulsemcp.com`.

**Regime: VENDOR.** `shared/` is copied unchanged from
[`pulsemcp/mcp-servers` `experimental/proctor/shared`](https://github.com/pulsemcp/mcp-servers/tree/main/experimental/proctor),
vendored at `cca9d52`. **Do not edit `shared/` here.** A fix to it lands in
strad, by promoting this tree to PATCHED VENDOR or FORK first (a delta table
here and a `HACKS.md` entry, or a `FORK.md`), never as a silent edit a
re-vendor would undo.

## Layout

```
servers/proctor/
  shared/   # VENDORED VERBATIM: the five tools and the Proctor API client
  test/     # strad's suite, outside the vendored tree
```

There is no `remote/`. The bundle host (`servers/bundle/host/src/index.ts`,
`loadPulseAdmin`) imports `createMCPServer` from the built `shared/` and passes
it a client factory.

## Environment

| Variable          | Required | What it is                                                                                     |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `PROCTOR_API_KEY` | yes      | A PulseMCP admin API key, sent as `X-API-Key`. The same keys `pulsemcp-cms-admin` takes.       |
| `PROCTOR_API_URL` | no       | The API origin. Defaults to `https://admin.pulsemcp.com`.                                      |

The image is credential-free. With no key the mount still lists its tools,
reports itself degraded, and every call fails naming the variable.

**One instance per key**, exactly as `pulsemcp-cms-admin`: a slug at
`path: /<its own slug>` whose `env:` sets `PROCTOR_API_KEY` gets its own mount,
reading its own key and URL. A read-only slug allows `get_proctor_metadata` and
`get_machines`. See `docs/src/content/docs/servers/pulsemcp-admin.md`.

`run_exam` streams an exam to completion inside one tool call, so a long exam
holds the call open for as long as it runs.

Run `npm test` here for the suite.
