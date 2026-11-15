/**
 * The Drafts folder link: the fork's delta 7 (`vendor/gmail-shared/FORK.md`).
 *
 * `upsert_draft_email` and `list_draft_emails` answer with a link to the
 * acting account's Drafts folder, selected by ADDRESS, never by a `/u/<n>/`
 * index. These tests hold the URL shape, its encoding, that both tools carry
 * it, and that a failed account lookup costs the link and never the draft.
 */
import { describe, it, expect, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  buildGmailDraftsUrl,
  buildGmailUrl,
  draftsAccountEmail,
} from "../vendor/gmail-shared/src/utils/email-helpers.js";
import { upsertDraftEmailTool } from "../vendor/gmail-shared/src/tools/draft-email.js";
import { listDraftEmailsTool } from "../vendor/gmail-shared/src/tools/list-draft-emails.js";
import type { IGmailClient } from "../vendor/gmail-shared/src/server.js";

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

function mailbox(
  account: () => Promise<string>,
  overrides: Partial<IGmailClient> = {},
): IGmailClient {
  return {
    createDraft: vi.fn(async () => DRAFT),
    updateDraft: vi.fn(async () => DRAFT),
    getDraft: vi.fn(async () => DRAFT),
    listDrafts: vi.fn(async () => ({
      drafts: [{ id: DRAFT.id, message: { id: DRAFT.message.id } }],
    })),
    getAccountEmail: vi.fn(account),
    ...overrides,
  } as unknown as IGmailClient;
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? "").join("\n");

const DRAFT_ARGS = {
  to: "adam@example.com",
  subject: "Re: the apartment",
  plaintext_body: "Hi Adam",
};

describe("buildGmailDraftsUrl", () => {
  it("selects the account by address, not by index", () => {
    expect(buildGmailDraftsUrl("tadas@tadasant.com")).toBe(
      "https://mail.google.com/mail/?authuser=tadas%40tadasant.com#drafts",
    );
    expect(buildGmailDraftsUrl("tadas@tadasant.com")).not.toMatch(
      /\/u\/\d/,
    );
  });

  it("uses the same /mail/ path as the tree's other multi-account links", () => {
    const prefix = "https://mail.google.com/mail/?authuser=";
    expect(buildGmailDraftsUrl("me@x.com").startsWith(prefix)).toBe(true);
    expect(buildGmailUrl("me@x.com", "1").startsWith(prefix)).toBe(true);
  });

  it("percent-encodes the address, so + is not a space and # or & cannot end it", () => {
    const url = buildGmailDraftsUrl("tadas+work@example.com");
    expect(url).toBe(
      "https://mail.google.com/mail/?authuser=tadas%2Bwork%40example.com#drafts",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("authuser")).toBe("tadas+work@example.com");
    expect(parsed.hash).toBe("#drafts");

    const odd = new URL(buildGmailDraftsUrl("a&b#c@example.com"));
    expect(odd.searchParams.get("authuser")).toBe("a&b#c@example.com");
    expect(odd.hash).toBe("#drafts");
  });
});

describe("draftsAccountEmail", () => {
  it("returns the address, trimmed", async () => {
    expect(
      await draftsAccountEmail({ getAccountEmail: async () => " me@x.com " }),
    ).toBe("me@x.com");
  });

  it("is undefined for an empty address or a failed lookup", async () => {
    expect(
      await draftsAccountEmail({ getAccountEmail: async () => "" }),
    ).toBeUndefined();
    expect(
      await draftsAccountEmail({
        getAccountEmail: async () => {
          throw new Error("Failed to fetch Gmail profile: 403");
        },
      }),
    ).toBeUndefined();
  });
});

describe("draftsAccountEmail, bounded", () => {
  it("gives up on a lookup that never answers", async () => {
    const stalled = { getAccountEmail: () => new Promise<string>(() => {}) };
    expect(await draftsAccountEmail(stalled, 20)).toBeUndefined();
  });

  it("is undefined when getAccountEmail throws synchronously", async () => {
    expect(
      await draftsAccountEmail({
        getAccountEmail: () => {
          throw new Error("sync");
        },
      }),
    ).toBeUndefined();
  });
});

