/**
 * When the Drive path is taken, what it costs, and what it says when it cannot.
 *
 * Three properties this file exists to hold:
 *
 *   1. A NATIVE spreadsheet is untouched. No Drive request, no extra latency,
 *      no dependence on a scope nobody consented for. A regression here would
 *      break every slug in production at once, and would look like a Drive
 *      outage rather than like this change.
 *   2. An OFFICE file takes the new path — the whole point.
 *   3. A slug WITHOUT the Drive scope gets a message naming the scope, the
 *      config field, the Reconnect button and the zero-scope alternative.
 *      Google's own answer is "Request had insufficient authentication scopes",
 *      which says nothing about which scope or where to add it.
 */
import { test, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { GoogleApiError } from "../src/google-sheets-client/lib/api-errors.js";
import {
  DRIVE_READONLY_SCOPE,
  OfficeWorkbookLoader,
  isOfficeFileError,
  officeWriteRefusal,
  readWithOfficeFallback,
  writeRefusingOfficeFiles,
} from "../src/office/load.js";
import { MAX_DOWNLOAD_BYTES } from "../src/drive-client/lib/files.js";
import { workbookValueRange } from "../src/office/to-sheets.js";
import { XLSX_MIME, xlsxFixture } from "./fixtures/workbook.js";

/** Exactly what the Sheets API answers for an uploaded .xlsx. */
const officeFileError = () =>
  new GoogleApiError(
    400,
    "client",
    "Bad request (Get values A1:B2): 400 Bad Request - FAILED_PRECONDITION: This operation " +
      "is not supported for this document. The document must not be an Office file.",
  );

const FILE_ID = "1qR8s_office_file_id";

let calls = [];
const realFetch = globalThis.fetch;

/** A Drive stub: metadata, then media, with per-call overrides. */
function stubDrive(responses) {
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const kind = target.includes("alt=media") ? "media" : "metadata";
    const responder = responses[kind];
    if (!responder) throw new Error(`unexpected ${kind} call to ${target}`);
    return responder();
  };
}

const okJson = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const googleError = (status, message, statusText = "Forbidden") =>
  new Response(JSON.stringify({ error: { code: status, message, status: "PERMISSION_DENIED" } }), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });

const metadata = (overrides = {}) =>
  okJson({ id: FILE_ID, name: "Master tracker.xlsx", mimeType: XLSX_MIME, ...overrides });

const loader = () => new OfficeWorkbookLoader(async () => ({ Authorization: "Bearer t" }), "https://strad.example/ui/google-sheets-personal-ro");

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a native spreadsheet never reaches Drive", async () => {
  stubDrive({});
  let workbookLoads = 0;
  const result = await readWithOfficeFallback(
    async () => "the sheets api answer",
    async () => {
      workbookLoads += 1;
      return "the drive answer";
    },
  );
  assert.equal(result, "the sheets api answer");
  assert.equal(workbookLoads, 0);
  assert.deepEqual(calls, []);
});

test("only FAILED_PRECONDITION diverts; a 404 or a 403 propagates unchanged", async () => {
  for (const error of [
    new GoogleApiError(404, "not_found", "Not found (Get values): 404"),
    new GoogleApiError(403, "forbidden", "Permission denied (Get values): 403"),
    new GoogleApiError(500, "server", "Google API server error"),
    new Error("the network went away"),
  ]) {
    assert.equal(isOfficeFileError(error), false);
    await assert.rejects(
      readWithOfficeFallback(
        () => Promise.reject(error),
        () => Promise.reject(new Error("must not be reached")),
      ),
      (thrown) => thrown === error,
    );
  }
  assert.equal(isOfficeFileError(officeFileError()), true);
});

test("an Office file is downloaded from Drive and read", async () => {
  stubDrive({
    metadata: () => metadata(),
    media: () => new Response(xlsxFixture(), { status: 200 }),
  });

  const office = loader();
  const valueRange = await readWithOfficeFallback(
    () => Promise.reject(officeFileError()),
    async () => workbookValueRange(await office.load(FILE_ID), "'Q1 2026'!A1:B2"),
  );

  assert.deepEqual(valueRange.values, [
    ["Net worth", "Q1"],
    ["Roth IRA", 12345.67],
  ]);
  assert.equal(valueRange.officeSource?.mimeType, XLSX_MIME);
  // Shared drives are reachable, which is the least diagnosable 404 on this path.
  assert.equal(calls.length, 2);
  for (const call of calls) assert.match(call, /supportsAllDrives=true/);
  assert.match(calls[0], /drive\/v3\/files\/1qR8s_office_file_id\?/);
  assert.match(calls[1], /alt=media/);
});

