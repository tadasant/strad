/**
 * The two inputs a model types by hand: a search, and an id it may have pasted
 * as a URL. A `'` in a file name that reaches Drive unescaped is a 400 that reads
 * like a broken server; a URL taken for an id is a 404 that reads like a
 * missing file.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { buildQuery, quote, resolveOrderBy } from "../src/utils/query.js";
import { parseFileId } from "../src/utils/file-id.js";
import { inferMimeType, isTextMimeType } from "../src/utils/mime.js";

test("quote escapes backslashes and single quotes", () => {
  assert.equal(quote("Tadas's notes"), "'Tadas\\'s notes'");
  assert.equal(quote("a\\b"), "'a\\\\b'");
  // A value cannot close the literal and add a term of its own.
  assert.equal(quote("x' or name contains '"), "'x\\' or name contains \\''");
});

test("no filters means every file not in the trash", () => {
  assert.equal(buildQuery({}), "trashed = false");
  assert.equal(buildQuery({ includeTrashed: true }), "");
});

test("filters combine with AND", () => {
  assert.equal(
    buildQuery({ query: "Acme", type: "document", folderId: "F1", sharedWithMe: true }),
    "fullText contains 'Acme' and mimeType = 'application/vnd.google-apps.document' and 'F1' in parents and sharedWithMe = true and trashed = false",
  );
  assert.equal(buildQuery({ nameContains: "budget", type: "image" }), "name contains 'budget' and mimeType contains 'image/' and trashed = false");
});

test("modified_after is normalised to RFC 3339, and garbage is refused", () => {
  assert.equal(buildQuery({ modifiedAfter: "2026-10-01" }), "modifiedTime > '2026-10-01T00:00:00.000Z' and trashed = false");
  assert.throws(() => buildQuery({ modifiedAfter: "last week" }), /ISO 8601/);
});

test("type and mime_type together is refused rather than silently ANDed", () => {
  assert.throws(() => buildQuery({ type: "pdf", mimeType: "text/csv" }), /not both/);
});

test("a full-text search is not sorted, and asking to sort one is refused", () => {
  assert.equal(resolveOrderBy(false, undefined), "modifiedTime desc");
  assert.equal(resolveOrderBy(false, "name"), "name_natural");
  assert.equal(resolveOrderBy(true, undefined), undefined);
  assert.throws(() => resolveOrderBy(true, "modified"), /relevance/);
});

test("parseFileId takes an id or any URL a human would paste", () => {
  const id = "1hX9aBcDeFgHiJkLmNoPqRsTuVwXyZ012";
  for (const input of [
    id,
    ` ${id} `,
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/drive/folders/${id}`,
    `https://drive.google.com/drive/u/0/folders/${id}`,
    `https://docs.google.com/document/d/${id}/edit#heading=h.1`,
    `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
    `https://docs.google.com/presentation/d/${id}/edit`,
  ]) {
    assert.equal(parseFileId(input), id, input);
  }
});

test("parseFileId refuses what is not an id", () => {
  assert.throws(() => parseFileId("Q3 board deck"), /neither a Drive file id/);
  assert.equal(parseFileId("root"), "root");
  assert.throws(() => parseFileId("https://drive.google.com/drive/my-drive"), /No file id/);
});

test("text detection and upload-type inference", () => {
  for (const t of ["text/plain", "text/csv", "application/json", "application/ld+json", "image/svg+xml"]) {
    assert.equal(isTextMimeType(t), true, t);
  }
  for (const t of ["application/pdf", "image/png", "application/zip"]) {
    assert.equal(isTextMimeType(t), false, t);
  }
  assert.equal(inferMimeType("notes.MD"), "text/markdown");
  assert.equal(inferMimeType("q3.csv"), "text/csv");
  assert.equal(inferMimeType("README"), "text/plain");
});
