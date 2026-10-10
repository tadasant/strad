/**
 * Fetch one image by URL, inside the guard and the budget.
 *
 * Redirects are followed BY HAND, so each hop's URL is put through
 * `assertFetchableUrl` before it is requested — the dispatcher would refuse a
 * private hop at connect time anyway, but this way a `file:` or `ftp:` hop is
 * refused with a sentence, and the hop count is ours to cap.
 */
import sharp from "sharp";
import { fetch, type Agent } from "undici";

import type { Limits } from "./limits.js";
import {
  assertFetchableUrl,
  blockedUrlCause,
  BlockedUrlError,
  describeUrl,
} from "./url-guard.js";

/** A failure the caller can act on, worded for them. */
export class ImageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

/** Formats sharp decodes that these tools accept. SVG is not one of them: it is not a bitmap. */
export const ACCEPTED_FORMATS = new Set([
  "png",
  "jpeg",
  "webp",
  "gif",
  "tiff",
  "avif",
]);

/** Redirect statuses that are followed. A 304 carries a Location too, and is not one. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The name a caller knows a format by. sharp reports AVIF as `heif` with AV1
 * compression; a HEIC photo is also `heif`, with HEVC, and sharp's prebuilt
 * libvips cannot decode that one, so it stays refused.
 */
function formatName(meta: sharp.Metadata): string | undefined {
  if (meta.format === "heif")
    return meta.compression === "av1" ? "avif" : "heic";
  return meta.format;
}

export interface FetchedImage {
  bytes: Uint8Array;
  format: string;
  width: number;
  height: number;
}

export interface FetchImageOptions {
  limits: Limits;
  dispatcher: Agent;
  allowed: ReadonlySet<string>;
  /** Which argument this is, for messages: "source_image_url". */
  label: string;
  /** The caller's cancellation: a client that gave up, or core's timeout. */
  signal?: AbortSignal;
}

export async function fetchImage(
  input: string,
  options: FetchImageOptions,
): Promise<FetchedImage> {
  const { limits, dispatcher, allowed, label } = options;
  const deadline = AbortSignal.timeout(limits.fetchTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  let url = guard(input, allowed, label);

  try {
    for (let hop = 0; ; hop++) {
      const response = await fetch(url, {
        dispatcher,
        redirect: "manual",
        signal,
      });

      if (REDIRECTS.has(response.status) && response.headers.get("location")) {
        await response.body?.cancel();
        if (hop >= limits.maxRedirects) {
          throw new ImageInputError(
            `${label}: more than ${limits.maxRedirects} redirects.`,
          );
        }
        url = guard(
          new URL(response.headers.get("location")!, url).href,
          allowed,
          label,
        );
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new ImageInputError(
          `${label}: ${describeUrl(url)} answered HTTP ${response.status}.` +
            (response.status === 403 || response.status === 400
              ? " A signed link may have expired or been truncated — refresh it (remote-filesystem " +
                "refresh_link) and pass the whole URL, query string included."
              : ""),
        );
      }

      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        await response.body?.cancel();
        throw tooLarge(label, declared, limits.maxBytes);
      }

      const bytes = await readCapped(response.body, limits.maxBytes, label);
      return await inspect(bytes, limits, label);
    }
  } catch (err) {
    if (err instanceof ImageInputError) throw err;
    const blocked = blockedUrlCause(err);
    if (blocked) throw new ImageInputError(`${label}: ${blocked.message}`);
    if (options.signal?.aborted)
      throw new ImageInputError(`${label}: the call was cancelled.`);
    if (deadline.aborted) {
      throw new ImageInputError(
        `${label}: fetching ${describeUrl(url)} took longer than ${limits.fetchTimeoutMs / 1000}s.`,
      );
    }
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new ImageInputError(
      `${label}: could not fetch ${describeUrl(url)}: ${err instanceof Error ? err.message : String(err)}` +
        (cause ? ` (${cause})` : ""),
    );
  }
}

function guard(
  input: string,
  allowed: ReadonlySet<string>,
  label: string,
): URL {
  try {
    return assertFetchableUrl(input, allowed);
  } catch (err) {
    if (err instanceof BlockedUrlError)
      throw new ImageInputError(`${label}: ${err.message}`);
    throw err;
  }
}

function tooLarge(label: string, size: number, max: number): ImageInputError {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  return new ImageInputError(
    `${label}: the image is ${mb(size)}; the limit is ${mb(max)}.`,
  );
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  if (!body) throw new ImageInputError(`${label}: the response had no body.`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ImageInputError(
        `${label}: the image is larger than the ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Read the header only — format and dimensions — and refuse here, in the main
 * thread, what the worker must never be asked to decode.
 */
async function inspect(
  bytes: Uint8Array,
  limits: Limits,
  label: string,
): Promise<FetchedImage> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new ImageInputError(
      `${label}: the response is not an image this server can read. Accepted: ${[...ACCEPTED_FORMATS].join(", ")}.`,
    );
  }
  const format = formatName(meta);
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw new ImageInputError(
      `${label}: ${format ?? "unknown"} is not accepted. Accepted: ${[...ACCEPTED_FORMATS].join(", ")}.`,
    );
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width * height > limits.maxPixels) {
    throw new ImageInputError(
      `${label}: the image is ${width}x${height} (${(width * height).toLocaleString("en-US")} pixels); ` +
        `the limit is ${limits.maxPixels.toLocaleString("en-US")}. Crop or downscale it first.`,
    );
  }
  return { bytes, format, width, height };
}
