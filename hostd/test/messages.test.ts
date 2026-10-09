import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { slugFor } from "../src/capabilities.js";
import { ConfigSchema, enableCapability, onTimeoutFor } from "../src/config.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { cleanText, targetGuid } from "../src/messages/chatdb.js";
import type { Message } from "../src/messages/chatdb.js";
import { buildChatDb, FakeMessagesHelper } from "./fake-messages.js";
import {
  connect,
  resultJson,
  resultText,
  ScriptedPrompter,
  SHELL_KEY,
  testConfig,
  tmpState,
} from "./helpers.js";

const MESSAGES_KEY = "messages-key-0123456789abcdef0123456789ab";
const PURPOSE =
  "Nightly sweep: read new iMessages since the stored cursor and note anything about the wedding.";

let daemon: RunningDaemon;
let fake: FakeMessagesHelper;
// Nobody answers: the dialog times out, which is the nightly case.
const prompter = new ScriptedPrompter("timeout");

function config() {
  return testConfig({
    // Each test takes its own grant and the suite never ends them.
    consent: { maxActiveGrants: 20 },
    capabilities: {
      shell: { enabled: true, key: SHELL_KEY, displayName: "shell-test-mbp" },
      browser: { enabled: false },
      messages: {
        enabled: true,
        key: MESSAGES_KEY,
        displayName: "imessage-test-mbp",
        onTimeout: "allow",
      },
    },
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hostd-messages-"));
  fake = new FakeMessagesHelper(buildChatDb(dir));
  daemon = await startDaemon(config(), {
    stateDir: tmpState(),
    prompter,
    messagesTransport: fake.transport,
    ephemeralPorts: true,
  });
});
afterAll(() => daemon.stop());

async function granted(): Promise<{ client: Client; grantId: string }> {
  const client = await connect(daemon.mcpPort, "/messages/mcp", MESSAGES_KEY);
  const r = await client.callTool({
    name: "request_control",
    arguments: { purpose: PURPOSE },
  });
  if (r.isError) throw new Error(resultText(r));
  return { client, grantId: resultJson<{ grant_id: string }>(r).grant_id };
}

type Page = {
  messages: Message[];
  has_more: boolean;
  next_after_rowid: number;
  warning?: string;
};

describe("the messages server, through a real MCP client", () => {
  it("serves the control tools and three read-only tools, every one needing grant_id", async () => {
    const client = await connect(daemon.mcpPort, "/messages/mcp", MESSAGES_KEY);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "request_control",
      "end_control",
      "get_control_status",
      "imessage_list_chats",
      "imessage_get_messages",
      "imessage_get_attachment",
    ]);
    for (const t of tools.slice(3)) {
      expect(t.inputSchema.required).toContain("grant_id");
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    // No send tool, under any name.
    expect(tools.some((t) => /send|reply|post/.test(t.name))).toBe(false);
  });

  it("refuses every tool without a grant, and runs no query", async () => {
    const client = await connect(daemon.mcpPort, "/messages/mcp", MESSAGES_KEY);
    const before = fake.ops.filter((o) => o.op === "query").length;
    const r = await client.callTool({
      name: "imessage_get_messages",
      arguments: { grant_id: "g_forged" },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/Not permitted/);
    expect(fake.ops.filter((o) => o.op === "query").length).toBe(before);
  });

  it("allows an unanswered dialog on THIS server, and still denies one on the shell", async () => {
    const shown = prompter.seen.length;
    const { client } = await granted();
    // The dialog was still shown, as a veto window, with its own timeout rule.
    expect(prompter.seen.length).toBe(shown + 1);
    expect(prompter.seen.at(-1)!.onTimeout).toBe("allow");
    const status = resultJson<{
      consent: { on_timeout: string };
      helper: Record<string, unknown>;
    }>(await client.callTool({ name: "get_control_status", arguments: {} }));
    expect(status.consent.on_timeout).toBe("allow");
    expect(status.helper).toEqual({
      running: true,
      full_disk_access: true,
      chat_db: "readable",
    });

    const shell = await connect(daemon.mcpPort, "/shell/mcp", SHELL_KEY);
    const r = await shell.callTool({
      name: "request_control",
      arguments: { purpose: "List the files in the home directory." },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/\(timeout\)/);
    expect(prompter.seen.at(-1)!.onTimeout).toBe("deny");
  });

  it("lists chats newest first, with participants, group flags and a search", async () => {
    const { client, grantId } = await granted();
    const all = resultJson<{
      chats: {
        chat_id: string;
        name: string | null;
        is_group: boolean;
        participants: string[];
        last_rowid: number;
        last_message_at: string;
      }[];
    }>(
      await client.callTool({
        name: "imessage_list_chats",
        arguments: { grant_id: grantId },
      }),
    );
    expect(all.chats.map((c) => c.chat_id)).toEqual([
      "iMessage;+;chat111",
      "iMessage;-;+15551234567",
      "SMS;-;+15559876543",
    ]);
    expect(all.chats[0]).toMatchObject({
      name: "Wedding planning",
      is_group: true,
      participants: ["+15551234567", "grace@example.com"],
      last_rowid: 10,
      last_message_at: "2026-10-07T19:02:11.000Z",
    });
    // An empty display name is no name.
    expect(all.chats[1]).toMatchObject({ name: null, is_group: false });

    const found = resultJson<{ chats: { chat_id: string }[] }>(
      await client.callTool({
        name: "imessage_list_chats",
        arguments: { grant_id: grantId, search: "grace@" },
      }),
    );
    expect(found.chats.map((c) => c.chat_id)).toEqual(["iMessage;+;chat111"]);

    // LIKE wildcards in a search are literal.
    const none = resultJson<{ chats: unknown[] }>(
      await client.callTool({
        name: "imessage_list_chats",
        arguments: { grant_id: grantId, search: "%" },
      }),
    );
    expect(none.chats).toEqual([]);
  });

  it("walks every chat with an exclusive ROWID cursor: each message exactly once, oldest first", async () => {
    const { client, grantId } = await granted();
    const seen: number[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = resultJson<Page>(
        await client.callTool({
          name: "imessage_get_messages",
          arguments: { grant_id: grantId, after_rowid: after, limit: 3 },
        }),
      );
      seen.push(...page.messages.map((m) => m.rowid));
      after = page.next_after_rowid;
      pages++;
      if (!page.has_more) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pages).toBe(4);

    // Nothing new: an empty page, the cursor unchanged, and no warning.
    const idle = resultJson<Page>(
      await client.callTool({
        name: "imessage_get_messages",
        arguments: { grant_id: grantId, after_rowid: after },
      }),
    );
    expect(idle).toEqual({
      messages: [],
      has_more: false,
      next_after_rowid: 10,
    });
  });

  it("without a cursor, returns the newest messages oldest first, and a cursor to resume from", async () => {
    const { client, grantId } = await granted();
    const page = resultJson<Page>(
      await client.callTool({
        name: "imessage_get_messages",
        arguments: { grant_id: grantId, limit: 2 },
      }),
    );
    expect(page.messages.map((m) => m.rowid)).toEqual([9, 10]);
    expect(page.has_more).toBe(true);
    expect(page.next_after_rowid).toBe(10);
  });

  it("reads one chat, and turns each kind of row into something an agent can use", async () => {
    const { client, grantId } = await granted();
    const page = resultJson<Page>(
      await client.callTool({
        name: "imessage_get_messages",
        arguments: {
          grant_id: grantId,
          chat_id: "iMessage;+;chat111",
          after_rowid: 0,
        },
      }),
    );
    const byId = new Map(page.messages.map((m) => [m.rowid, m]));
    expect([...byId.keys()]).toEqual([4, 5, 6, 7, 9, 10]);
    expect(page.messages.every((m) => m.chat_id === "iMessage;+;chat111")).toBe(
      true,
    );

    expect(byId.get(4)).toMatchObject({
      kind: "message",
      from_me: false,
      sender: "grace@example.com",
      text: "Venue contract attached",
      chat_name: "Wedding planning",
      sent_at: "2026-10-03T12:00:00.000Z",
      attachments: [
        {
          attachment_id: 1,
          file_name: "Venue contract.pdf",
          mime_type: "application/pdf",
          size_bytes: 23,
        },
      ],
    });
    expect(byId.get(5)).toMatchObject({
      kind: "reaction",
      text: null,
      reaction: { type: "love", removed: false, target_guid: "msg-4" },
    });
    expect(byId.get(6)).toMatchObject({ reply_to_guid: "msg-4", edited: true });
    expect(byId.get(7)).toMatchObject({
      kind: "system",
      text: "Wedding planning",
    });
    // Only an attachment: the placeholder character is not text.
    expect(byId.get(9)).toMatchObject({ text: null });
    expect(byId.get(9)!.attachments.map((a) => a.attachment_id)).toEqual([
      2, 3,
    ]);
    // The body only in attributedBody, decoded by the helper.
    expect(byId.get(10)).toMatchObject({ text: "Friday works — see you at 6" });
    const query = fake.ops.filter((o) => o.op === "query").at(-2)!;
    expect(query.args.decode).toEqual(["attributedBody"]);

    const other = resultJson<Page>(
      await client.callTool({
        name: "imessage_get_messages",
        arguments: {
          grant_id: grantId,
          chat_id: "iMessage;-;+15551234567",
          after_rowid: 0,
        },
      }),
    );
    expect(other.messages.map((m) => [m.rowid, m.from_me, m.sender])).toEqual([
      [1, false, "+15551234567"],
      [2, true, null],
      [8, true, null],
    ]);
    expect(other.messages[2]).toMatchObject({ unsent: true });
  });

  it("warns when the cursor is past every message: the database was rebuilt", async () => {
    const { client, grantId } = await granted();
    const page = resultJson<Page>(
      await client.callTool({
        name: "imessage_get_messages",
        arguments: { grant_id: grantId, after_rowid: 5000 },
      }),
    );
    expect(page.messages).toEqual([]);
    expect(page.next_after_rowid).toBe(5000);
    expect(page.warning).toMatch(/past the newest message on this Mac \(10\)/);
  });

  it("returns an attachment as an image, a converted photo, or a file — and refuses the rest", async () => {
    const { client, grantId } = await granted();
    const call = (id: number) =>
      client.callTool({
        name: "imessage_get_attachment",
        arguments: { grant_id: grantId, attachment_id: id },
      });
    type Content = {
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
      resource?: { mimeType: string; blob: string; uri: string };
    }[];

    const pdf = (await call(1)).content as Content;
    expect(JSON.parse(pdf[0]!.text!)).toMatchObject({
      file_name: "Venue contract.pdf",
      mime_type: "application/pdf",
      converted: false,
    });
    expect(pdf[1]!.type).toBe("resource");
    expect(pdf[1]!.resource!.uri).toBe("imessage-attachment:1");
    expect(Buffer.from(pdf[1]!.resource!.blob, "base64").toString()).toMatch(
      /^%PDF/,
    );

    const photo = (await call(2)).content as Content;
    expect(JSON.parse(photo[0]!.text!)).toMatchObject({
      mime_type: "image/jpeg",
      original_mime_type: "image/heic",
      converted: true,
    });
    expect(photo[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });

    const png = (await call(3)).content as Content;
    expect(JSON.parse(png[0]!.text!).file_name).toBe("map.png");
    expect(png[1]).toMatchObject({ type: "image", mimeType: "image/png" });

    const outside = await call(4);
    expect(outside.isError).toBe(true);
    expect(resultText(outside)).toMatch(/outside/);
    const missing = await call(5);
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toMatch(/not on this Mac/);
    const none = await call(999);
    expect(none.isError).toBe(true);
    expect(resultText(none)).toMatch(/no attachment has id 999/);
  });
});

describe("the messages server before the owner has set it up", () => {
  it("shows no dialog while the helper lacks Full Disk Access, and says how to fix it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostd-messages-"));
    const denied = new FakeMessagesHelper(buildChatDb(dir), {
      chatDb: "denied",
    });
    const quiet = new ScriptedPrompter("allowed");
    const d = await startDaemon(config(), {
      stateDir: tmpState(),
      prompter: quiet,
      messagesTransport: denied.transport,
      ephemeralPorts: true,
    });
    try {
      const client = await connect(d.mcpPort, "/messages/mcp", MESSAGES_KEY);
      const r = await client.callTool({
        name: "request_control",
        arguments: { purpose: PURPOSE },
      });
      expect(r.isError).toBe(true);
      expect(resultText(r)).toMatch(/helper_unavailable/);
      expect(resultText(r)).toMatch(/Full Disk Access/);
      expect(quiet.seen).toHaveLength(0);
    } finally {
      await d.stop();
    }
  });

  it("shows no dialog while the helper is not running at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostd-messages-"));
    const gone = new FakeMessagesHelper(buildChatDb(dir), {
      fail: "connect ENOENT messages.sock",
    });
    const quiet = new ScriptedPrompter("allowed");
    const d = await startDaemon(config(), {
      stateDir: tmpState(),
      prompter: quiet,
      messagesTransport: gone.transport,
      ephemeralPorts: true,
    });
    try {
      const client = await connect(d.mcpPort, "/messages/mcp", MESSAGES_KEY);
      const r = await client.callTool({
        name: "request_control",
        arguments: { purpose: PURPOSE },
      });
      expect(resultText(r)).toMatch(
        /helper_unavailable.*strad-hostd-messages is not running/,
      );
      expect(quiet.seen).toHaveLength(0);
      const status = resultJson<{ helper: unknown }>(
        await client.callTool({ name: "get_control_status", arguments: {} }),
      );
      expect(status.helper).toEqual({ running: false });
    } finally {
      await d.stop();
    }
  });
});

