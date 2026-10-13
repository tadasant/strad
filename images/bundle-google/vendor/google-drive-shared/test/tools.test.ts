/**
 * The five tools against a fake Drive client: what each asks for, and what a
 * model reads back.
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { createDefaultClient, type IGoogleDriveClient } from "../src/server.js";
import type { DriveFile } from "../src/types.js";
import type { ListFilesParams, CreateFileRequest } from "../src/drive-client/files.js";
import { searchFilesTool } from "../src/tools/search-files.js";
import { getFileTool } from "../src/tools/get-file.js";
import { readFileTool, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from "../src/tools/read-file.js";
import { createFolderTool } from "../src/tools/create-folder.js";
import { createFileTool, MAX_UPLOAD_BYTES } from "../src/tools/create-file.js";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";

class FakeDrive implements IGoogleDriveClient {
  lists: ListFilesParams[] = [];
  exports: Array<[string, string, number]> = [];
  downloads: Array<[string, number]> = [];
  folders: Array<[string, string | undefined]> = [];
  creates: CreateFileRequest[] = [];
  files = new Map<string, DriveFile>();
  content = new Map<string, Uint8Array>();
  listResult = { files: [] as DriveFile[] } as { files: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean };

  add(file: DriveFile, content?: string | Uint8Array): this {
    this.files.set(file.id, file);
    if (content !== undefined) {
      this.content.set(file.id, typeof content === "string" ? new TextEncoder().encode(content) : content);
    }
    return this;
  }
  async listFiles(params: ListFilesParams) {
    this.lists.push(params);
    return this.listResult;
  }
  async getFile(id: string) {
    const f = this.files.get(id);
    if (!f) throw new Error(`Not found: ${id}`);
    return f;
  }
  async exportFile(id: string, mime: string, max: number) {
    this.exports.push([id, mime, max]);
    return this.content.get(id) ?? new Uint8Array();
  }
  async downloadFile(id: string, max: number) {
    this.downloads.push([id, max]);
    return this.content.get(id) ?? new Uint8Array();
  }
  async createFolder(name: string, parent?: string) {
    this.folders.push([name, parent]);
    return { id: "newfolder", name, webViewLink: "https://drive.google.com/drive/folders/newfolder" };
  }
  async createFile(req: CreateFileRequest) {
    this.creates.push(req);
    return { id: "newfile", name: req.name, mimeType: req.convertTo ?? req.mimeType, webViewLink: "https://x/newfile" };
  }
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

const ID = "1hX9aBcDeFgHiJkLmNoPqRsTuVwXyZ012";

test("search_files with no arguments lists recent files, out of the trash", async () => {
  const drive = new FakeDrive();
  drive.listResult = {
    files: [{ id: "a1", name: "Budget", mimeType: SHEET, modifiedTime: "2026-10-02T00:00:00Z", owners: [{ displayName: "Ana", emailAddress: "ana@example.com" }] }],
    nextPageToken: "NEXT",
  };
  const result = await searchFilesTool(() => drive).handler({});
  assert.deepEqual(drive.lists[0], { q: "trashed = false", pageSize: 25, pageToken: undefined, orderBy: "modifiedTime desc" });
  const out = text(result);
  assert.match(out, /\*\*Budget\*\* — id `a1`, Google Sheet, modified 2026-10-02T00:00:00Z, owner Ana <ana@example.com>/);
  assert.match(out, /page_token="NEXT"/);
});

test("search_files takes a folder URL, and warns on an incomplete search", async () => {
  const drive = new FakeDrive();
  drive.listResult = { files: [], incompleteSearch: true };
  const result = await searchFilesTool(() => drive).handler({ folder_id: `https://drive.google.com/drive/folders/${ID}`, query: "x" });
  assert.equal(drive.lists[0].q, `fullText contains 'x' and '${ID}' in parents and trashed = false`);
  assert.equal(drive.lists[0].orderBy, undefined);
  assert.match(text(result), /No files matched/);
  assert.match(text(result), /Incomplete search/);
});

test("search_files refuses a sort on a full-text search, and a limit past 100", async () => {
  const drive = new FakeDrive();
  const sorted = await searchFilesTool(() => drive).handler({ query: "x", order_by: "name" });
  assert.equal(sorted.isError, true);
  assert.match(text(sorted), /relevance/);
  const big = await searchFilesTool(() => drive).handler({ limit: 500 });
  assert.equal(big.isError, true);
  assert.match(text(big), /limit/);
  assert.equal(drive.lists.length, 0);
});

test("get_file renders sharing, and does not call a file private when Drive withheld the list", async () => {
  const drive = new FakeDrive()
    .add({
      id: ID,
      name: "Q3 plan",
      mimeType: DOC,
      owners: [{ displayName: "Ana", emailAddress: "ana@example.com" }],
      permissions: [
        { type: "user", role: "owner", emailAddress: "ana@example.com" },
        { type: "anyone", role: "reader" },
        { type: "user", role: "writer", emailAddress: "ben@example.com" },
      ],
      capabilities: { canEdit: false, canComment: true, canDownload: true },
    })
    .add({ id: "shared1", name: "S", mimeType: "application/pdf", shared: true });
  const out = text(await getFileTool(() => drive).handler({ file_id: `https://docs.google.com/document/d/${ID}/edit` }));
  assert.match(out, /\*\*Shared with:\*\* anyone with the link \(reader\); ben@example.com \(writer\)/);
  assert.match(out, /\*\*This account can:\*\* comment, download/);
  assert.match(out, /\*\*read_file:\*\* markdown, text, html/);

  const withheld = text(await getFileTool(() => drive).handler({ file_id: "shared1" }));
  assert.match(withheld, /did not return the sharing list/);
  assert.match(withheld, /not readable as text/);
});

test("read_file exports a Google Doc as Markdown by default, and pages it", async () => {
  const body = "a".repeat(30) + "b".repeat(30);
  const drive = new FakeDrive().add({ id: ID, name: "Q3 plan", mimeType: DOC }, body);
  const first = text(await readFileTool(() => drive).handler({ file_id: ID, max_chars: 30 }));
  assert.deepEqual(drive.exports[0], [ID, "text/markdown", MAX_TEXT_BYTES]);
  assert.match(first, /Google Doc "Q3 plan", exported as markdown — characters 0 to 30 of 60\. More: start_char=30/);
  assert.match(first, /\n\na{30}$/);

  const second = text(await readFileTool(() => drive).handler({ file_id: ID, max_chars: 30, start_char: 30 }));
  assert.match(second, /characters 30 to 60 of 60\.\n/);
  assert.doesNotMatch(second, /More:/);
  assert.match(second, /b{30}$/);

  const past = await readFileTool(() => drive).handler({ file_id: ID, start_char: 60 });
  assert.equal(past.isError, true);
});

test("read_file refuses a format the file type cannot export as", async () => {
  const drive = new FakeDrive().add({ id: ID, name: "Budget", mimeType: SHEET }, "a,b");
  const bad = await readFileTool(() => drive).handler({ file_id: ID, format: "markdown" });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /exports as csv, not markdown/);
  assert.equal(drive.exports.length, 0);

  const ok = text(await readFileTool(() => drive).handler({ file_id: ID }));
  assert.equal(drive.exports[0][1], "text/csv");
  assert.match(ok, /FIRST TAB/);
});

test("read_file follows a shortcut to its target", async () => {
  const drive = new FakeDrive()
    .add({ id: "short1", name: "-> notes", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "t1" } })
    .add({ id: "t1", name: "notes.txt", mimeType: "text/plain" }, "hello");
  const out = text(await readFileTool(() => drive).handler({ file_id: "short1" }));
  assert.deepEqual(drive.downloads[0], ["t1", MAX_TEXT_BYTES]);
  assert.match(out, /notes\.txt", as stored — all 5 characters\.\n\nhello$/);
});

test("read_file returns an image as image content, and refuses a PDF and a folder", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const drive = new FakeDrive()
    .add({ id: "img1", name: "chart.png", mimeType: "image/png" }, png)
    .add({ id: "pdf1", name: "deck.pdf", mimeType: "application/pdf", webViewLink: "https://drive/pdf1" })
    .add({ id: "dir1", name: "Projects", mimeType: "application/vnd.google-apps.folder" })
    .add({ id: "form1", name: "Survey", mimeType: "application/vnd.google-apps.form" });

  const image = await readFileTool(() => drive).handler({ file_id: "img1" });
  assert.deepEqual(drive.downloads[0], ["img1", MAX_IMAGE_BYTES]);
  assert.deepEqual(image.content[1], { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });

  const pdf = await readFileTool(() => drive).handler({ file_id: "pdf1" });
  assert.equal(pdf.isError, true);
  assert.match(text(pdf), /https:\/\/drive\/pdf1/);

  const folder = await readFileTool(() => drive).handler({ file_id: "dir1" });
  assert.match(text(folder), /search_files folder_id="dir1"/);

  const form = await readFileTool(() => drive).handler({ file_id: "form1" });
  assert.match(text(form), /cannot be exported as text/);
  assert.equal(drive.downloads.length, 1);
  assert.equal(drive.exports.length, 0);
});

test("create_folder creates in the parent it was given, by id or URL", async () => {
  const drive = new FakeDrive();
  const out = text(await createFolderTool(() => drive).handler({ name: " 2026 ", parent_folder_id: `https://drive.google.com/drive/folders/${ID}` }));
  assert.deepEqual(drive.folders[0], ["2026", ID]);
  assert.match(out, /\*\*ID:\*\* newfolder/);
});

test("create_file converts Markdown into a Google Doc", async () => {
  const drive = new FakeDrive();
  const out = text(await createFileTool(() => drive).handler({ name: "notes.md", content: "# Hi", convert_to: "document" }));
  const req = drive.creates[0];
  assert.equal(req.mimeType, "text/markdown");
  assert.equal(req.convertTo, DOC);
  assert.equal(new TextDecoder().decode(req.content), "# Hi");
  assert.equal(req.parentId, undefined);
  assert.match(out, /Created "notes.md" \(Google Doc, converted from text\/markdown\)/);
});

test("create_file decodes base64, and takes exactly one of content and content_base64", async () => {
  const drive = new FakeDrive();
  await createFileTool(() => drive).handler({ name: "a.png", content_base64: "iVBO\nRw==" });
  assert.deepEqual([...drive.creates[0].content], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(drive.creates[0].mimeType, "image/png");

  for (const args of [{ name: "x" }, { name: "x", content: "a", content_base64: "YQ==" }]) {
    const r = await createFileTool(() => drive).handler(args);
    assert.equal(r.isError, true);
    assert.match(text(r), /exactly one of content or content_base64/);
  }
  const bad = await createFileTool(() => drive).handler({ name: "x", content_base64: "not base64!" });
  assert.match(text(bad), /not valid base64/);
  assert.equal(drive.creates.length, 1);
});

test("create_file refuses a conversion Drive cannot make, before calling it", async () => {
  const drive = new FakeDrive();
  for (const args of [
    { name: "notes.md", content: "# Hi", convert_to: "spreadsheet" },
    { name: "data.csv", content: "a,b", convert_to: "document" },
    { name: "deck.txt", content: "x", convert_to: "presentation" },
  ]) {
    const r = await createFileTool(() => drive).handler(args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  const pair = await createFileTool(() => drive).handler({ name: "notes.md", content: "# Hi", convert_to: "spreadsheet" });
  assert.match(text(pair), /builds from text\/csv, text\/tab-separated-values, not text\/markdown/);
  assert.equal(drive.creates.length, 0);

  await createFileTool(() => drive).handler({ name: "q3.tsv", content: "a\tb", convert_to: "spreadsheet" });
  assert.equal(drive.creates[0].convertTo, SHEET);
});

test("a binary upload with an unknown extension is opaque bytes, never text", async () => {
  const drive = new FakeDrive();
  await createFileTool(() => drive).handler({ name: "report.docx", content_base64: "UEsDBA==" });
  await createFileTool(() => drive).handler({ name: "notes", content: "hi" });
  assert.deepEqual(
    drive.creates.map((c) => c.mimeType),
    ["application/octet-stream", "text/plain"],
  );
});

test("read_file never splits a surrogate pair across pages", async () => {
  const drive = new FakeDrive().add({ id: ID, name: "emoji.txt", mimeType: "text/plain" }, "ab😀cd");
  const first = text(await readFileTool(() => drive).handler({ file_id: ID, max_chars: 3 }));
  assert.match(first, /characters 0 to 2 of 6\. More: start_char=2\n\nab$/);
  const second = text(await readFileTool(() => drive).handler({ file_id: ID, start_char: 2, max_chars: 3 }));
  assert.match(second, /\n\n😀c$/);
});

test("create_file refuses content past the upload cap before calling Drive", async () => {
  const drive = new FakeDrive();
  const r = await createFileTool(() => drive).handler({ name: "big.txt", content: "a".repeat(MAX_UPLOAD_BYTES + 1) });
  assert.equal(r.isError, true);
  assert.equal(drive.creates.length, 0);
});

test("a missing credential is a failed call that names the variables, not a crash", async () => {
  const r = await getFileTool(() => createDefaultClient({})).handler({ file_id: ID });
  assert.equal(r.isError, true);
  assert.match(text(r), /GOOGLE_DRIVE_OAUTH_CLIENT_ID, GOOGLE_DRIVE_OAUTH_CLIENT_SECRET, GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN are not set/);
});
