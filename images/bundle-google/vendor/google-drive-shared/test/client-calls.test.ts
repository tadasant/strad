/**
 * What actually goes on the wire.
 *
 * None of this is visible to a credential-free smoke test, and each one decides
 * what a call reaches: a list without `supportsAllDrives` hides every shared
 * drive, a create that is not one multipart request can leave an empty file
 * behind, and a download read whole before the cap is not a cap.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import {
  createFile,
  createFolder,
  downloadFile,
  DriveFileTooLargeError,
  exportFile,
  getFile,
  listFiles,
} from "../src/drive-client/files.js";
import { DriveApiError } from "../src/drive-client/api-errors.js";

const HEADERS = { Authorization: "Bearer test" };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
let responses: Array<() => Response> = [];
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });
    const next = responses.shift();
    return next ? next() : new Response(JSON.stringify({ id: "new-id" }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a list searches every drive, and asks for the fields the renderer uses", async () => {
  responses.push(json({ files: [] }));
  await listFiles(HEADERS, { q: "trashed = false", pageSize: 25, orderBy: "modifiedTime desc" });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, "https://www.googleapis.com/drive/v3/files");
  assert.equal(url.searchParams.get("q"), "trashed = false");
  assert.equal(url.searchParams.get("corpora"), "allDrives");
  assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
  assert.equal(url.searchParams.get("supportsAllDrives"), "true");
  assert.equal(url.searchParams.get("pageSize"), "25");
  assert.equal(url.searchParams.get("orderBy"), "modifiedTime desc");
  assert.match(url.searchParams.get("fields")!, /incompleteSearch/);
  assert.match(url.searchParams.get("fields")!, /nextPageToken/);
  assert.equal(url.searchParams.has("pageToken"), false);
});

test("a list omits orderBy when there is none (a full-text search)", async () => {
  responses.push(json({ files: [] }));
  await listFiles(HEADERS, { q: "fullText contains 'x'", pageSize: 5, pageToken: "tok" });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.has("orderBy"), false);
  assert.equal(url.searchParams.get("pageToken"), "tok");
});

test("get, export and download address the file by encoded id", async () => {
  responses.push(json({ id: "a/b" }));
  await getFile(HEADERS, "a/b");
  assert.match(calls[0].url, /\/files\/a%2Fb\?/);
  assert.match(calls[0].url, /supportsAllDrives=true/);

  responses.push(() => new Response("# hi"));
  const exported = await exportFile(HEADERS, "doc1", "text/markdown", 1000);
  assert.equal(new TextDecoder().decode(exported), "# hi");
  const exportUrl = new URL(calls[1].url);
  assert.equal(exportUrl.pathname, "/drive/v3/files/doc1/export");
  assert.equal(exportUrl.searchParams.get("mimeType"), "text/markdown");

  responses.push(() => new Response("a,b"));
  await downloadFile(HEADERS, "csv1", 1000);
  assert.equal(new URL(calls[2].url).searchParams.get("alt"), "media");
});

test("a download stops at the cap even when no content-length is sent", async () => {
  const big = new Uint8Array(2048);
  responses.push(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(big);
            controller.enqueue(big);
            controller.close();
          },
        }),
      ),
  );
  await assert.rejects(downloadFile(HEADERS, "f", 3000), DriveFileTooLargeError);
});

test("a download is refused up front on an advertised content-length past the cap", async () => {
  responses.push(() => new Response("x".repeat(10), { headers: { "content-length": "999999" } }));
  await assert.rejects(downloadFile(HEADERS, "f", 1000), /past the/);
});

test("a folder is created as a folder, in the parent it was given", async () => {
  responses.push(json({ id: "fold1" }));
  await createFolder(HEADERS, "2026 receipts", "parent1");
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(call.body as string), {
    name: "2026 receipts",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["parent1"],
  });
});

test("a folder with no parent sends no parents, so Drive puts it in My Drive", async () => {
  await createFolder(HEADERS, "x");
  assert.equal("parents" in JSON.parse(calls[0].body as string), false);
});

test("a file is ONE multipart upload: metadata, then the bytes", async () => {
  await createFile(HEADERS, {
    name: "notes.md",
    mimeType: "text/markdown",
    content: new TextEncoder().encode("# Notes\n"),
    parentId: "p1",
    convertTo: "application/vnd.google-apps.document",
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  const url = new URL(call.url);
  assert.equal(url.origin + url.pathname, "https://www.googleapis.com/upload/drive/v3/files");
  assert.equal(url.searchParams.get("uploadType"), "multipart");
  assert.equal(url.searchParams.get("supportsAllDrives"), "true");
  const boundary = /boundary=(\S+)/.exec(call.headers["Content-Type"])![1];
  const body = Buffer.from(call.body as Uint8Array).toString("utf8");
  const parts = body.split(`--${boundary}`);
  // ["", metadata, media, "--\r\n"]
  assert.equal(parts.length, 4);
  assert.match(parts[1], /Content-Type: application\/json/);
  const metadata = JSON.parse(parts[1].split("\r\n\r\n")[1]);
  // The metadata's type is the CONVERSION target; the media part is the upload's own type.
  assert.deepEqual(metadata, { name: "notes.md", mimeType: "application/vnd.google-apps.document", parents: ["p1"] });
  assert.match(parts[2], /Content-Type: text\/markdown\r\n\r\n# Notes\n\r\n$/);
  assert.equal(parts[3], "--\r\n");
});

test("binary content survives the multipart body byte for byte", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
  await createFile(HEADERS, { name: "a.png", mimeType: "image/png", content: bytes });
  const body = Buffer.from(calls[0].body as Uint8Array);
  assert.notEqual(body.indexOf(Buffer.from(bytes)), -1);
  const metadata = JSON.parse(body.toString("latin1").split("\r\n\r\n")[1].split("\r\n")[0]);
  assert.deepEqual(metadata, { name: "a.png", mimeType: "image/png" });
});

test("a 429 is retried once after Retry-After, and a second 429 is an error", async () => {
  responses.push(json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }));
  responses.push(json({ id: "ok" }));
  const file = await getFile(HEADERS, "f1");
  assert.equal(file.id, "ok");
  assert.equal(calls.length, 2);

  responses.push(json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }));
  responses.push(json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }));
  await assert.rejects(getFile(HEADERS, "f1"), (e: unknown) => e instanceof DriveApiError && e.category === "rate_limit");
  assert.equal(calls.length, 4);
});

test("Drive's 403 reasons are told apart, each with its own recovery", async () => {
  const cases: Array<[string, RegExp, DriveApiError["category"]]> = [
    ["insufficientPermissions", /drive\.readonly.*drive\.file/s, "forbidden"],
    ["exportSizeLimitExceeded", /10MB/, "forbidden"],
    ["userRateLimitExceeded", /throttling/, "rate_limit"],
    ["appNotAuthorizedToFile", /create_folder first/, "forbidden"],
  ];
  for (const [reason, hint, category] of cases) {
    responses.push(json({ error: { code: 403, message: "nope", errors: [{ reason }] } }, 403));
    await assert.rejects(getFile(HEADERS, "f"), (e: unknown) => {
      assert.ok(e instanceof DriveApiError);
      assert.equal(e.reason, reason);
      assert.equal(e.category, category);
      assert.match(e.message, hint);
      return true;
    });
  }
});

test("a 404 says the file is not visible to this account", async () => {
  responses.push(json({ error: { code: 404, message: "File not found: x." } }, 404));
  await assert.rejects(getFile(HEADERS, "x"), /No file or folder with that id is visible/);
});
