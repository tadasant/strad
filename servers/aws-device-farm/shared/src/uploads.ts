/**
 * Getting a build from wherever CI left it onto Device Farm, and knowing when
 * Device Farm has finished with it.
 *
 * THERE IS NO LOCAL FILE. This server runs in a container an agent cannot put a
 * file into, so an upload names a URL: the artifact CI published, or a
 * pre-signed link from strad's own artifact store. The bytes are fetched here
 * and PUT to the pre-signed S3 URL `CreateUpload` hands back.
 *
 * `CreateUpload` SUCCEEDING MEANS NOTHING. It reserves an ARN and a URL; the
 * build is checked afterwards, asynchronously, and a simulator .ipa fails there
 * — INITIALIZED, then FAILED, with the reason in `message`. An agent that
 * scheduled a run on the ARN without waiting would get a run that errors on
 * every device several paid minutes later. So this waits, and reports the
 * failure with Device Farm's own message.
 *
 * THE BYTES ARE BUFFERED, AND THAT IS A CHOICE WITH A BOUND. The pre-signed PUT
 * needs a `Content-Length`, and a source URL is not obliged to declare one. So
 * the download is read into memory — streamed with a running ceiling when the
 * source gives us a stream, so an oversized or endless body is abandoned
 * rather than absorbed. The ceiling is `AWS_DEVICE_FARM_MAX_UPLOAD_MB`, and it
 * is a real bound: the bundle is a 2 GB box shared with a Chromium.
 */

import { InputError, SourceFetchError, UploadFailedError } from "./errors.js";
import type { DeviceFarmGateway, UploadSummary } from "./gateway.js";
import { deadline, type FetchLike } from "./http.js";

/**
 * How long a download or the PUT may take. A 192 MB build over a slow link is
 * minutes; an hour is a source that is never going to finish.
 */
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;

/** Upload types this server will create. Anything else is a caller's typo. */
export const UPLOAD_TYPES = [
  "IOS_APP",
  "ANDROID_APP",
  "APPIUM_NODE_TEST_PACKAGE",
  "APPIUM_NODE_TEST_SPEC",
  "APPIUM_PYTHON_TEST_PACKAGE",
  "APPIUM_PYTHON_TEST_SPEC",
  "XCTEST_TEST_PACKAGE",
  "XCTEST_UI_TEST_PACKAGE",
  "XCTEST_UI_TEST_SPEC",
  "EXTERNAL_DATA",
] as const;

export type UploadType = (typeof UPLOAD_TYPES)[number];

/** The extension Device Farm demands for each type. `.zip` for everything else. */
export function expectedExtension(type: string): string {
  if (type === "IOS_APP") return ".ipa";
  if (type === "ANDROID_APP") return ".apk";
  return ".zip";
}

export interface UploadAppOptions {
  gateway: DeviceFarmGateway;
  fetchImpl: FetchLike;
  sourceUrl: string;
  name: string;
  type: string;
  maxBytes: number;
  /** How long to wait for Device Farm to finish processing. */
  timeoutMs: number;
  /** Injected in tests; production sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; production polls every few seconds. */
  pollMs?: number;
}

