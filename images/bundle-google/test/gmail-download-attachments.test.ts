/**
 * `download_email_attachments`: the fork's delta 6 (`vendor/gmail-shared/FORK.md`).
 *
 * strad serves this tool from a container no caller shares a disk with, so a
 * file written to that container's `/tmp` is a file nobody can open. These
 * tests hold that the bytes travel in the result instead: by default as one
 * MCP embedded resource per attachment (a base64 `blob` for binary, `text` for
 * text types), with `inline=true` as one text block, and that the tool never
 * touches the server's filesystem.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  attachmentUri,
  downloadEmailAttachmentsTool,
} from "../vendor/gmail-shared/src/tools/download-email-attachments.js";
import type { IGmailClient } from "../vendor/gmail-shared/src/server.js";

const server = new Server({ name: "t", version: "0" }, { capabilities: {} });
const EMAIL_ID = "1a00000000000001";

/** Bytes that are not valid UTF-8 and whose base64 carries `+` and `/`. */
const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.5\r\n%"),
  Buffer.from([0x83, 0x92, 0xfa, 0xfe, 0xfb, 0xff, 0x00, 0x3e, 0x3f]),
]);
const CSV_TEXT = "street,price\n1 Example St,1\n";

/** Gmail returns attachment data base64url-encoded, unpadded. */
function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function mailbox(
  parts: { filename: string; mimeType: string; bytes: Buffer }[],
): IGmailClient {
  return {
    getMessage: vi.fn(async () => ({
      id: EMAIL_ID,
      threadId: EMAIL_ID,
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { size: 2, data: "aGk" } },
          ...parts.map((p, i) => ({
            filename: p.filename,
            mimeType: p.mimeType,
            body: { size: p.bytes.length, attachmentId: `att-${i}` },
          })),
        ],
      },
    })),
    getAttachment: vi.fn(async (_id: string, attachmentId: string) => {
      const i = Number(attachmentId.slice("att-".length));
      return { size: parts[i].bytes.length, data: base64url(parts[i].bytes) };
    }),
  } as unknown as IGmailClient;
}

type Block = {
  type: string;
  text?: string;
  resource?: { uri: string; mimeType?: string; blob?: string; text?: string };
};

async function call(client: IGmailClient, args: Record<string, unknown>) {
  const tool = downloadEmailAttachmentsTool(server, () => client);
  return (await tool.handler(args)) as { content: Block[]; isError?: boolean };
}

const TWO = [
  {
    filename: "Offer DRAFT #2.pdf",
    mimeType: "application/pdf",
    bytes: PDF_BYTES,
  },
  { filename: "comps.csv", mimeType: "text/csv", bytes: Buffer.from(CSV_TEXT) },
];

describe("download_email_attachments returns the bytes, not a server path", () => {
  it("returns a binary attachment as a blob resource that decodes to the exact bytes", async () => {
    const result = await call(mailbox(TWO), {
      email_id: EMAIL_ID,
      filename: "Offer DRAFT #2.pdf",
    });
    expect(result.isError).toBeUndefined();
    const [summary, pdf, ...rest] = result.content;
    expect(rest).toEqual([]);
    expect(summary.type).toBe("text");
    expect(summary.text).toContain("Offer DRAFT #2.pdf (application/pdf");
    expect(summary.text).not.toContain("/tmp");
    expect(pdf.type).toBe("resource");
    expect(pdf.resource?.mimeType).toBe("application/pdf");
    expect(pdf.resource?.text).toBeUndefined();
    // Standard base64, not Gmail's base64url: MCP's blob is RFC 4648 §4.
    expect(pdf.resource?.blob).toBe(PDF_BYTES.toString("base64"));
    expect(Buffer.from(pdf.resource!.blob!, "base64").equals(PDF_BYTES)).toBe(
      true,
    );
  });

  it("returns a text attachment as a text resource, decoded", async () => {
    const result = await call(mailbox(TWO), {
      email_id: EMAIL_ID,
      filename: "comps.csv",
    });
    const csv = result.content[1];
    expect(csv.type).toBe("resource");
    expect(csv.resource?.mimeType).toBe("text/csv");
    expect(csv.resource?.text).toBe(CSV_TEXT);
    expect(csv.resource?.blob).toBeUndefined();
  });

  it("returns every attachment, one resource each, when no filename is given", async () => {
    const result = await call(mailbox(TWO), { email_id: EMAIL_ID });
    expect(result.content.map((b) => b.type)).toEqual([
      "text",
      "resource",
      "resource",
    ]);
    expect(result.content.slice(1).map((b) => b.resource?.uri)).toEqual([
      "gmail-attachment://1a00000000000001/Offer%20DRAFT%20%232.pdf",
      "gmail-attachment://1a00000000000001/comps.csv",
    ]);
  });

  it("keeps a filename with a slash in one URI path segment", () => {
    expect(attachmentUri("m1", "../a/b.pdf")).toBe(
      "gmail-attachment://m1/..%2Fa%2Fb.pdf",
    );
  });

  it("writes nothing to the server's /tmp", async () => {
    await call(mailbox(TWO), { email_id: EMAIL_ID });
    expect(existsSync(`/tmp/gmail-attachments-${EMAIL_ID}`)).toBe(false);
  });

  it("still returns everything as one text block with inline=true", async () => {
    const result = await call(mailbox(TWO), {
      email_id: EMAIL_ID,
      inline: true,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain(PDF_BYTES.toString("base64"));
    expect(result.content[0].text).toContain(CSV_TEXT);
  });

  it("refuses more than 25 MB in one call in the default mode too", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024);
    const client = mailbox([
      { filename: "big.pdf", mimeType: "application/pdf", bytes: big },
    ]);
    const result = await call(client, { email_id: EMAIL_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exceeds the 25 MB limit");
    expect(client.getAttachment).not.toHaveBeenCalled();
  });
});
