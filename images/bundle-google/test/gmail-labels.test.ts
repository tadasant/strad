/**
 * Labels by name: the fork's delta 8 (`vendor/gmail-shared/FORK.md`).
 *
 * An agent asked to put a label named "Added details to calendar" on a message
 * had no way to: `change_email_conversation` sent the name to Gmail as an ID
 * (HTTP 400), and nothing listed or created labels. These tests hold the three
 * pieces that close it: `list_email_labels`, an idempotent `create_email_label`,
 * and `change_email_conversation` resolving names, creating a missing one.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  createLabel,
  listLabels,
  type GmailLabel,
} from "../vendor/gmail-shared/src/gmail-client/lib/labels.js";
import { listEmailLabelsTool } from "../vendor/gmail-shared/src/tools/list-email-labels.js";
import { createEmailLabelTool } from "../vendor/gmail-shared/src/tools/create-email-label.js";
import { changeEmailConversationTool } from "../vendor/gmail-shared/src/tools/change-email-conversation.js";
import type { IGmailClient } from "../vendor/gmail-shared/src/server.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const HEADERS = { Authorization: "Bearer t", "Content-Type": "application/json" };
const server = new Server({ name: "t", version: "0" }, { capabilities: {} });

const LABELS: GmailLabel[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "Label_7", name: "Receipts", type: "user" },
  { id: "Label_9", name: "Travel/2026", type: "user" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("labels client", () => {
  it("lists with one GET on /labels", async () => {
    const fetchMock = vi.fn(async () => json({ labels: LABELS }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listLabels(BASE, HEADERS)).toEqual(LABELS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/labels`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("creates a missing label with a POST naming it, shown in both lists", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ id: "Label_42", name: "Added details to calendar", type: "user" })
        : json({ labels: LABELS }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createLabel(BASE, HEADERS, "  Added details to calendar ");
    expect(result).toEqual({
      created: true,
      label: { id: "Label_42", name: "Added details to calendar", type: "user" },
    });
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(post[0]).toBe(`${BASE}/labels`);
    expect(JSON.parse(post[1]!.body as string)).toEqual({
      name: "Added details to calendar",
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    });
  });

  it("returns an existing label, matched without regard to case, and sends no POST", async () => {
    const fetchMock = vi.fn(async () => json({ labels: LABELS }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createLabel(BASE, HEADERS, "receipts");
    expect(result).toEqual({ created: false, label: LABELS[2] });
    expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit).method === "GET")).toBe(true);
  });

  it("returns the winner when the create loses a race (409)", async () => {
    let lists = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ error: { code: 409 } }, 409);
      lists += 1;
      return json({
        labels: lists === 1 ? LABELS : [...LABELS, { id: "Label_50", name: "New", type: "user" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createLabel(BASE, HEADERS, "new");
    expect(result).toEqual({ created: false, label: { id: "Label_50", name: "New", type: "user" } });
  });

  it("refuses an empty name before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createLabel(BASE, HEADERS, "   ")).rejects.toThrow(/empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mailbox(overrides: Partial<IGmailClient> = {}) {
  const labels = [...LABELS];
  const client = {
    listLabels: vi.fn(async () => labels),
    createLabel: vi.fn(async (name: string) => {
      const label = { id: "Label_42", name, type: "user" as const };
      return { label, created: true };
    }),
    modifyMessage: vi.fn(async (_id: string, opts: { addLabelIds?: string[] }) => ({
      id: "m1",
      labelIds: ["INBOX", ...(opts.addLabelIds ?? [])],
    })),
    ...overrides,
  };
  return client as typeof client & IGmailClient;
}

describe("list_email_labels", () => {
  it("lists user labels, then system labels, each with its ID", async () => {
    const client = mailbox();
    const result = await listEmailLabelsTool(server, () => client).handler();
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("## User labels (2)");
    expect(text).toContain("- Receipts — id: Label_7");
    expect(text).toContain("- Travel/2026 — id: Label_9");
    expect(text).toContain("## System labels (2)");
    expect(text.indexOf("Receipts")).toBeLessThan(text.indexOf("## System labels"));
  });
});

describe("create_email_label", () => {
  it("says whether it created the label, with its name and ID", async () => {
    const client = mailbox();
    const tool = createEmailLabelTool(server, () => client);
    const created = await tool.handler({ name: "Added details to calendar" });
    expect(created.content[0].text).toContain("Label created.");
    expect(created.content[0].text).toContain("**ID:** Label_42");

    client.createLabel.mockResolvedValueOnce({ label: LABELS[2], created: false });
    const existing = await tool.handler({ name: "receipts" });
    expect(existing.content[0].text).toContain("already exists");
    expect(existing.content[0].text).toContain("**ID:** Label_7");
  });

  it("refuses a blank name", async () => {
    const client = mailbox();
    const result = await createEmailLabelTool(server, () => client).handler({ name: " " });
    expect(result.isError).toBe(true);
    expect(client.createLabel).not.toHaveBeenCalled();
  });
});

describe("change_email_conversation labels by name", () => {
  const call = (client: ReturnType<typeof mailbox>, args: Record<string, unknown>) =>
    changeEmailConversationTool(server, () => client).handler({ email_id: "m1", ...args });

  it("resolves a name to its ID, case-insensitively", async () => {
    const client = mailbox();
    const result = await call(client, { labels: "receipts" });
    expect(result.isError).toBeUndefined();
    expect(client.modifyMessage).toHaveBeenCalledWith("m1", {
      addLabelIds: ["Label_7"],
      removeLabelIds: undefined,
    });
    expect(client.createLabel).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Added labels: Receipts (Label_7)");
  });

  it("creates a missing label being added, then applies it", async () => {
    const client = mailbox();
    const result = await call(client, { labels: "Added details to calendar" });
    expect(client.createLabel).toHaveBeenCalledWith("Added details to calendar");
    expect(client.modifyMessage).toHaveBeenCalledWith("m1", {
      addLabelIds: ["Label_42"],
      removeLabelIds: undefined,
    });
    expect(result.content[0].text).toContain('Created label "Added details to calendar" (Label_42).');
  });

  it("passes IDs through, user and system alike, and lists once for several tokens", async () => {
    const client = mailbox();
    await call(client, { labels: "Label_9, STARRED, Receipts", remove_labels: "INBOX" });
    expect(client.listLabels).toHaveBeenCalledTimes(1);
    expect(client.modifyMessage).toHaveBeenCalledWith("m1", {
      addLabelIds: ["Label_9", "STARRED", "Label_7"],
      removeLabelIds: ["INBOX"],
    });
  });

  it("lists nothing when every token is a system label ID", async () => {
    const client = mailbox();
    await call(client, { labels: "STARRED, CATEGORY_UPDATES", remove_labels: "UNREAD", status: "archived" });
    expect(client.listLabels).not.toHaveBeenCalled();
    expect(client.modifyMessage).toHaveBeenCalledWith("m1", {
      addLabelIds: ["STARRED", "CATEGORY_UPDATES"],
      removeLabelIds: ["INBOX", "UNREAD"],
    });
  });

  it("skips a removal that names no label, and says so", async () => {
    const client = mailbox();
    const result = await call(client, { remove_labels: "Nope", is_starred: true });
    expect(client.createLabel).not.toHaveBeenCalled();
    expect(client.modifyMessage).toHaveBeenCalledWith("m1", {
      addLabelIds: ["STARRED"],
      removeLabelIds: undefined,
    });
    expect(result.content[0].text).toContain('Skipped "Nope"');
  });

  it("refuses an unknown Label_ ID with nothing created or modified", async () => {
    const client = mailbox();
    const result = await call(client, { labels: "Label_999" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("list_email_labels");
    expect(client.createLabel).not.toHaveBeenCalled();
    expect(client.modifyMessage).not.toHaveBeenCalled();
  });

  it("resolves removals before creating anything", async () => {
    const client = mailbox();
    const result = await call(client, { labels: "Brand new", remove_labels: "Label_404" });
    expect(result.isError).toBe(true);
    expect(client.createLabel).not.toHaveBeenCalled();
  });

  it("names the label tools in its description", () => {
    const tool = changeEmailConversationTool(server, () => mailbox());
    expect(tool.description).toContain("list_email_labels");
    expect(tool.description).toContain("create_email_label");
  });
});