export interface UploadResult extends UploadSummary {
  bytes: number;
  /** False when the wait ran out with the upload still processing. */
  ready: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function download(
  fetchImpl: FetchLike,
  sourceUrl: string,
  maxBytes: number,
): Promise<Uint8Array> {
  let res;
  try {
    res = await fetchImpl(sourceUrl, {
      method: "GET",
      signal: deadline(TRANSFER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SourceFetchError(
      sourceUrl,
      `The build could not be fetched: ${
        err instanceof Error ? err.message : String(err)
      }. The URL has to be reachable from strad's container — a GitHub Actions ` +
        `artifact behind a login is not, a pre-signed link is.`,
    );
  }
  if (!res.ok) {
    throw new SourceFetchError(
      sourceUrl,
      `The build could not be fetched: the source answered HTTP ${res.status}. ` +
        `A 403 on a pre-signed link usually means it has expired.`,
      res.status,
    );
  }
  // The scheme is checked AGAIN here, on the URL the bytes actually came from.
  // `fetch` follows an https -> http redirect without comment, and a build
  // that arrived over plain HTTP is exactly what refusing an http source was
  // meant to prevent.
  if (res.url && !/^https:\/\//i.test(res.url)) {
    throw new SourceFetchError(
      sourceUrl,
      `The build's URL redirected to a non-https location, which is refused for ` +
        `the same reason an http source is: a build is what will run on a phone.`,
    );
  }

  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new InputError(
      `The build at that URL is ${Math.round(declared / 1024 / 1024)} MB, over ` +
        `this server's ${Math.round(maxBytes / 1024 / 1024)} MB ceiling. Raise ` +
        `AWS_DEVICE_FARM_MAX_UPLOAD_MB if the box can hold it.`,
    );
  }

  // The streaming path is the one that can REFUSE an oversized body rather than
  // discover it afterwards, which is what makes the ceiling a memory bound and
  // not a report.
  const stream = res.body;
  if (!stream) {
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new InputError(
        `The build at that URL is ${Math.round(buffer.byteLength / 1024 / 1024)} ` +
          `MB, over this server's ${Math.round(maxBytes / 1024 / 1024)} MB ceiling.`,
      );
    }
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new InputError(
        `The build at that URL is larger than this server's ` +
          `${Math.round(maxBytes / 1024 / 1024)} MB ceiling; the download was ` +
          `abandoned. Raise AWS_DEVICE_FARM_MAX_UPLOAD_MB if the box can hold it.`,
      );
    }
    chunks.push(value);
  }

  // One copy, and the chunks are released as soon as it is made: the transient
  // peak is about twice the build's size, which is the honest number the
  // ceiling in config.ts is documented against.
  const out = Buffer.concat(chunks, total);
  chunks.length = 0;
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** An upload status from which nothing further will happen. */
const SETTLED = new Set(["SUCCEEDED", "FAILED"]);

export async function uploadApp(options: UploadAppOptions): Promise<UploadResult> {
  const { gateway, fetchImpl, sourceUrl, name, type, maxBytes } = options;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 4000;

  if (!/^https:\/\//i.test(sourceUrl)) {
    throw new InputError(
      `\`source_url\` must be an https:// URL; got "${sourceUrl}". Plain HTTP ` +
        `is refused rather than downgraded — a build is what will run on a ` +
        `phone, and it arrives over a channel nobody can rewrite.`,
    );
  }
  if (name.includes("/")) {
    throw new InputError(
      "`name` is a file name, not a path: Device Farm rejects a name " +
        "containing a forward slash.",
    );
  }
  const wanted = expectedExtension(type);
  if (!name.toLowerCase().endsWith(wanted)) {
    throw new InputError(
      `A ${type} upload must be named "*${wanted}" — Device Farm refuses ` +
        `anything else, and the refusal does not say which rule it was.`,
    );
  }

  // The bytes are fetched BEFORE the upload is created. A source URL that is
  // wrong, expired or enormous is the likeliest failure here, and finding out
  // first is what keeps the project's upload list free of dead INITIALIZED
  // entries that look exactly like a build somebody is waiting on.
  const bytes = await download(fetchImpl, sourceUrl, maxBytes);

  const contentType = "application/octet-stream";
  const created = await gateway.createUpload({ name, type, contentType });
  if (!created.url) {
    throw new Error(
      "Device Farm created the upload and returned no pre-signed URL to put " +
        "the build to.",
    );
  }

  const put = await fetchImpl(created.url, {
    method: "PUT",
    // The content type matches what `CreateUpload` was told, because that is
    // what the URL was signed with; anything else is a 403 from S3.
    headers: { "content-type": contentType },
    body: bytes,
    signal: deadline(TRANSFER_TIMEOUT_MS),
  });
  if (!put.ok) {
    // Not a SourceFetchError: the source was fine, and a caller told "the
    // source answered 403" would go and check the wrong URL. This is Device
    // Farm's own storage refusing the bytes, most plausibly because the
    // pre-signed URL aged out during a long download.
    throw new Error(
      `Device Farm's pre-signed upload URL rejected the build with HTTP ` +
        `${put.status}. The download itself succeeded (${bytes.byteLength} ` +
        `bytes); the pre-signed PUT is what failed, and it is minted per call, ` +
        `so retrying upload_app mints a fresh one.`,
    );
  }

  const settleBy = Date.now() + options.timeoutMs;
  let latest = created.upload;
  for (;;) {
    latest = await gateway.getUpload(created.upload.arn);
    if (SETTLED.has(latest.status ?? "")) break;
    if (Date.now() >= settleBy) {
      return { ...latest, bytes: bytes.byteLength, ready: false };
    }
    await sleep(pollMs);
  }

  if (latest.status === "FAILED") {
    throw new UploadFailedError(latest.arn, latest.status, latest.message);
  }
  return { ...latest, bytes: bytes.byteLength, ready: true };
}
