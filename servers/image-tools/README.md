# image-tools — image-diff and svg-tracer

strad's own image servers, two MCP servers over one tree, mounted in the bundle
at `/image-diff` and `/svg-tracer`:

| Server       | Tool                  | Ported from                         |
| ------------ | --------------------- | ----------------------------------- |
| `image-diff` | `get_diff_of_images`  | `@pulsemcp/image-diff-mcp-server`   |
| `svg-tracer` | `trace_bitmap_to_svg` | `@pulsemcp/svg-tracer-mcp-server`   |

Both packages are MIT, PulseMCP's, and ran as local npx subprocesses that read a
path off the agent's disk. Here the inputs are **http(s) URLs** and the results
come back **in the response**. Prose: `docs/src/content/docs/servers/image-tools.md`.

## What differs from the packages

- **URLs in, nothing written.** `source_image` / `target_image` / `input_path`
  become `source_image_url` / `target_image_url` / `image_url`; `output_path` is
  gone. A caller sending an old name is told what to send instead.
- **Heatmap and composite are image content**, not files in the server's temp
  directory, downscaled to 1568px with the scale reported. `return_images`
  picks which. `max_clusters` caps the list; the total is still reported.
- **Alignment by FFT, without `opencv-wasm`.** Same measure
  (`TM_CCOEFF_NORMED`), computed exhaustively at full resolution where the
  packages searched a downscaled pair and, on pages of text, landed on the
  wrong line. `src/diff/alignment.ts`.
- **Clustering is bounded.** The packages' merge pass is all-pairs with a
  restart per merge, which on a noisy diff is quadratic in tens of thousands of
  clusters. Past 2000 the largest are kept and the rest counted.
- **Greyscale inputs decode to four channels.** The packages assumed RGBA.
- **SSRF guard, size and pixel bounds, a worker thread per job, one job at a
  time.** None of which an npx subprocess on the agent's own machine needed.

## Layout

```
shared/src/
  server.ts          createMCPServer("image-diff" | "svg-tracer", …)
  tools/             the two tool definitions, and the shared error path
  fetch-image.ts     guarded fetch: redirects by hand, byte cap, header check
  url-guard.ts       the SSRF guard (derived from strad-fetch's)
  jobs.ts, worker.ts the worker-thread runner and its gate
  limits.ts          every bound, in one place
  diff/              pixel diff, clustering, alignment (FFT), heatmap
  trace/             potrace
```

`npm test` builds first: `test/server.test.ts` drives both servers through a
real MCP client and the built `build/worker.js`.
