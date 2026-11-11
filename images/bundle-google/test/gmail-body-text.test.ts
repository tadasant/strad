/**
 * The body text of outgoing mail: hard-wrapped prose reflowed into paragraphs,
 * and every text part sent quoted-printable.
 *
 * `vendor/gmail-shared` is a FORK (see its `FORK.md`), and this suite is the
 * only thing defending delta 2 there. A re-vendor of upstream `src/` drops
 * `body-text.ts` and puts the raw body back on the wire, and every test here
 * fails.
 */
import { describe, it, expect, vi } from "vitest";
import {
  encodeQuotedPrintable,
  plainTextToHtml,
  reflowPlainText,
} from "../vendor/gmail-shared/src/gmail-client/lib/body-text.js";
import { buildMimeMessage } from "../vendor/gmail-shared/src/gmail-client/lib/mime-utils.js";
import { sendMessage } from "../vendor/gmail-shared/src/gmail-client/lib/send-message.js";
import { createDraft } from "../vendor/gmail-shared/src/gmail-client/lib/drafts.js";

/** What a receiving client does with a quoted-printable body. */
function decodeQuotedPrintable(wire: string): string {
  const joined = wire.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=") {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf-8").replace(/\r\n/g, "\n");
}

function bodyOf(message: string): string {
  return message.slice(message.indexOf("\r\n\r\n") + 4);
}

/** The two alternatives of a message's body, still as they are on the wire. */
function wireParts(message: string): { plain: string; html: string } {
  expect(message).toMatch(/Content-Type: multipart\/alternative;\r\n boundary="/);
  const boundary = message.match(/boundary="([^"]+)"/)![1];
  const parts = bodyOf(message)
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => p.replace(/^\r\n/, "").replace(/\r\n$/, ""));
  expect(parts).toHaveLength(2);
  expect(parts[0]).toMatch(
    /^Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n/,
  );
  expect(parts[1]).toMatch(
    /^Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n/,
  );
  return { plain: bodyOf(parts[0]), html: bodyOf(parts[1]) };
}

/** The two alternatives of a message's body, as the recipient's client reads them. */
function partsOf(message: string): { plain: string; html: string } {
  const { plain, html } = wireParts(message);
  return { plain: decodeQuotedPrintable(plain), html: decodeQuotedPrintable(html) };
}

/** A paragraph as an agent hard-wraps it, at 72 columns. */
const WRAPPED = [
  "I looked into the line breaks you noticed in mail the agents send. The",
  "body arrives with a newline every 72 columns, because that is how the",
  "model writes prose, and a plain-text part shows each one as a hard break.",
  "",
  "On a phone each of those lines wraps once more, which leaves a long line",
  "followed by a two-word one, all the way down the message.",
].join("\n");

const REFLOWED = [
  "I looked into the line breaks you noticed in mail the agents send. The body arrives with a newline every 72 columns, because that is how the model writes prose, and a plain-text part shows each one as a hard break.",
  "",
  "On a phone each of those lines wraps once more, which leaves a long line followed by a two-word one, all the way down the message.",
].join("\n");

