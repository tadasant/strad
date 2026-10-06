import { UpstreamConnectError } from "./upstream.ts";

/**
 * `oauthRefresh.discoveryProxy: { via: brightdata }` — a `fetch` for Connect's
 * metadata GETs that goes through BrightData's Web Unlocker instead of out of
 * strad's own egress.
 *
 * Why it exists: Rippling's MCP server answers `/mcp` to a cloud provider's
 * address and serves Cloudflare's block page on every other path on that host,
 * its RFC 9728 metadata included. The documents are public, so reading them
 * through an unblocking proxy changes who fetches them and nothing about what
 * they say — and every check discovery makes on a fetched document is made on
 * a proxied one. It is still a workaround for the upstream's bot protection,
 * and it hands the upstream's metadata URLs to a third party; that is why it is
 * opt-in per slug rather than a gateway-wide egress.
 *
 * GET ONLY, and only the metadata. A POST here would be a registration, a
 * code exchange or a refresh — a credential travelling through the proxy — so
 * the function refuses anything but a GET rather than trusting its callers.
 *
 * The same request API and zone strad-fetch's BrightData strategy uses
 * (servers/strad-fetch/FORK.md), with `format: "json"` so the target's own
 * status comes back: discovery's 404-means-try-the-next-path rule needs it.
 * Nothing from the proxy's own error body is read for text.
 */

/** BrightData's Web Unlocker request endpoint. */
export const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";

/** The store variable the key is read from, in the `apiKeyFrom` slug's namespace. */
export const BRIGHTDATA_KEY_VARIABLE = "BRIGHTDATA_API_KEY";

/**
 * `direct` first; the proxy only for a document that answered strad 403.
 *
 * So a slug that opts in sends nothing to the proxy while the upstream serves
 * strad, and the proxy's key is not even read until it is needed.
 */
export function proxiedOn403(
  direct: typeof fetch,
  proxied: typeof fetch,
): typeof fetch {
  return (async (target: unknown, init?: RequestInit): Promise<Response> => {
    const res = await direct(target as string, init);
    if (res.status !== 403) return res;
    await res.body?.cancel().catch(() => undefined);
    return proxied(target as string, init);
  }) as typeof fetch;
}

export function brightDataFetch(
  input: {
    /** Read when the first request goes through, not before. */
    apiKey: () => Promise<string>;
    zone: string;
  },
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return (async (target: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(target);
    if ((init?.method ?? "GET").toUpperCase() !== "GET") {
      throw new Error("discovery proxy: only a metadata GET may be proxied");
    }
    const res = await fetchImpl(BRIGHTDATA_REQUEST_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${await input.apiKey()}`,
      },
      body: JSON.stringify({ zone: input.zone, url, format: "json" }),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamConnectError(
        "proxy_failed",
        `BrightData would not fetch ${url} for strad (HTTP ${res.status}). ` +
          `A 401 or 403 there is the API key or the zone, not the upstream. ` +
          `Nothing was registered or written.`,
        res.status,
      );
    }
    let envelope: unknown;
    try {
      envelope = await res.json();
    } catch {
      envelope = null;
    }
    const e = envelope as {
      status_code?: unknown;
      body?: unknown;
    } | null;
    if (!e || typeof e.status_code !== "number") {
      throw new UpstreamConnectError(
        "proxy_failed",
        `BrightData answered for ${url} without the target's status, so strad ` +
          `cannot tell a document from a refusal. Nothing was registered or ` +
          `written.`,
      );
    }
    const body = typeof e.body === "string" ? e.body : "";
    // The target's status, and its body as the body. No `url` on the answer:
    // the proxy does not follow redirects for strad, so there is no final
    // address to check beyond the one asked for, which discovery already
    // allowed.
    return new Response(
      e.status_code === 204 || e.status_code === 304 ? null : body,
      {
        status:
          e.status_code < 200 || e.status_code > 599 ? 502 : e.status_code,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
}
