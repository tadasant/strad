/**
 * `send_email` asks a human first, at the address the CALL carries.
 *
 * What this suite proves, end to end through a real MCP client and the
 * verbatim gmail tree:
 *
 *   - no channel, no send: a call without core's `_meta` entry is refused
 *     before the tool runs, and the mailbox is never touched;
 *   - the container cannot widen that: `ELICITATION_ENABLED=false` or a
 *     container-wide URL makes the tool refuse rather than skip or misroute;
 *   - with a channel, the approval request goes to THAT URL (and only that
 *     one), the poll follows the Zimmer protocol, and only `accept` sends;
 *   - two concurrent calls with two channels never cross.
 *
 * The approval endpoint here is a stand-in for Zimmer's
 * `/api/v1/elicitations/session/<token>`: POST creates, GET `<url>/<id>` polls.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IGmailClient } from "gmail-workspace-mcp-server-shared";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, test } from "vitest";

import {
  CONFIRMED_TOOLS,
  ELICITATION_META_KEY,
  channelFrom,
} from "../src/confirm.js";
import { createMCPServer } from "../src/gmail.js";

// --- a stand-in approval endpoint -------------------------------------------

type Answer = "accept" | "decline" | "pending" | "unchecked";

interface Seen {
  path: string;
  body: Record<string, unknown>;
}

const created: Seen[] = [];
const polled: string[] = [];
/** The answer each session path gives on its next poll. */
const answers = new Map<string, Answer>();

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

const endpoint = createServer(async (req, res) => {
  const path = req.url ?? "";
  // Misbehaving endpoints, by path prefix.
  if (path.startsWith("/redirect/")) {
    res.writeHead(307, { location: `/session/redirected${path.slice(9)}` });
    res.end();
    return;
  }
  if (path.startsWith("/broken/")) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("INTERNAL-ONLY-RESPONSE-BODY");
    return;
  }
  if (path.startsWith("/hang/") && req.method === "GET") {
    // Answers accept, too late: after the deadline the caller sent.
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ action: "accept", content: { confirm: true } }));
    }, 1_500);
    return;
  }
  res.setHeader("content-type", "application/json");
  if (req.method === "POST") {
    const body = JSON.parse(await read(req)) as Record<string, unknown>;
    created.push({ path, body });
    res.end(JSON.stringify({ action: "pending" }));
    return;
  }
  polled.push(path);
  const session = path.slice(0, path.lastIndexOf("/"));
  const answer = answers.get(session) ?? "pending";
  if (answer === "pending") res.end(JSON.stringify({ action: "pending" }));
  else if (answer === "unchecked")
    res.end(JSON.stringify({ action: "accept", content: { confirm: false } }));
  else res.end(JSON.stringify({ action: answer, content: { confirm: true } }));
});

let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => endpoint.close(() => r())));

// Every name the library reads. Cleared before the suite as well as after each
// test, because an agent running it may itself carry them: a Zimmer session's
// environment holds its own ELICITATION_REQUEST_URL, which is exactly the
// container-wide address the guard refuses.
const ENV_NAMES = [
  "ELICITATION_ENABLED",
  "ELICITATION_REQUEST_URL",
  "ELICITATION_POLL_URL",
  "ELICITATION_PREFER_HTTP_FALLBACK",
  "ELICITATION_SESSION_ID",
  "ELICITATION_TTL_MS",
] as const;
beforeAll(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});
afterEach(() => {
  created.length = 0;
  polled.length = 0;
  answers.clear();
  for (const name of ENV_NAMES) delete process.env[name];
});

// --- a mailbox that records sends -------------------------------------------

function mailbox() {
  const sent: unknown[] = [];
  const client = {
    sendMessage: async (msg: unknown) => {
      sent.push(msg);
      return { id: "m1", threadId: "t1" };
    },
    sendDraft: async (id: string) => {
      sent.push({ draft: id });
      return { id: "m1", threadId: "t1" };
    },
    getAccountEmail: async () => "tadas@tadasant.com",
    getDraft: async (id: string) => ({
      id,
      message: {
        id: "m0",
        threadId: "t0",
        payload: {
          headers: [
            { name: "To", value: "stranger@example.com" },
            { name: "Subject", value: "the staged one" },
          ],
        },
      },
    }),
    listMessages: async () => ({ messages: [], resultSizeEstimate: 0 }),
  } as unknown as IGmailClient;
  return { sent, client };
}

