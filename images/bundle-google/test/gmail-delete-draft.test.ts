/**
 * `delete_draft_email`: the fork's delta 5 (`vendor/gmail-shared/FORK.md`).
 *
 * The tool deletes ONE draft and nothing else. These tests hold the three
 * things that make that true: the draft is read before the delete is sent, so
 * an ID that is not a draft changes nothing; the ID is held to the draft-ID
 * shape before any URL is built, so `drafts/../messages/<id>` never reaches
 * Gmail; and the requests that do go out are a GET and a DELETE on
 * `/drafts/<id>`, never `/messages` or `/threads`.
 *
 * They also hold that `upsert_draft_email` no longer deletes: a tool policy can
 * allow drafting without allowing deletion only if the two are separate tools.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  DRAFT_ID_PATTERN,
  deleteDraft,
  getDraft,
  updateDraft,
} from "../vendor/gmail-shared/src/gmail-client/lib/drafts.js";
import { deleteDraftEmailTool } from "../vendor/gmail-shared/src/tools/delete-draft-email.js";
import { upsertDraftEmailTool } from "../vendor/gmail-shared/src/tools/draft-email.js";
import type { IGmailClient } from "../vendor/gmail-shared/src/server.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const server = new Server({ name: "t", version: "0" }, { capabilities: {} });

const DRAFT = {
  id: "r-8111111111111111111",
  message: {
    id: "19a0000000000001",
    threadId: "19a00000000000aa",
    labelIds: ["DRAFT"],
    snippet: "Hi Adam",
    historyId: "1",
    internalDate: "0",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "To", value: "adam@example.com" },
        { name: "Subject", value: "Re: the apartment" },
      ],
    },
  },
};

function notFound(): never {
  throw new Error("Resource not found: x");
}

function mailbox(overrides: Partial<IGmailClient> = {}): IGmailClient {
  return {
    getDraft: vi.fn(async () => DRAFT),
    deleteDraft: vi.fn(async () => {}),
    ...overrides,
  } as unknown as IGmailClient;
}

afterEach(() => vi.unstubAllGlobals());

describe("delete_draft_email", () => {
  it("reads the draft, deletes it, and says which one went", async () => {
    const client = mailbox();
    const tool = deleteDraftEmailTool(server, () => client);
    const result = await tool.handler({ draft_id: DRAFT.id });

    expect(result.isError).toBeUndefined();
    expect(client.getDraft).toHaveBeenCalledWith(DRAFT.id);
    expect(client.deleteDraft).toHaveBeenCalledWith(DRAFT.id);
    const text = result.content[0].text;
    expect(text).toContain("Draft deleted.");
    expect(text).toContain(`**Draft ID:** ${DRAFT.id}`);
    expect(text).toContain(`**Thread ID:** ${DRAFT.message.threadId}`);
    expect(text).toContain("**To:** adam@example.com");
    expect(text).toContain("**Subject:** Re: the apartment");
  });

  it("refuses an ID that is not a draft, and sends no delete", async () => {
    // A message ID has the draft-ID shape, so only Gmail can say it is not a
    // draft: GET /drafts/<message id> is a 404.
    const client = mailbox({ getDraft: vi.fn(async () => notFound()) });
    const tool = deleteDraftEmailTool(server, () => client);
    const result = await tool.handler({ draft_id: DRAFT.message.id });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`No draft with ID ${DRAFT.message.id}`);
    expect(result.content[0].text).toContain("Nothing was deleted");
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("refuses a path-shaped ID before it reaches the mailbox", async () => {
    const client = mailbox();
    const tool = deleteDraftEmailTool(server, () => client);
    for (const draft_id of ["../messages/19a0000000000001", "a/b", "a?b", "a%2Fb", "", " r-1"]) {
      const result = await tool.handler({ draft_id });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error deleting draft");
    }
    expect(client.getDraft).not.toHaveBeenCalled();
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("requires draft_id", async () => {
    const client = mailbox();
    const tool = deleteDraftEmailTool(server, () => client);
    expect(tool.inputSchema.required).toEqual(["draft_id"]);
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });

  it("passes any other failure through, and still does not delete", async () => {
    const client = mailbox({
      getDraft: vi.fn(async () => {
        throw new Error("Gmail API rate limit exceeded. Please try again later.");
      }),
    });
    const tool = deleteDraftEmailTool(server, () => client);
    const result = await tool.handler({ draft_id: DRAFT.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rate limit");
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });
});

describe("the draft calls' requests", () => {
  it("are a GET and a DELETE on /drafts/<id>, and nothing else", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), method: init.method ?? "GET" });
        return new Response(JSON.stringify(DRAFT), { status: 200 });
      }),
    );
    const client = mailbox({
      getDraft: (id: string) => getDraft(BASE, {}, id),
      deleteDraft: (id: string) => deleteDraft(BASE, {}, id),
    } as Partial<IGmailClient>);
    const tool = deleteDraftEmailTool(server, () => client);
    await tool.handler({ draft_id: DRAFT.id });

    expect(calls).toEqual([
      { url: `${BASE}/drafts/${DRAFT.id}`, method: "GET" },
      { url: `${BASE}/drafts/${DRAFT.id}`, method: "DELETE" },
    ]);
  });

  it("refuse a traversal ID at every draft call, before fetch", async () => {
    // `fetch` resolves `..`: without the guard this DELETE would land on
    // /users/me/messages/<id>.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const evil = "../messages/19a0000000000001";
    expect(DRAFT_ID_PATTERN.test(evil)).toBe(false);
    await expect(deleteDraft(BASE, {}, evil)).rejects.toThrow(/Not a Gmail draft ID/);
    await expect(getDraft(BASE, {}, evil)).rejects.toThrow(/Not a Gmail draft ID/);
    await expect(
      updateDraft(BASE, {}, "me@example.com", evil, {
        to: "a@example.com",
        subject: "s",
        plaintextBody: "b",
      }),
    ).rejects.toThrow(/Not a Gmail draft ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("upsert_draft_email", () => {
  it("no longer deletes: `delete` is gone from its schema and its handler", async () => {
    const client = mailbox({
      updateDraft: vi.fn(async () => DRAFT),
    } as Partial<IGmailClient>);
    const tool = upsertDraftEmailTool(server, () => client);
    expect(Object.keys(tool.inputSchema.properties)).not.toContain("delete");
    expect(tool.description).toContain("delete_draft_email");

    const result = await tool.handler({ draft_id: DRAFT.id, delete: true });
    expect(result.isError).toBe(true);
    expect(client.deleteDraft).not.toHaveBeenCalled();
  });
});