describe("upsert_draft_email", () => {
  it("reports a failed save as an error and reads no account first", async () => {
    const client = mailbox(async () => "me@x.com", {
      createDraft: vi.fn(async () => {
        throw new Error("Gmail API error 400");
      }),
    });
    const result = await upsertDraftEmailTool(server, () => client).handler(
      DRAFT_ARGS,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Error creating draft: Gmail API error 400");
    expect(text(result)).not.toContain("mail.google.com");
    expect(client.getAccountEmail).not.toHaveBeenCalled();
  });

  it("links the account's Drafts folder on create", async () => {
    const client = mailbox(async () => "tadas412@gmail.com");
    const result = await upsertDraftEmailTool(server, () => client).handler(
      DRAFT_ARGS,
    );
    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body).toContain("Draft created successfully!");
    expect(body).toContain(`**Draft ID:** ${DRAFT.id}`);
    expect(body).toContain(
      "**Drafts folder (tadas412@gmail.com):** https://mail.google.com/mail/?authuser=tadas412%40gmail.com#drafts",
    );
  });

  it("links it on update too", async () => {
    const client = mailbox(async () => "zimmer@tadasant.com");
    const result = await upsertDraftEmailTool(server, () => client).handler({
      ...DRAFT_ARGS,
      draft_id: DRAFT.id,
    });
    expect(client.updateDraft).toHaveBeenCalledOnce();
    expect(text(result)).toContain(
      "**Drafts folder (zimmer@tadasant.com):** https://mail.google.com/mail/?authuser=zimmer%40tadasant.com#drafts",
    );
  });

  it("still reports a saved draft when the account cannot be read", async () => {
    const client = mailbox(async () => {
      throw new Error("Failed to fetch Gmail profile: 403");
    });
    const result = await upsertDraftEmailTool(server, () => client).handler(
      DRAFT_ARGS,
    );
    expect(result.isError).toBeUndefined();
    const body = text(result);
    expect(body).toContain("Draft created successfully!");
    expect(body).not.toContain("mail.google.com");
    expect(body).toContain("find it in Gmail's Drafts folder");
  });

  it("names the link in its description", () => {
    const tool = upsertDraftEmailTool(server, () => mailbox(async () => ""));
    expect(tool.description).toContain("authuser=<email>#drafts");
  });
});

describe("list_draft_emails", () => {
  it("links the account's Drafts folder once, above the drafts", async () => {
    const client = mailbox(async () => "tadas@pulsemcp.com");
    const body = text(
      await listDraftEmailsTool(server, () => client).handler({}),
    );
    const link =
      "**Drafts folder (tadas@pulsemcp.com):** https://mail.google.com/mail/?authuser=tadas%40pulsemcp.com#drafts";
    expect(body.split(link)).toHaveLength(2);
    expect(body.indexOf(link)).toBeLessThan(body.indexOf("**Draft ID:**"));
  });

  it("links it when filtering by thread", async () => {
    const client = mailbox(async () => "me@x.com");
    const body = text(
      await listDraftEmailsTool(server, () => client).handler({
        thread_id: DRAFT.message.threadId,
      }),
    );
    expect(body).toContain(`**Draft ID:** ${DRAFT.id}`);
    expect(body).toContain(
      "**Drafts folder (me@x.com):** https://mail.google.com/mail/?authuser=me%40x.com#drafts",
    );
  });

  it("lists the drafts without the link when the account cannot be read", async () => {
    const client = mailbox(async () => {
      throw new Error("nope");
    });
    const result = await listDraftEmailsTool(server, () => client).handler({});
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain(`**Draft ID:** ${DRAFT.id}`);
    expect(text(result)).not.toContain("mail.google.com");
  });
});