describe("reflowPlainText", () => {
  it("joins a hard-wrapped paragraph and keeps the paragraph break", () => {
    expect(reflowPlainText(WRAPPED)).toBe(REFLOWED);
  });

  it("treats CRLF input the same as LF", () => {
    expect(reflowPlainText(WRAPPED.replace(/\n/g, "\r\n"))).toBe(REFLOWED);
  });

  it("leaves a body that is not hard-wrapped exactly as written", () => {
    // The Sent copy of a real send from zimmer@tadasant.com, 2026-10-10.
    const real = [
      "Hi Tadas,",
      "",
      "This is a test email from Zimmer's own mailbox (zimmer@tadasant.com). You asked for it in session https://zimmer.tadasant.com/sessions/23676, and it was sent after Zimmer's own sends were ungated (tadasant-internal#3172).",
      "",
      "Sent at: 2026-10-10T21:27:27Z (UTC)",
      "Sending session: https://zimmer.tadasant.com/sessions/24151",
      "",
      "No reply needed.",
      "",
      "— Zimmer",
    ].join("\n");
    expect(reflowPlainText(real)).toBe(real);
  });

  it("keeps short intentional lines: a sign-off, key-value rows, an address", () => {
    const text = [
      "Thanks,",
      "Zimmer",
      "",
      "Status: merged",
      "Image: ghcr.io/tadasant/strad-server-bundle-google:0.1.42",
      "",
      "123 Main Street",
      "Springfield",
    ].join("\n");
    expect(reflowPlainText(text)).toBe(text);
  });

  it("keeps a line break the next word would have fitted after", () => {
    const text = [
      "The deploy finished and every check came back green this morning.",
      "Two follow-ups remain open.",
      "One is the DNS record, and the other one is the alert threshold change.",
    ].join("\n");
    // Each line ends where the author ended it: "Two" and "One" would both
    // have fitted on the line before, so neither break is a wrap.
    expect(reflowPlainText(text)).toBe(text);
  });

  it("keeps list items on their own lines and joins their wrapped continuations", () => {
    const text = [
      "What changed:",
      "- The plain-text body is reflowed, so a paragraph that was wrapped at",
      "  72 columns reaches the recipient as one paragraph again.",
      "- Every text part is sent quoted-printable.",
      "* A second marker style, which also wraps onto a continuation line",
      "  indented to the item text.",
      "1. A numbered item.",
      "2) Another numbered item, which is wrapped without any indentation on",
      "the next line.",
    ].join("\n");
    expect(reflowPlainText(text)).toBe(
      [
        "What changed:",
        "- The plain-text body is reflowed, so a paragraph that was wrapped at 72 columns reaches the recipient as one paragraph again.",
        "- Every text part is sent quoted-printable.",
        "* A second marker style, which also wraps onto a continuation line indented to the item text.",
        "1. A numbered item.",
        "2) Another numbered item, which is wrapped without any indentation on the next line.",
      ].join("\n"),
    );
  });

  it("does not join a paragraph line onto the list item before it when the item is short", () => {
    const text = ["- one", "- two", "- three"].join("\n");
    expect(reflowPlainText(text)).toBe(text);
  });

  it("keeps fenced code, quoted lines, indented blocks, headings and tables verbatim", () => {
    const text = [
      "Run this, which prints every line of the configuration it loads:",
      "```",
      "npm run config:check -- --config strad.config.yaml --verbose --all",
      "echo done and this line is long enough to look like wrapped prose",
      "```",
      "> On Friday you wrote that the breaks show up on every message sent",
      "> from the agents' mailbox, and not on the ones you send yourself.",
      "The relevant block of the spec is below, indented as it is in the file:",
      "    services:",
      "      - name: bundle-google, which runs the gmail and calendar servers",
      "# A heading line that is long enough to look like a wrapped paragraph",
      "| slug | image | status of the latest deploy to the production app |",
      "| gmail-zimmer-rw | bundle-google | green and serving tools right now |",
    ].join("\n");
    expect(reflowPlainText(text)).toBe(text);
  });

  it("does not join a sentence onto a bare URL line", () => {
    const text = [
      "The full report from this morning's run is at the link below, as usual:",
      "https://zimmer.tadasant.com/sessions/24161/artifacts/report-final.html",
      "Have a look when you get a chance and tell me what you think of it.",
    ].join("\n");
    expect(reflowPlainText(text)).toBe(text);
  });
});

