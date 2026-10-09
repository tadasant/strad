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
 *   - two concurrent calls with two channels never cross;
 *   - core's `skip` waiver sends without asking, for that call alone: a
 *     sibling mount's call in flight at the same time still asks or refuses;
 *   - a call that is DROPPED while the human decides (cancelled, or its HTTP
 *     response closed) never sends, even when the human then says yes;
 *   - a waiting call sends keepalive progress, and the edge headers core
 *     forwards go on the POST and every poll.
 *
 * The approval endpoint here is a stand-in for Zimmer's
 * `/api/v1/elicitations/session/<token>`: POST creates, GET `<url>/<id>` polls.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createRegisterTools,
  type IGmailClient,
} from "gmail-workspace-mcp-server-shared";
import express from "express";
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
  gateGmailSends,
  guardSends,
  isGmailSend,
  withConfirmation,
} from "../src/confirm.js";
import { createMCPServer } from "../src/gmail.js";

// --- a stand-in approval endpoint -------------------------------------------

type Answer = "accept" | "decline" | "pending" | "unchecked";

interface Seen {
  path: string;
  body: Record<string, unknown>;
  headers: IncomingMessage["headers"];
}

const created: Seen[] = [];
const polled: string[] = [];
const polledHeaders: IncomingMessage["headers"][] = [];
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
    created.push({ path, body, headers: req.headers });
    res.end(JSON.stringify({ action: "pending" }));
    return;
  }
  polled.push(path);
  polledHeaders.push(req.headers);
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
  polledHeaders.length = 0;
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

// --- a slug that waives the human -------------------------------------------

const SKIP = meta({ skip: true, slug: "gmail-zimmer-rw-external" });

test("skip: send_email sends without asking anyone", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: SKIP,
  });
  assert.notEqual(res.isError, true, text(res));
  assert.match(text(res), /sent successfully/);
  assert.equal(sent.length, 1);
  assert.equal(created.length, 0);
  assert.equal(polled.length, 0);
});

test("skip: a draft send goes out unasked too", async () => {
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: { from_draft_id: "d1" },
    _meta: SKIP,
  });
  assert.notEqual(res.isError, true, text(res));
  assert.deepEqual(sent, [{ draft: "d1" }]);
  assert.equal(created.length, 0);
});

test("skip does not outrank the container: ELICITATION_ENABLED=false still refuses", async () => {
  process.env.ELICITATION_ENABLED = "false";
  const { sent, client } = mailbox();
  const mcp = await connect(client);
  const res = await mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: SKIP,
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /ELICITATION_ENABLED=false/);
  assert.equal(sent.length, 0);
});

test("a waived call and an asking call in flight at once, on two mounts, never cross", async () => {
  // One process, two mounts, as the bundle runs them: Zimmer's own mailbox
  // (waived) and a person's (asked, then declined), plus a third call that
  // carries nothing. The waiver is the waived call's alone.
  answers.set("/session/9-z", "pending");
  const own = mailbox();
  const person = mailbox();
  const ownMcp = await connect(own.client);
  const personMcp = await connectFast(person.client);
  const asking = personMcp.callTool({
    name: "send_email",
    arguments: { ...SEND, subject: "as a person" },
    _meta: meta({ url: `${base}/session/9-z`, ttlMs: 30_000 }),
  });
  await until(() => created.length === 1);
  const [waived, bare] = await Promise.all([
    ownMcp.callTool({
      name: "send_email",
      arguments: { ...SEND, subject: "as zimmer" },
      _meta: SKIP,
    }),
    personMcp.callTool({ name: "send_email", arguments: SEND }),
  ]);
  assert.match(text(waived), /sent successfully/);
  assert.equal(own.sent.length, 1);
  assert.equal(bare.isError, true);
  assert.match(text(bare), /carried no confirmation channel/);
  // The asking call is still waiting on its human, who says no.
  assert.equal(person.sent.length, 0);
  answers.set("/session/9-z", "decline");
  assert.match(text(await asking), /cancelled/);
  assert.equal(person.sent.length, 0);
  assert.equal(created.length, 1);
  assert.match(String(created[0]!.body.message), /Subject: as a person/);
});

// --- the parse --------------------------------------------------------------

