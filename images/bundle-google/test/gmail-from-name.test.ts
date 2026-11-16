/**
 * The From header carries the sender's display name: delta 2 of the gmail fork
 * (`vendor/gmail-shared/FORK.md`).
 *
 * Upstream writes `From: <address>` and nothing else, and Gmail delivers that
 * header as written, so a recipient sees the bare address however the account
 * is named. This suite is what fails if a re-vendor puts that back.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildMimeMessage,
  formatFromHeader,
  MAX_DISPLAY_NAME_LENGTH,
} from "../vendor/gmail-shared/src/gmail-client/lib/mime-utils.js";
import {
  getSendAsDisplayName,
  SEND_AS_TIMEOUT_MS,
} from "../vendor/gmail-shared/src/gmail-client/lib/send-as.js";
import {
  OAuth2GmailClient,
  SENDER_NAME_RETRY_MS,
  SENDER_NAME_TTL_MS,
} from "../vendor/gmail-shared/src/server.js";

const ZIMMER = "zimmer@tadasant.com";
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Decodes the RFC 2047 B-encoded words in a header value. */
const decodeWords = (value: string): string =>
  value
    .replace(/\r\n /g, "")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b64: string) =>
      Buffer.from(b64, "base64").toString("utf-8"),
    );

describe("formatFromHeader", () => {
  it("quotes a name with an apostrophe, which needs no escaping inside quotes", () => {
    expect(formatFromHeader(ZIMMER, "Tadas's Assistant")).toBe(
      `"Tadas's Assistant" <${ZIMMER}>`,
    );
  });

  it("keeps a comma inside the quotes, where it cannot split the address list", () => {
    expect(formatFromHeader("j@example.com", "Doe, Jane")).toBe(
      '"Doe, Jane" <j@example.com>',
    );
  });

  it('escapes " and \\ in the quoted-string', () => {
    expect(formatFromHeader("a@example.com", 'The "Bot" \\ Co')).toBe(
      '"The \\"Bot\\" \\\\ Co" <a@example.com>',
    );
  });

  it("sends a non-ASCII name as encoded-words, unquoted, folded into short lines", () => {
    const name = "Tado asistentas — Žemaitė ir draugai, labai ilgas vardas";
    const header = formatFromHeader("t@example.com", name);
    expect(header).toMatch(/^=\?UTF-8\?B\?/);
    expect(header).not.toContain('"');
    expect(header.endsWith("\r\n <t@example.com>")).toBe(true);
    for (const line of `From: ${header}`.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    expect(decodeWords(header.replace("\r\n <t@example.com>", ""))).toBe(name);
  });

  it("puts the address on its own line after an encoded name, so a long one stays short", () => {
    const email = `${"a".repeat(40)}@${"b".repeat(20)}.example.com`;
    const header = formatFromHeader(email, "Žemaitė");
    for (const line of `From: ${header}`.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
  });

  it("strips bidi overrides, which would reorder how the name renders", () => {
    expect(formatFromHeader("a@example.com", "Bob\u202Egnp.exe\u2066x")).toBe(
      '"Bob gnp.exe x" <a@example.com>',
    );
  });

  it(`holds a name to ${MAX_DISPLAY_NAME_LENGTH} characters`, () => {
    const header = formatFromHeader("a@example.com", "x".repeat(5000));
    expect(header).toBe(`"${"x".repeat(MAX_DISPLAY_NAME_LENGTH)}" <a@example.com>`);
  });

  it("turns line breaks and control characters into spaces, so no header is injected", () => {
    const header = formatFromHeader(
      "a@example.com",
      "Eve\r\nBcc: victim@example.com\u2028x",
    );
    expect(header).not.toMatch(/[\r\n\u2028]/);
    expect(header).toBe('"Eve Bcc: victim@example.com x" <a@example.com>');
  });

  it("is the bare address when there is no name", () => {
    expect(formatFromHeader(ZIMMER)).toBe(ZIMMER);
    expect(formatFromHeader(ZIMMER, "")).toBe(ZIMMER);
    expect(formatFromHeader(ZIMMER, " \r\n ")).toBe(ZIMMER);
  });

  it("lands in the message as the From line", () => {
    const raw = buildMimeMessage(formatFromHeader(ZIMMER, "Tadas's Assistant"), {
      to: "tadas@tadasant.com",
      subject: "hi",
      plaintextBody: "body",
    });
    expect(raw.split("\r\n")[0]).toBe(
      `From: "Tadas's Assistant" <${ZIMMER}>`,
    );
  });
});

describe("getSendAsDisplayName", () => {
  afterEach(() => vi.unstubAllGlobals());

  const serve = (body: unknown, status = 200) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("reads the entry for the address, case-insensitively", async () => {
    const fetchMock = serve({
      sendAs: [
        { sendAsEmail: "alias@tadasant.com", displayName: "Alias" },
        { sendAsEmail: "Zimmer@Tadasant.com", displayName: " Tadas's Assistant ", isPrimary: true },
      ],
    });
    await expect(getSendAsDisplayName(BASE, {}, ZIMMER)).resolves.toBe(
      "Tadas's Assistant",
    );
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/settings/sendAs`);
  });

  it(`gives up after ${SEND_AS_TIMEOUT_MS} ms rather than holding up the send`, async () => {
    // A fetch that never answers on its own: only the request's signal ends it.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Real time: `AbortSignal.timeout` runs on Node's own timer, which Vitest's
    // fake timers do not reach.
    const started = Date.now();
    await expect(getSendAsDisplayName(BASE, {}, ZIMMER)).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(SEND_AS_TIMEOUT_MS - 100);
  });

  it("never borrows another address's name, not even the primary's", async () => {
    serve({ sendAs: [{ sendAsEmail: "tadas@tadasant.com", displayName: "Tadas", isPrimary: true }] });
    await expect(getSendAsDisplayName(BASE, {}, ZIMMER)).resolves.toBeUndefined();
  });

  it("is undefined for an entry with no name", async () => {
    serve({ sendAs: [{ sendAsEmail: ZIMMER, displayName: "" }] });
    await expect(getSendAsDisplayName(BASE, {}, ZIMMER)).resolves.toBeUndefined();
  });

  it("throws when the settings cannot be read", async () => {
    serve({ error: "forbidden" }, 403);
    await expect(getSendAsDisplayName(BASE, {}, ZIMMER)).rejects.toThrow(/403/);
  });
});

/** The real OAuth client, with the token exchange stubbed out. */
class TestClient extends OAuth2GmailClient {
  constructor() {
    super("id", "secret", "refresh");
  }
  protected async refreshTokenImpl() {
    return { token: "t", expiryDate: Date.now() + 3_600_000 };
  }
}

describe("the client's sends and drafts carry the name", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A fake Gmail: answers the profile and send-as reads, records every raw message. */
  const fakeGmail = (sendAs: () => Response) => {
    const raws: { path: string; from: string }[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.replace(BASE, "");
      if (path === "/profile") {
        return new Response(JSON.stringify({ emailAddress: ZIMMER }));
      }
      if (path === "/settings/sendAs") return sendAs();
      const body = JSON.parse(String(init?.body));
      const raw = Buffer.from(body.raw ?? body.message.raw, "base64url").toString("utf-8");
      raws.push({ path, from: raw.split("\r\n")[0] });
      return new Response(JSON.stringify({ id: "x", threadId: "t", message: { id: "m" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const sendAsCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/settings/sendAs")).length;
    return { raws, sendAsCalls };
  };

  const named = () =>
    new Response(
      JSON.stringify({ sendAs: [{ sendAsEmail: ZIMMER, displayName: "Tadas's Assistant" }] }),
    );

  it("send_email, a reply, a new draft and a draft update all go out with the name", async () => {
    const gmail = fakeGmail(named);
    const client = new TestClient();
    const message = { to: "tadas@tadasant.com", subject: "hi", plaintextBody: "b" };

    await client.sendMessage(message);
    await client.sendMessage({
      ...message,
      threadId: "t1",
      inReplyTo: "<a@mail.gmail.com>",
      references: "<a@mail.gmail.com>",
    });
    await client.createDraft(message);
    await client.updateDraft("d1", message);

    expect(gmail.raws.map((r) => r.path)).toEqual([
      "/messages/send",
      "/messages/send",
      "/drafts",
      "/drafts/d1",
    ]);
    for (const { from } of gmail.raws) {
      expect(from).toBe(`From: "Tadas's Assistant" <${ZIMMER}>`);
    }
    // Read once and remembered, not re-read per message.
    expect(gmail.sendAsCalls()).toBe(1);
  });

  it("reads the name again once it is older than the TTL, so a rename lands without a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let name = "Old Name";
    const gmail = fakeGmail(
      () => new Response(JSON.stringify({ sendAs: [{ sendAsEmail: ZIMMER, displayName: name }] })),
    );
    const client = new TestClient();
    const message = { to: "tadas@tadasant.com", subject: "hi", plaintextBody: "b" };

    await client.sendMessage(message);
    name = "Tadas's Assistant";
    vi.setSystemTime(Date.now() + SENDER_NAME_TTL_MS + 1);
    await client.sendMessage(message);

    expect(gmail.raws.map((r) => r.from)).toEqual([
      `From: "Old Name" <${ZIMMER}>`,
      `From: "Tadas's Assistant" <${ZIMMER}>`,
    ]);
  });

  it("still sends, from the bare address, when the name cannot be read, and tries again after the retry window", async () => {
    // Only Date is faked: the fetch stub resolves on the real microtask queue.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const gmail = fakeGmail(() => (fail ? new Response("{}", { status: 403 }) : named()));
    const client = new TestClient();
    const message = { to: "tadas@tadasant.com", subject: "hi", plaintextBody: "b" };

    await client.sendMessage(message);
    fail = false;
    // Inside the window the failure is remembered: no second lookup.
    await client.sendMessage(message);
    expect(gmail.sendAsCalls()).toBe(1);
    vi.setSystemTime(Date.now() + SENDER_NAME_RETRY_MS + 1);
    await client.sendMessage(message);

    expect(gmail.raws.map((r) => r.from)).toEqual([
      `From: ${ZIMMER}`,
      `From: ${ZIMMER}`,
      `From: "Tadas's Assistant" <${ZIMMER}>`,
    ]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("could not read the send-as display name"),
    );
  });
});

/**
 * A name the deployment configures, rather than one read from Gmail.
 *
 * An account nobody signs in to (zimmer@tadasant.com) has an empty send-as
 * name, so the lookup above finds nothing and the mail goes out from the bare
 * address. Setting the send-as name needs `gmail.settings.basic`, which the
 * mount's token does not hold. So the name can also be configured per mount,
 * and then nothing is looked up.
 */
describe("a configured sender name", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const NAME = "Zimmer (Tadas's Assistant)";
  const EXPECTED = `From: "Zimmer (Tadas's Assistant)" <zimmer@tadasant.com>`;

  class NamedClient extends OAuth2GmailClient {
    constructor(name: string | undefined) {
      super("id", "secret", "refresh", { senderDisplayName: name });
    }
    protected async refreshTokenImpl() {
      return { token: "t", expiryDate: Date.now() + 3_600_000 };
    }
  }

  /** A fake Gmail whose send-as entry for zimmer@ has no name, as in prod. */
  const fakeGmail = () => {
    const raws: { path: string; from: string }[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const path = input.replace(BASE, "");
      if (path === "/profile") return new Response(JSON.stringify({ emailAddress: ZIMMER }));
      if (path === "/settings/sendAs") {
        return new Response(JSON.stringify({ sendAs: [{ sendAsEmail: ZIMMER, displayName: "" }] }));
      }
      if (path === "/drafts/d1/send" || path === "/drafts/send") {
        return new Response(JSON.stringify({ id: "m", threadId: "t" }));
      }
      const body = JSON.parse(String(init?.body));
      const raw = Buffer.from(body.raw ?? body.message.raw, "base64url").toString("utf-8");
      raws.push({ path, from: raw.split("\r\n")[0] });
      return new Response(JSON.stringify({ id: "x", threadId: "t", message: { id: "m" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const sendAsCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/settings/sendAs")).length;
    return { raws, sendAsCalls };
  };

  it("is the From on a send, a reply, a new draft and a draft update, parentheses and apostrophe intact", async () => {
    const gmail = fakeGmail();
    const client = new NamedClient(NAME);
    const message = { to: "tadas@tadasant.com", subject: "hi", plaintextBody: "b" };

    await client.sendMessage(message);
    await client.sendMessage({
      ...message,
      threadId: "t1",
      inReplyTo: "<a@mail.gmail.com>",
      references: "<a@mail.gmail.com>",
    });
    await client.createDraft(message);
    await client.updateDraft("d1", message);

    expect(gmail.raws.map((r) => r.path)).toEqual([
      "/messages/send",
      "/messages/send",
      "/drafts",
      "/drafts/d1",
    ]);
    for (const { from } of gmail.raws) expect(from).toBe(EXPECTED);
    // Configured means nothing is looked up, so neither an empty send-as name
    // nor a credential that cannot read settings can take it away.
    expect(gmail.sendAsCalls()).toBe(0);
  });

  it("is trimmed, and a blank one falls back to the send-as lookup", async () => {
    const gmail = fakeGmail();
    await new NamedClient(`  ${NAME}  `).sendMessage({ to: "a@example.com", subject: "s", plaintextBody: "b" });
    await new NamedClient("   ").sendMessage({ to: "a@example.com", subject: "s", plaintextBody: "b" });
    expect(gmail.raws.map((r) => r.from)).toEqual([EXPECTED, `From: ${ZIMMER}`]);
    expect(gmail.sendAsCalls()).toBe(1);
  });

  it("keeps the injection guard: a line break in the configured name cannot add a header", async () => {
    const gmail = fakeGmail();
    await new NamedClient("Eve\r\nBcc: victim@example.com").sendMessage({
      to: "a@example.com",
      subject: "s",
      plaintextBody: "b",
    });
    expect(gmail.raws[0].from).toBe(`From: "Eve Bcc: victim@example.com" <${ZIMMER}>`);
  });
});