describe("messages config", () => {
  it("is named imessage-<suffix>", () => {
    expect(slugFor("messages", "tadas-mbp")).toBe("imessage-tadas-mbp");
  });

  it("`add messages` writes onTimeout allow into the file, and leaves the machine-wide rule alone", () => {
    const raw: Record<string, unknown> = {
      capabilities: {
        shell: {
          enabled: true,
          key: SHELL_KEY,
          displayName: "shell-tadas-mbp",
        },
      },
    };
    const r = enableCapability(raw, "messages", MESSAGES_KEY);
    expect(r).toEqual({ changed: true, displayName: "imessage-tadas-mbp" });
    const cfg = ConfigSchema.parse(raw);
    expect(cfg.capabilities.messages).toMatchObject({
      enabled: true,
      onTimeout: "allow",
    });
    expect(cfg.consent.onTimeout).toBe("deny");
    expect(onTimeoutFor(cfg, "messages")).toBe("allow");
    expect(onTimeoutFor(cfg, "shell")).toBe("deny");
  });

  it("does not loosen a messages server its owner set back to deny", () => {
    const raw: Record<string, unknown> = {
      capabilities: {
        messages: { enabled: true, key: MESSAGES_KEY, onTimeout: "deny" },
      },
    };
    expect(enableCapability(raw, "messages", "x".repeat(40)).changed).toBe(
      false,
    );
    expect(onTimeoutFor(ConfigSchema.parse(raw), "messages")).toBe("deny");
  });

  it("a hand-written config gets no override from the schema", () => {
    const cfg = ConfigSchema.parse({
      capabilities: { messages: { enabled: true, key: MESSAGES_KEY } },
    });
    expect(cfg.capabilities.messages.onTimeout).toBeUndefined();
    expect(onTimeoutFor(cfg, "messages")).toBe("deny");
  });
});

describe("message text", () => {
  it("drops the attachment placeholder and keeps real text", () => {
    expect(cleanText("￼")).toBeNull();
    expect(cleanText("￼ look at this")).toBe("look at this");
    expect(cleanText(null)).toBeNull();
  });

  it("reads a reaction's target from either guid form", () => {
    expect(targetGuid("p:0/ABC-123")).toBe("ABC-123");
    expect(targetGuid("bp:ABC-123")).toBe("ABC-123");
    expect(targetGuid(null)).toBeNull();
  });
});