describe("reflowPlainText: lines a long line above must not swallow", () => {
  const LONG =
    "The deploy went out this morning and every check on it came back green";

  it.each([
    [
      "a label row after a line ending in a colon",
      [`${LONG}:`, "Status: merged"],
    ],
    [
      "label rows after a long line",
      [
        LONG,
        "Status: merged",
        "Image: ghcr.io/tadasant/strad-server-bundle-google:0.1.42",
      ],
    ],
    [
      "an address under an intro line",
      [`${LONG}. Send the forms to:`, "Attn: Legal"],
    ],
    [
      "a sign-off with no blank line above it",
      [LONG, "Best regards,", "Zimmer"],
    ],
    [
      "a P.S. line",
      [LONG, "P.S. The dashboards are linked from the status page as well."],
    ],
  ])("keeps %s", (_name, lines) => {
    const text = lines.join("\n");
    expect(reflowPlainText(text)).toBe(text);
  });

  it("keeps everything below a `-- ` signature separator as written", () => {
    const text = [
      "The deploy went out this morning and every check on it came back",
      "green, so there is nothing left for you to do on this one.",
      "-- ",
      "Zimmer, the agent orchestrator that runs on the box under the desk and",
      "sends mail from zimmer@tadasant.com",
    ].join("\n");
    expect(reflowPlainText(text)).toBe(
      [
        "The deploy went out this morning and every check on it came back green, so there is nothing left for you to do on this one.",
        ...text.split("\n").slice(2),
      ].join("\n"),
    );
  });
});