async function connect(client: IGmailClient): Promise<Client> {
  const { registerHandlers } = createMCPServer({
    version: "test",
    env: {
      GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@x.iam.gserviceaccount.com",
      GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: "key",
      GMAIL_IMPERSONATE_EMAIL: "tadas@tadasant.com",
    },
  });
  const server = new Server(
    { name: "gmail", version: "test" },
    { capabilities: { tools: {} } },
  );
  await registerHandlers(server, () => client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "core", version: "test" });
  await mcp.connect(b);
  return mcp;
}

const SEND = {
  to: "someone@example.com",
  subject: "hello",
  plaintext_body: "body",
};

const meta = (entry: unknown) => ({ [ELICITATION_META_KEY]: entry });

const text = (res: unknown): string =>
  (res as { content: Array<{ text: string }> }).content[0]?.text ?? "";

// --- fail closed ------------------------------------------------------------

test("no channel: send_email is refused before it runs, and nothing is sent", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({ name: "send_email", arguments: SEND });
  assert.equal(res.isError, true);
  assert.match(text(res), /NOT run/);
  assert.match(text(res), /carried no confirmation channel/);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
});

test("a channel core refused: the refusal names core's reason", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ refused: "origin https://evil.example is not allowed" }),
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /evil\.example is not allowed/);
  assert.equal(sent.length, 0);
});

test("ELICITATION_ENABLED=false on the container does not skip the human", async () => {
  process.env.ELICITATION_ENABLED = "false";
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/session/1-a` }),
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /ELICITATION_ENABLED=false/);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
});

test("a container-wide approval URL is refused, never used", async () => {
  process.env.ELICITATION_REQUEST_URL = `${base}/session/shared`;
  process.env.ELICITATION_POLL_URL = `${base}/session/shared`;
  answers.set("/session/shared", "accept");
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/session/1-a` }),
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /container-wide/);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0);
});

test("tools that do not send are untouched by the guard", async () => {
  const { client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "list_draft_emails",
    arguments: {},
  });
  assert.doesNotMatch(text(res), /NOT run/);
});

// --- with a channel ---------------------------------------------------------

test("accept: the request goes to the CALL's URL, and the mail is sent once", async () => {
  answers.set("/session/42-tok", "accept");
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({
      url: `${base}/session/42-tok`,
      slug: "gmail-rw-external",
      ttlMs: 30_000,
    }),
  });
  assert.notEqual(res.isError, true, text(res));
  assert.match(text(res), /sent successfully/);
  assert.equal(sent.length, 1);

  assert.equal(created.length, 1);
  assert.equal(created[0]!.path, "/session/42-tok");
  const body = created[0]!.body;
  assert.match(String(body.message), /strad slug gmail-rw-external/);
  assert.match(String(body.message), /tadas@tadasant\.com/);
  assert.match(String(body.message), /To: someone@example\.com/);
  const m = body._meta as Record<string, string>;
  assert.equal(m["com.pulsemcp/tool-name"], "send_email");
  // The deadline is core's, so the prompt expires before the hop times out.
  const ttl = Date.parse(m["com.pulsemcp/expires-at"]!) - Date.now();
  assert.ok(ttl > 20_000 && ttl <= 30_000, `ttl ${ttl}`);
  assert.equal(polled[0], `/session/42-tok/${m["com.pulsemcp/request-id"]}`);
});

test("decline: nothing is sent", async () => {
  answers.set("/session/42-tok", "decline");
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/session/42-tok` }),
  });
  assert.match(text(res), /cancelled/);
  assert.equal(sent.length, 0);
});

test("accept with the box unchecked: nothing is sent", async () => {
  answers.set("/session/42-tok", "unchecked");
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/session/42-tok` }),
  });
  assert.match(text(res), /not confirmed/);
  assert.equal(sent.length, 0);
});