test("one tool call that reads twice downloads once", async () => {
  let downloads = 0;
  stubDrive({
    metadata: () => metadata(),
    media: () => {
      downloads += 1;
      return new Response(xlsxFixture(), { status: 200 });
    },
  });

  // This is find_in_spreadsheet's shape: the map, then every tab.
  const office = loader();
  const [first, second] = await Promise.all([office.load(FILE_ID), office.load(FILE_ID)]);
  await office.load(FILE_ID);
  assert.equal(downloads, 1);
  assert.equal(first, second);
});

test("a missing Drive scope names the scope, the field and the button", async () => {
  stubDrive({
    metadata: () =>
      googleError(403, "Request had insufficient authentication scopes.", "Forbidden"),
  });

  await assert.rejects(loader().load(FILE_ID), (error) => {
    const { message } = error;
    // What is wrong, in the caller's terms rather than Google's.
    assert.match(message, /because it is an Office-format file/);
    // The exact scope, and that it goes in the config.
    assert.ok(message.includes(DRIVE_READONLY_SCOPE));
    assert.match(message, /oauth: scopes:/);
    // Consent does not follow a config edit — the trap this sentence exists for.
    assert.match(message, /a scope added to a config does not reach an already-minted refresh token/);
    assert.match(message, /Reconnect Google on https:\/\/strad\.example\/ui\/google-sheets-personal-ro/);
    // And the route that needs no scope change at all.
    assert.match(message, /File > Save as Google Sheets/);
    return true;
  });
});

test("a failed load is not cached, so the retry after the fix is a real one", async () => {
  let attempt = 0;
  stubDrive({
    metadata: () => {
      attempt += 1;
      return attempt === 1
        ? googleError(403, "Request had insufficient authentication scopes.")
        : metadata();
    },
    media: () => new Response(xlsxFixture(), { status: 200 }),
  });

  const office = loader();
  await assert.rejects(office.load(FILE_ID));
  const workbook = await office.load(FILE_ID);
  assert.equal(workbook.sheets.length, 3);
});

test("a file the account cannot see is not reported as a scope problem", async () => {
  stubDrive({
    metadata: () => googleError(404, "File not found: xyz.", "Not Found"),
  });
  await assert.rejects(loader().load(FILE_ID), (error) => {
    assert.match(error.message, /no file with that id visible to this slug's account/);
    assert.ok(!error.message.includes(DRIVE_READONLY_SCOPE));
    return true;
  });
});

test("a format neither the Sheets API nor this server can read says which it is", async () => {
  stubDrive({
    metadata: () => metadata({ mimeType: "application/vnd.ms-excel", name: "old.xls" }),
  });
  await assert.rejects(loader().load(FILE_ID), /legacy \.xls workbook/);
  // Refused on the metadata alone: no download is spent on a file we cannot parse.
  assert.equal(calls.length, 1);
});

test("a workbook too large to hold in memory is refused before it is downloaded", async () => {
  stubDrive({
    metadata: () => metadata({ size: String(MAX_DOWNLOAD_BYTES + 1) }),
  });
  await assert.rejects(loader().load(FILE_ID), /past the 20MB this server will download/);
  assert.equal(calls.length, 1);
});

test("a write against an Office file refuses, and says reads work", async () => {
  await assert.rejects(
    writeRefusingOfficeFiles("update_sheet_values", FILE_ID, () =>
      Promise.reject(officeFileError()),
    ),
    (error) => {
      assert.match(error.message, /update_sheet_values cannot edit 1qR8s_office_file_id/);
      assert.match(error.message, /strad can READ such a file/);
      assert.match(error.message, /File > Save as Google Sheets/);
      return true;
    },
  );
  assert.match(officeWriteRefusal("add_sheet", "x").message, /add_sheet cannot edit x/);

  // A write that fails for any other reason is not re-narrated.
  const other = new GoogleApiError(403, "forbidden", "Permission denied (Update values)");
  await assert.rejects(
    writeRefusingOfficeFiles("update_sheet_values", FILE_ID, () => Promise.reject(other)),
    (thrown) => thrown === other,
  );
});