describe("encodeQuotedPrintable", () => {
  it("keeps every wire line within 76 characters and round-trips exactly", () => {
    const text = `${"word ".repeat(200).trim()}\n\nnext — paragraph ✓ with = signs\nand a trailing space \n`;
    const wire = encodeQuotedPrintable(text);
    for (const line of wire.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(decodeQuotedPrintable(wire)).toBe(text);
  });

  it("encodes non-ASCII, '=', and whitespace at the end of a line", () => {
    expect(encodeQuotedPrintable("a=b — c \nd\t")).toBe(
      "a=3Db =E2=80=94 c=20\r\nd=09",
    );
  });

  it("never splits one character's bytes across a soft break", () => {
    // 74 ASCII characters, then characters of two, three and four bytes.
    const text = `${"x".repeat(74)}é—😀${"y".repeat(80)}`;
    const wire = encodeQuotedPrintable(text);
    // Each wire line decodes to valid UTF-8 on its own.
    for (const line of wire.split("\r\n")) {
      expect(decodeQuotedPrintable(line.replace(/=$/, ""))).not.toContain(
        "\uFFFD",
      );
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(wire.split("\r\n")[0]).toBe(`${"x".repeat(74)}=`);
    expect(decodeQuotedPrintable(wire)).toBe(text);
  });

  it("splits a long line with soft breaks only", () => {
    const line = "x".repeat(200);
    const wire = encodeQuotedPrintable(line);
    expect(
      wire
        .split("\r\n")
        .slice(0, -1)
        .every((l) => l.endsWith("=")),
    ).toBe(true);
    expect(decodeQuotedPrintable(wire)).toBe(line);
  });
});

describe("buildMimeMessage body parts", () => {
  it("sends a plain-text body reflowed and quoted-printable", () => {
    const message = buildMimeMessage("me@example.com", {
      to: "you@example.com",
      subject: "Line breaks",
      plaintextBody: WRAPPED,
    });
    const wire = wireParts(message).plain;
    for (const line of wire.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    // Two paragraphs and the blank line between them: three hard lines.
    expect(wire.split(/(?<!=)\r\n/)).toHaveLength(3);
    expect(decodeQuotedPrintable(wire)).toBe(REFLOWED);
  });

  it("sends an HTML rendering of a plain-text-only body beside it", () => {
    const message = buildMimeMessage("me@example.com", {
      to: "you@example.com",
      subject: "Line breaks",
      plaintextBody: WRAPPED,
    });
    expect(partsOf(message).html).toBe(plainTextToHtml(REFLOWED));
  });

  it("does not hard-break a long paragraph", () => {
    const paragraph = "This sentence is repeated to make one long paragraph. "
      .repeat(30)
      .trim();
    const message = buildMimeMessage("me@example.com", {
      to: "you@example.com",
      subject: "Long",
      plaintextBody: paragraph,
    });
    const { plain, html } = wireParts(message);
    expect(plain.split(/(?<!=)\r\n/)).toHaveLength(1);
    expect(decodeQuotedPrintable(plain)).toBe(paragraph);
    expect(decodeQuotedPrintable(html)).toBe(`<div dir="auto">${paragraph}</div>`);
  });

  it("keeps every header line within 78 characters", () => {
    const message = buildMimeMessage("me@example.com", {
      to: "you@example.com",
      subject: "s",
      plaintextBody: "Hello",
    });
    const headers = message.slice(0, message.indexOf("\r\n\r\n")).split("\r\n");
    expect(Math.max(...headers.map((l) => l.length))).toBeLessThanOrEqual(78);
  });

  it("encodes both alternatives and reflows only the plain text", () => {
    const html = `<p>${"An HTML paragraph that is long. ".repeat(10).trim()}</p>\n<p>Second</p>`;
    const message = buildMimeMessage("me@example.com", {
      to: "you@example.com",
      subject: "Both",
      plaintextBody: WRAPPED,
      htmlBody: html,
    });
    const boundary = message.match(/boundary="([^"]+)"/)![1];
    const parts = message
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((p) => p.replace(/^\r\n/, "").replace(/\r\n$/, ""));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(
      /^Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n/,
    );
    expect(parts[1]).toMatch(
      /^Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n/,
    );
    expect(decodeQuotedPrintable(bodyOf(parts[0]))).toBe(REFLOWED);
    expect(decodeQuotedPrintable(bodyOf(parts[1]))).toBe(html);
  });

  it("still strips leading newlines from the body", () => {
    const message = buildMimeMessage("me@example.com", {
      to: "you@example.com",
      subject: "s",
      plaintextBody: "\n\r\nHello",
    });
    expect(partsOf(message)).toEqual({ plain: "Hello", html: '<div dir="auto">Hello</div>' });
  });

  it("sends an html_body alone as a single text/html part", () => {
    const message = buildMimeMessage("me@example.com", {
      to: "you@example.com",
      subject: "s",
      htmlBody: "<p>Hi</p>",
    });
    expect(message).not.toContain("multipart/alternative");
    expect(message).toContain(
      "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>Hi</p>",
    );
  });
});

describe("plainTextToHtml", () => {
  it("escapes markup and keeps every line break as a <br>", () => {
    expect(plainTextToHtml("a < b && \"c\" > 'd'\n\n<script>")).toBe(
      '<div dir="auto">a &lt; b &amp;&amp; &quot;c&quot; &gt; &#39;d&#39;<br>\n<br>\n&lt;script&gt;</div>',
    );
  });

  it("links bare URLs and leaves sentence punctuation outside the link", () => {
    expect(
      plainTextToHtml("See https://x.test/a?b=1&c=2. Or (https://x.test/wiki/A_(b)), then stop."),
    ).toBe(
      '<div dir="auto">See <a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>. ' +
        'Or (<a href="https://x.test/wiki/A_(b)">https://x.test/wiki/A_(b)</a>), then stop.</div>',
    );
  });

  it("leaves markdown emphasis and unopened brackets outside the link", () => {
    expect(plainTextToHtml("**https://x.test/b** [docs](https://x.test/c) [https://x.test/d]")).toBe(
      '<div dir="auto">**<a href="https://x.test/b">https://x.test/b</a>** ' +
        '[docs](<a href="https://x.test/c">https://x.test/c</a>) ' +
        '[<a href="https://x.test/d">https://x.test/d</a>]</div>',
    );
  });

  it("links an upper-case scheme, and never a bare scheme", () => {
    expect(plainTextToHtml("HTTPS://X.test/a and http://. too")).toBe(
      '<div dir="auto"><a href="HTTPS://X.test/a">HTTPS://X.test/a</a> and http://. too</div>',
    );
  });

  it("keeps runs of spaces and tabs inside a line, so columns stay aligned", () => {
    expect(plainTextToHtml("| a    | b |\n\tx  y")).toBe(
      '<div dir="auto">| a&nbsp;&nbsp;&nbsp; | b |<br>\n&nbsp;&nbsp;&nbsp;&nbsp;x&nbsp; y</div>',
    );
  });

  it("keeps the indent of an indented line", () => {
    expect(plainTextToHtml("code:\n    x = 1")).toBe(
      '<div dir="auto">code:<br>\n&nbsp;&nbsp;&nbsp;&nbsp;x = 1</div>',
    );
  });
});

/**
 * The reply that reached Tadas on 2026-10-16 with a break every ~70 columns,
 * as an agent hard-wraps it. Its Sent copy held each paragraph on one line —
 * the reflow had worked — and Gmail still drew the breaks, because it lays a
 * text/plain-only message out at its own ~70 columns. The HTML alternative is
 * what Gmail renders instead.
 */
describe("regression: the 2026-10-16 reply", () => {
  const SENT = [
    "Loud and clear. Your email reached zimmer@tadasant.com, passed sender",
    "verification (DKIM pass via the tadasant.com Workspace key, sent",
    "directly rather than via a group), and the inbound-email trigger",
    "picked it up in this session:",
    "https://zimmer.tadasant.com/sessions/25069",
    "",
    "Nothing else to do here, so I'm archiving the session. Send a real",
    "request any time.",
    "",
    "— Zimmer",
  ].join("\n");

  const message = buildMimeMessage("zimmer@tadasant.com", {
    to: "tadas@tadasant.com",
    subject: "Re: Hello world",
    plaintextBody: SENT,
  });

  it("reflows the plain text to what the Sent copy held", () => {
    expect(partsOf(message).plain).toBe(
      [
        "Loud and clear. Your email reached zimmer@tadasant.com, passed sender verification (DKIM pass via the tadasant.com Workspace key, sent directly rather than via a group), and the inbound-email trigger picked it up in this session:",
        "https://zimmer.tadasant.com/sessions/25069",
        "",
        "Nothing else to do here, so I'm archiving the session. Send a real request any time.",
        "",
        "— Zimmer",
      ].join("\n"),
    );
  });

  it("sends an HTML part with no break inside a paragraph", () => {
    expect(partsOf(message).html).toBe(
      '<div dir="auto">' +
        "Loud and clear. Your email reached zimmer@tadasant.com, passed sender verification (DKIM pass via the tadasant.com Workspace key, sent directly rather than via a group), and the inbound-email trigger picked it up in this session:<br>\n" +
        '<a href="https://zimmer.tadasant.com/sessions/25069">https://zimmer.tadasant.com/sessions/25069</a><br>\n' +
        "<br>\n" +
        "Nothing else to do here, so I&#39;m archiving the session. Send a real request any time.<br>\n" +
        "<br>\n" +
        "— Zimmer</div>",
    );
  });
});

describe("the request Gmail receives", () => {
  async function rawSentBy(
    send: (base: string) => Promise<unknown>,
  ): Promise<string> {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "m1", threadId: "t1", message: { id: "m1" } }),
        {
          status: 200,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await send("https://gmail.example/v1/users/me");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      return Buffer.from(body.raw ?? body.message.raw, "base64url").toString(
        "utf-8",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }

  const options = {
    to: "you@example.com",
    subject: "s",
    plaintextBody: WRAPPED,
  };

  it("sendMessage sends the reflowed body", async () => {
    const raw = await rawSentBy((base) =>
      sendMessage(base, {}, "me@example.com", options),
    );
    expect(partsOf(raw).plain).toBe(REFLOWED);
  });

  it("createDraft saves the reflowed body", async () => {
    const raw = await rawSentBy((base) =>
      createDraft(base, {}, "me@example.com", options),
    );
    expect(partsOf(raw).plain).toBe(REFLOWED);
  });
});
