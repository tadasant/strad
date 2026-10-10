---
title: Image diff and SVG tracer
description: Two image servers that take URLs rather than file paths — compare two images and box what differs, or trace a bitmap into an SVG — and the guard and bounds that make that safe from inside the bundle.
---

`image-diff` and `svg-tracer` are strad's own MCP servers, two mounts over one
tree: source in `servers/image-tools/`, served at `/image-diff` and
`/svg-tracer` inside the bundle image. Neither holds a credential.

They replace the `@pulsemcp/image-diff-mcp-server` and
`@pulsemcp/svg-tracer-mcp-server` npx packages, which an agent ran as a local
subprocess. Those read an image from a **path on the agent's disk** and wrote
their output back to it. A server in strad's bundle cannot see that disk, so
the one real change is at the edges: **inputs are URLs, and results come back
in the response.** Tool names, parameters and the algorithms behind them stay
as close to the packages as that allows.

## Getting an image to the tools

Upload the file to the [artifact store](/servers/artifact-store/)
(`upload_file`) and pass the signed link it returns. Pass it **whole**: the
query string is the signature, and a link cut at the `?` answers `403`. Any
other public `http(s)` URL works the same way.

A caller that still sends the packages' path arguments (`source_image`,
`input_path`, `output_path`) gets an error saying what to send instead, rather
than "unknown argument".

## `get_diff_of_images` (image-diff)

Compares two images pixel by pixel (pixelmatch's YIQ colour distance, with
anti-aliased pixels counted separately), groups the differing pixels into
clusters, and rates each cluster `trivial`, `minor`, `moderate` or `major`.

| Parameter          | Default     | What it does                                                                          |
| ------------------ | ----------- | ------------------------------------------------------------------------------------- |
| `source_image_url` | _required_  | The reference image, e.g. the design mock.                                            |
| `target_image_url` | _required_  | The comparison image, e.g. the screenshot.                                            |
| `threshold`        | `0.1`       | Colour sensitivity, 0–1. `0.05` is strict, `0.2` lenient.                             |
| `include_aa`       | `false`     | Count anti-aliased pixels as differences.                                             |
| `min_cluster_size` | `4`         | Smallest cluster reported, in pixels.                                                 |
| `cluster_gap`      | automatic   | Merge clusters within this many pixels. Omit for natural breaks; `0` never merges.    |
| `max_clusters`     | `50`        | Most clusters listed, largest first (max 200). `summary.clusterCount` is the total.   |
| `return_images`    | `composite` | `composite` (heatmap over the source), `heatmap`, `both` or `none`.                   |

The result is JSON followed by the images asked for, as PNG image content. An
image longer than 1568px on either edge comes back downscaled, and
`images[].scale` says by how much; cluster boxes are always in full-resolution
pixels of the compared region. An identical pair returns no images.

**Different sizes.** When the images differ in size, the smaller is located
inside the larger and only that region is compared; `alignment` reports where
and how confident. The search is zero-mean normalised cross-correlation — what
OpenCV's `matchTemplate` computes — done by FFT over every position at full
resolution, so a crop out of a page of near-identical text lines lands on the
right line. The packages ran it on a downscaled pair, which on text picks a
neighbouring line. A scene too large for one FFT is downscaled only as far as
it must be, and its best few candidates are refined at full resolution.

## `trace_bitmap_to_svg` (svg-tracer)

Traces a bitmap into a one-colour SVG with potrace. A transparent PNG is
first flattened to a mask of its alpha, so a logo on a transparent background
traces as its shape.

| Parameter                        | Default         | What it does                                                        |
| -------------------------------- | --------------- | ------------------------------------------------------------------- |
| `image_url`                      | _required_      | The bitmap.                                                         |
| `threshold`                      | `128`           | Black/white cut-off, 0–255.                                         |
| `turd_size`                      | `2`             | Speckles up to this many pixels are dropped.                        |
| `opt_tolerance`                  | `0.2`           | Curve simplification, 0–1.                                          |
| `color`                          | `#000000`       | Fill for every path.                                                |
| `background`                     | `transparent`   | Or a hex colour.                                                    |
| `target_width` / `target_height` | the bitmap's    | Scale into this viewBox, aspect ratio kept.                         |

The SVG comes back as a string in the JSON. `output_path` is gone: nothing is
written anywhere, so save the string where it is needed.

## What it will not fetch

These tools fetch a URL a caller chose, from inside a container that sits on
the app's private network beside every other mount and core. So the fetch
refuses, at the connector and on every redirect hop:

- any scheme but `http` and `https`, and a URL carrying a username or password;
- loopback, private (RFC 1918), carrier-grade NAT, link-local (including the
  `169.254.169.254` metadata address) and the IPv6 forms of all of them,
  including IPv6 spellings that embed an IPv4 address;
- `localhost`, single-label names (how App Platform addresses a component),
  and `*.internal`, `*.local` and the rest of the private-name space;
- a public name that **resolves** to any of the above.

No error quotes a URL's query string, because for a signed link the query is
the credential. `IMAGE_TOOLS_ALLOW_PRIVATE_HOSTS` is a comma-separated list of
hosts to let through anyway, for a development gateway; it is unset in every
deployment.

## Bounds

| Bound              | Value         | Why                                                                 |
| ------------------ | ------------- | ------------------------------------------------------------------- |
| Image size         | 25 MB         | Checked from `content-length` and again while streaming.            |
| Image pixels       | 10 megapixels | Read from the header **before** decoding, so a decompression bomb never allocates. |
| Fetch              | 30 s          | Per image, redirects included (at most 5).                          |
| Job                | 60 s          | The CPU work runs in a worker thread, terminated at the deadline.   |
| Concurrency        | 1 job         | Per bundle process, across both servers. Two more callers may wait, 20 s each, then get "Busy"; past two, "Busy" at once. |
| Returned image     | 1568 px edge  | Past this a model downsamples anyway.                               |
| Returned SVG       | 1M characters | Past this the trace needs simplifying, and the error says how.      |

Fetch, wait and job add up to 110 seconds, under core's default per-call
`timeoutMs` of 120, so a slow call ends in one of these sentences rather than a
bare gateway timeout. A cancelled call leaves the queue, or has its worker
stopped, and frees the slot.

AVIF is accepted. HEIC (an iPhone's default) is not: sharp's prebuilt libvips
cannot decode HEVC, so convert it to JPEG or PNG first.

The worker thread is the reason the bundle's other mounts do not notice a
large diff: the pixel loops, the clustering, the FFT and potrace are all plain
JavaScript, and on the main thread they would stall every mount's requests and
the health check App Platform polls.

See [limitations](/limitations/#120-image-diff-and-svg-tracer-read-urls-not-files-and-run-one-job-at-a-time).