test("no answer before the deadline: expired, nothing is sent", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/session/42-tok`, ttlMs: 200 }),
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /expired/);
  assert.equal(sent.length, 0);
});

test("two calls in flight with two channels never cross", async () => {
  answers.set("/session/1-a", "accept");
  answers.set("/session/2-b", "decline");
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const [one, two] = await Promise.all([
    mcp.callTool({
      name: "send_email",
      arguments: { ...SEND, subject: "from one" },
      _meta: meta({ url: `${base}/session/1-a` }),
    }),
    mcp.callTool({
      name: "send_email",
      arguments: { ...SEND, subject: "from two" },
      _meta: meta({ url: `${base}/session/2-b` }),
    }),
  ]);
  assert.match(text(one), /sent successfully/);
  assert.match(text(two), /cancelled/);
  assert.equal(sent.length, 1);
  const bySubject = Object.fromEntries(
    created.map((c) => [
      /Subject: (.*)/.exec(String(c.body.message))![1],
      c.path,
    ]),
  );
  assert.deepEqual(bySubject, {
    "from one": "/session/1-a",
    "from two": "/session/2-b",
  });
});

// --- the parse --------------------------------------------------------------

test("channelFrom: only a web URL from core's own key counts", () => {
  assert.equal(channelFrom(undefined), null);
  assert.equal(channelFrom({ other: { url: "https://x" } }), null);
  assert.equal(channelFrom(meta({ url: "file:///etc/passwd" })), null);
  assert.equal(channelFrom(meta({ url: "not a url" })), null);
  assert.deepEqual(
    channelFrom(meta({ url: "https://z.example/s/1-a", ttlMs: -1 })),
    {
      url: "https://z.example/s/1-a",
      slug: undefined,
      ttlMs: undefined,
    },
  );
});

// --- the list the guard keys on ---------------------------------------------

test("CONFIRMED_TOOLS is every vendored gmail tool that asks for confirmation", () => {
  const dir = join(import.meta.dirname, "../vendor/gmail-shared/src/tools");
  const eliciting = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) =>
      readFileSync(join(dir, f), "utf8").includes("requestConfirmation"),
    )
    .map(
      (f) => /name:\s*'([a-z_]+)'/.exec(readFileSync(join(dir, f), "utf8"))![1],
    )
    .sort();
  assert.deepEqual(eliciting, [...CONFIRMED_TOOLS].sort());
});

// --- the endpoint misbehaving -----------------------------------------------

test("a redirect from the approval endpoint is never followed", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/redirect/1-a` }),
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /could not be reached/);
  assert.equal(sent.length, 0);
  assert.equal(created.length, 0, "the redirect target saw nothing");
});

test("a failing endpoint's body never reaches the caller", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/broken/1-a` }),
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /HTTP 500/);
  assert.doesNotMatch(text(res), /INTERNAL-ONLY/);
  assert.equal(sent.length, 0);
});

test("an accept that arrives after the deadline sends nothing", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const started = Date.now();
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/hang/1-a`, ttlMs: 400 }),
  });
  assert.match(text(res), /expired/);
  assert.equal(sent.length, 0);
  assert.ok(Date.now() - started < 1_400, "the hung request was abandoned");
});

// --- what the human is shown ------------------------------------------------

test("a draft send shows the draft's recipients and subject, not just its id", async () => {
  answers.set("/session/42-tok", "decline");
  const { client } = mailbox();
  const mcp = await connect(client);
  await mcp.callTool({
    name: "send_email",
    arguments: { from_draft_id: "r-123" },
    _meta: meta({ url: `${base}/session/42-tok` }),
  });
  const message = String(created[0]!.body.message);
  assert.match(message, /r-123/);
  assert.match(message, /To: stranger@example\.com/);
  assert.match(message, /Subject: the staged one/);
});

// --- the container env, its other spellings ---------------------------------

test("a container-wide request URL alone is refused too", async () => {
  process.env.ELICITATION_REQUEST_URL = `${base}/session/shared`;
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/session/1-a` }),
  });
  assert.match(text(res), /container-wide/);
  assert.equal(sent.length, 0);
});

test("ELICITATION_ENABLED=FALSE, in capitals, is the same refusal", async () => {
  process.env.ELICITATION_ENABLED = "FALSE";
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({ url: `${base}/session/1-a` }),
  });
  assert.match(text(res), /ELICITATION_ENABLED=false/);
  assert.equal(sent.length, 0);
});