test("channelFrom: only a web URL from core's own key counts", () => {
  assert.equal(channelFrom(undefined), null);
  assert.equal(channelFrom({ other: { url: "https://x" } }), null);
  assert.equal(channelFrom(meta({ url: "file:///etc/passwd" })), null);
  assert.equal(channelFrom(meta({ url: "not a url" })), null);
  // The waiver is exactly `skip: true`, and never beside a URL.
  assert.deepEqual(channelFrom(meta({ skip: true, slug: "s" })), {
    skip: true,
    slug: "s",
  });
  assert.equal(channelFrom(meta({ skip: "true" })), null);
  assert.equal(
    channelFrom(meta({ skip: true, url: "https://z.example/s/1-a" })),
    null,
  );
  assert.deepEqual(
    channelFrom(meta({ url: "https://z.example/s/1-a", ttlMs: -1 })),
    {
      url: "https://z.example/s/1-a",
      slug: undefined,
      ttlMs: undefined,
      headers: undefined,
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

// --- a call that goes away ---------------------------------------------------

/**
 * The same registration `src/gmail.ts` performs, with the clocks shortened:
 * the vendored tools over `withConfirmation`, the mailbox behind `guardSends`.
 */
async function serverFor(client: IGmailClient): Promise<Server> {
  const server = new Server(
    { name: "gmail", version: "test" },
    { capabilities: { tools: {} } },
  );
  createRegisterTools(() => guardSends(client), undefined)(
    withConfirmation(server, {
      account: "tadas@tadasant.com",
      client: () => client,
      pollIntervalMs: 20,
      keepaliveMs: 30,
    }),
  );
  return server;
}

async function connectFast(client: IGmailClient): Promise<Client> {
  const server = await serverFor(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "core", version: "test" });
  await mcp.connect(b);
  return mcp;
}

const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a call cancelled while the human decides never sends, even on a later yes", async () => {
  const { sent, client } = mailbox();
  const mcp = await connectFast(client);
  const controller = new AbortController();
  const call = mcp.callTool(
    {
      name: "send_email",
      arguments: SEND,
      _meta: meta({ url: `${base}/session/drop-1`, ttlMs: 30_000 }),
    },
    undefined,
    { signal: controller.signal },
  );
  await until(() => polled.length > 0);
  controller.abort();
  await assert.rejects(call);
  // The human approves after the caller has gone.
  answers.set("/session/drop-1", "accept");
  await settle(200);
  assert.equal(sent.length, 0);
  const polls = polled.length;
  await settle(100);
  assert.equal(polled.length, polls, "polling stopped with the call");
});

test("a call whose HTTP response closes never sends: the hop core's fetch drops", async () => {
  // The real shape of the incident: core's fetch gives up on a silent body and
  // closes the socket. No MCP cancel is sent; the response just closes.
  const { sent, client } = mailbox();
  const app = express();
  app.use(express.json());
  app.post("/gmail", async (req, res) => {
    const server = await serverFor(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const http = app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/gmail`;
  try {
    const controller = new AbortController();
    const call = fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_email",
          arguments: SEND,
          _meta: meta({ url: `${base}/session/drop-2`, ttlMs: 30_000 }),
        },
      }),
      signal: controller.signal,
    }).then((r) => r.text());
    await until(() => polled.length > 0);
    controller.abort();
    await assert.rejects(call);
    answers.set("/session/drop-2", "accept");
    await settle(200);
    assert.equal(sent.length, 0);
  } finally {
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
  }
});

test("a call dropped between the approval and the send is refused at the send", async () => {
  // A reply reads the original message after the approval and before sending:
  // the one gap askHuman's own check cannot see.
  answers.set("/session/drop-3", "accept");
  const { sent, client } = mailbox();
  const controller = new AbortController();
  (client as unknown as Record<string, unknown>).getMessage = async () => {
    controller.abort();
    await settle(100);
    return { id: "o1", threadId: "t1", payload: { headers: [] } };
  };
  const mcp = await connectFast(client);
  const call = mcp.callTool(
    {
      name: "send_email",
      arguments: { ...SEND, reply_to_email_id: "o1", thread_id: "t1" },
      _meta: meta({ url: `${base}/session/drop-3`, ttlMs: 30_000 }),
    },
    undefined,
    { signal: controller.signal },
  );
  await assert.rejects(call);
  await settle(200);
  assert.equal(created.length, 1, "the human was asked");
  assert.equal(sent.length, 0);
});

test("a waiting call sends keepalive progress against core's token", async () => {
  const { client } = mailbox();
  const mcp = await connectFast(client);
  const beats: number[] = [];
  const call = mcp.callTool(
    {
      name: "send_email",
      arguments: SEND,
      _meta: meta({ url: `${base}/session/beat`, ttlMs: 30_000 }),
    },
    undefined,
    { onprogress: (p) => beats.push(p.progress) },
  );
  await until(() => beats.length >= 3);
  answers.set("/session/beat", "decline");
  const res = await call;
  assert.match(text(res), /cancelled/);
  assert.deepEqual(beats.slice(0, 3), [1, 2, 3]);
});

test("core's edge headers go on the POST and every poll, and cannot replace content-type", async () => {
  const { client } = mailbox();
  const mcp = await connectFast(client);
  const call = mcp.callTool({
    name: "send_email",
    arguments: SEND,
    _meta: meta({
      url: `${base}/session/edge`,
      ttlMs: 30_000,
      headers: {
        "CF-Access-Client-Id": "id.access",
        "CF-Access-Client-Secret": "s3cret",
        "Content-Type": "text/plain",
        "bad name": "x",
      },
    }),
  });
  await until(() => polled.length >= 2);
  answers.set("/session/edge", "decline");
  await call;
  for (const headers of [created[0]!.headers, ...polledHeaders]) {
    assert.equal(headers["cf-access-client-id"], "id.access");
    assert.equal(headers["cf-access-client-secret"], "s3cret");
    assert.equal(headers["content-type"], "application/json");
  }
});

test("channelFrom: headers keep only string values under sendable names", () => {
  const channel = channelFrom(
    meta({
      url: "https://z.example/s/1-a",
      headers: { "CF-Access-Client-Id": "a", n: 1, Host: "evil", "a b": "c" },
    }),
  );
  assert.deepEqual(channel && "url" in channel && channel.headers, {
    "CF-Access-Client-Id": "a",
  });
});

test("a call dropped during the send's own token mint is refused at the send request", async () => {
  // The vendored sendMessage mints a token and reads the sender before its
  // POST; a drop in there passes the client-method check. The request gate is
  // what refuses it. The real fetch is stubbed so nothing leaves the test.
  const real = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (isGmailSend(url)) {
      posted.push(url);
      return new Response(JSON.stringify({ id: "m1", threadId: "t1" }));
    }
    return real(input, init);
  }) as typeof fetch;
  gateGmailSends();
  try {
    answers.set("/session/drop-4", "accept");
    const { client } = mailbox();
    const controller = new AbortController();
    (client as unknown as Record<string, unknown>).sendMessage = async () => {
      controller.abort(); // the drop lands during the mint
      await settle(100);
      const res = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        { method: "POST", body: "{}" },
      );
      return res.json();
    };
    const mcp = await connectFast(client);
    await assert.rejects(
      mcp.callTool(
        {
          name: "send_email",
          arguments: SEND,
          _meta: meta({ url: `${base}/session/drop-4`, ttlMs: 30_000 }),
        },
        undefined,
        { signal: controller.signal },
      ),
    );
    await settle(200);
    assert.equal(created.length, 1, "the human was asked");
    assert.deepEqual(posted, [], "the send request never left");
  } finally {
    globalThis.fetch = real;
  }
});

test("isGmailSend: only Gmail's two send requests", () => {
  const base = "https://gmail.googleapis.com/gmail/v1/users/me";
  assert.equal(isGmailSend(`${base}/messages/send`), true);
  assert.equal(isGmailSend(`${base}/drafts/send`), true);
  assert.equal(isGmailSend(`${base}/messages`), false);
  assert.equal(isGmailSend("https://example.com/messages/send"), false);
  assert.equal(isGmailSend("not a url"), false);
});

test("the reserved confirmation-header names match core's schema rule", () => {
  // Core refuses these names in config (`confirmationHeaderProblem`) and this
  // tree drops them on receipt. Two hand-kept lists, held together here.
  const names = (path: string): string[] => {
    const src = readFileSync(join(import.meta.dirname, path), "utf8");
    const body = /const RESERVED_HEADERS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(body, `no RESERVED_HEADERS in ${path}`);
    return [...body[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
  };
  assert.deepEqual(
    names("../src/confirm.ts"),
    names("../../../src/gateway/elicitation.ts"),
  );
});
