/**
 * The download bound, applied where it can actually refuse something.
 *
 * `size` is OPTIONAL on Drive's file metadata, and the pre-check is the only
 * place it is used — so on a file Drive declares no size for, a bound applied
 * after `arrayBuffer()` has already allocated the whole body is not a bound at
 * all. This process shares 2GB with twenty-one other MCP servers.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { MAX_DOWNLOAD_BYTES, downloadFile } from "../src/drive-client/lib/files.js";

const HEADERS = { Authorization: "Bearer t" };
const realFetch = globalThis.fetch;

/** A response whose body streams `chunks` MB and advertises no length. */
function streaming(megabytes) {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent >= megabytes) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    }),
    { status: 200 },
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the cap is enforced on the stream, not after the body is in memory", async () => {
  let pulled = 0;
  globalThis.fetch = async () => {
    const chunk = new Uint8Array(1024 * 1024);
    return new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
  };

  // An endless body with no content-length: the only thing that can stop it is
  // the running total.
  await assert.rejects(downloadFile(HEADERS, "id"), /past the 20MB this server will download/);
  // It stopped at the cap rather than reading on.
  assert.ok(pulled <= MAX_DOWNLOAD_BYTES / (1024 * 1024) + 2, `pulled ${pulled} chunks`);
});

test("an advertised content-length past the cap is refused before a byte is read", async () => {
  let pulled = 0;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      }),
      { status: 200, headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) } },
    );

  await assert.rejects(downloadFile(HEADERS, "id"), /past the 20MB this server will download/);
  // At most the one chunk the stream implementation pulls eagerly on
  // construction — nothing this code asked for, and kilobytes rather than the
  // 20MB+ the header advertised.
  assert.ok(pulled <= 1, `pulled ${pulled} chunks`);
});

test("a file inside the cap comes back whole, byte for byte", async () => {
  globalThis.fetch = async () => streaming(3);
  const bytes = await downloadFile(HEADERS, "id");
  assert.equal(bytes.byteLength, 3 * 1024 * 1024);
});

test("the declared size is still a pre-check, so an oversized file is never fetched", async () => {
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return streaming(1);
  };
  await assert.rejects(
    downloadFile(HEADERS, "id", String(MAX_DOWNLOAD_BYTES + 1)),
    /past the 20MB this server will download/,
  );
  assert.equal(fetched, false);
});
