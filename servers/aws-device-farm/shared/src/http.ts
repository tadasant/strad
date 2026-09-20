/**
 * The shape of `fetch` this server depends on, and nothing more.
 *
 * Node 22's global `fetch` satisfies this structurally, and so does a five-line
 * fake — which is the point. Two very different things are spoken over HTTP
 * here: the device's Appium endpoint, and a build download followed by a
 * pre-signed S3 PUT. Both are injected, so the whole suite runs with no network
 * and no AWS account, and neither is written against a library that would have
 * to be mocked at the module level.
 */

export interface FetchResponse {
  ok: boolean;
  status: number;
  /**
   * The URL the response actually came from, after redirects. Present on a
   * real `fetch`; a fake may omit it. It is what lets a download refuse an
   * `https://` source that redirected to `http://`, which the Fetch spec
   * permits and follows silently.
   */
  url?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /**
   * Present on a real `fetch`, absent on the simplest fakes. Streaming is what
   * lets an oversized download be abandoned mid-flight rather than discovered
   * after it has been held in memory.
   */
  body?: ReadableStream<Uint8Array> | null;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

/**
 * A deadline for one outbound request.
 *
 * Every call this server makes over plain HTTP carries one. Device Farm caps an
 * Appium command at four minutes server-side, but a source URL that drips
 * bytes for an hour is bounded by nothing else, and a tool call that never
 * returns is a phone billing by the minute with nobody driving it.
 */
export function deadline(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/** The global `fetch`, narrowed to the shape above. */
export function globalFetch(): FetchLike {
  return globalThis.fetch as unknown as FetchLike;
}
