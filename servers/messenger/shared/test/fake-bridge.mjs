// A stand-in for strad-messenger-bridge (the Go program in ../../bridge) that
// speaks the same loopback protocol: the stdout events, the bearer token, the
// JSON API, and a database file VACUUM INTO-style snapshots copy. Its whole
// state is one JSON document at $MESSENGER_BRIDGE_DATA_DIR/bridge.db, so a
// restore the TypeScript side performs is visible to it at boot.
//
// Test-only route: POST /_test/message appends a message, the way a message
// arriving from Meta would.
//
// Nothing here talks to Meta. Every identifier is invented.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.MESSENGER_BRIDGE_DATA_DIR;
const token = process.env.MESSENGER_BRIDGE_TOKEN;
if (!dataDir || !token) {
  console.log(JSON.stringify({ event: "fatal", error: "MESSENGER_BRIDGE_DATA_DIR and MESSENGER_BRIDGE_TOKEN are required" }));
  process.exit(1);
}
if (process.env.FAKE_FAIL_START) {
  console.log(JSON.stringify({ event: "fatal", error: "simulated" }));
  process.exit(1);
}
const dbPath = join(dataDir, "bridge.db");
const state = existsSync(dbPath)
  ? JSON.parse(readFileSync(dbPath, "utf8"))
  : { account: null, threads: {}, messages: [], seq: 0 };
const persist = () => writeFileSync(dbPath, JSON.stringify(state));
persist();

let login = null;
// _test/slow_pin: the next PIN answer "takes longer than the reply budget", the
// way the real one waits a minute; the bridge answers working until it lands.
let slowPin = false;
const emit = (event) => console.log(JSON.stringify(event));

const step = {
  creds: {
    type: "user_input",
    step_id: "fi.mau.meta.messengerlite.email_password",
    instructions: "Enter your Facebook credentials.",
    fields: [
      { id: "username", name: "Username or email address", type: "username" },
      { id: "password", name: "Password", type: "password" },
    ],
  },
  approve: { type: "display_and_wait", step_id: "afad_wait", instructions: "Approve the login on your phone.", display: { type: "nothing" } },
  pin: {
    type: "user_input",
    step_id: "fi.mau.meta.history_pin",
    instructions: "Enter your Messenger secure storage PIN.",
    fields: [{ id: "pin", name: "Secure storage PIN", type: "password", optional: true }],
    images: [{ mime_type: "image/png", base64: "iVBORw0KGgo=" }],
  },
  cookies: { type: "cookies", step_id: "fi.mau.meta.cookies", instructions: "Enter cookies.", cookies: ["xs", "c_user", "datr"], cookies_url: "https://www.facebook.com/" },
};

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const body = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });

const complete = (flow) => {
  state.account = { id: "100001", name: "Test Owner", state: "CONNECTED" };
  state.threads["7001"] ??= { id: "7001", name: "Family", type: "group", encrypted: true };
  persist();
  login = null;
  emit({ event: "login_complete" });
  return { flow, type: "complete", step_id: "fi.mau.meta.complete", instructions: "Logged in as Test Owner (100001)", account: { id: "100001", name: "Test Owner" } };
};

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://x");
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case "GET /status":
      return json(res, 200, {
        accounts: state.account ? [state.account] : null,
        login_in_progress: login
          ? login.working
            ? { flow: login.flow, type: "working", step_id: "fi.mau.meta.history_pin", working: true }
            : { flow: login.flow, ...step[login.at] }
          : null,
        cursor: state.seq,
        uptime_seconds: 1,
        device_identity: state.account
          ? [{ flow: "android", origin: "live_login", machine_id: true, since: "2026-11-18T00:00:00Z" }]
          : [],
      });
    case "GET /threads": {
      const after = Number(url.searchParams.get("updated_after_ms") ?? 0);
      const threads = Object.values(state.threads).map((t) => {
        const msgs = state.messages.filter((m) => m.thread_id === t.id);
        const last = msgs.reduce((a, m) => Math.max(a, m.timestamp_ms), 0);
        return { ...t, last_message_at_ms: last, last_cursor: 0, buffered_messages: msgs.length };
      });
      return json(res, 200, { threads: threads.filter((t) => t.last_message_at_ms >= after), has_more: false });
    }
    case "GET /messages": {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const thread = url.searchParams.get("thread_id");
      const since = Number(url.searchParams.get("since_ms") ?? 0);
      if (thread && !state.threads[thread]) return json(res, 404, { error: "no thread with that id: list them with messenger_list_threads" });
      const all = state.messages.filter((m) => m.seq > cursor && (!thread || m.thread_id === thread) && m.timestamp_ms >= since);
      const page = all.slice(0, limit);
      return json(res, 200, { messages: page, next_cursor: page.length ? page.at(-1).seq : cursor, has_more: all.length > limit });
    }
    case "GET /attachment": {
      const m = state.messages.find((x) => x.id === url.searchParams.get("id"));
      if (!m) return json(res, 404, { error: "no message with that id" });
      if (!m.attachment) return json(res, 404, { error: "that message has no attachment this bridge can fetch" });
      res.writeHead(200, { "content-type": m.attachment.mime_type, "x-file-name": encodeURIComponent(m.attachment.name) });
      return res.end(Buffer.from(m.attachment.bytes, "base64"));
    }
    case "POST /login/start": {
      const { flow } = await body(req);
      if (!["android", "ios", "cookies"].includes(flow)) return json(res, 400, { error: 'unknown flow: use "android", "ios" or "cookies"' });
      if (state.account?.state === "CONNECTED") return json(res, 409, { error: "an account is already logged in and connected: call messenger_logout first to replace it" });
      login = { flow, at: flow === "cookies" ? "cookies" : "creds" };
      return json(res, 200, { flow, ...step[login.at] });
    }
    case "POST /login/submit": {
      const { input } = await body(req);
      if (!login) return json(res, 409, { error: "no login is in progress: call messenger_login_start first" });
      const empty = !input || Object.keys(input).length === 0;
      if (login.working) {
        if (!empty) return json(res, 409, { error: "the previous answer is still with Meta and was NOT sent again: call messenger_login_submit with no input (or messenger_status) to get its result" });
        login.polls = (login.polls ?? 0) + 1;
        if (login.polls < 2) return json(res, 200, { flow: login.flow, type: "working", step_id: "fi.mau.meta.history_pin", instructions: "Meta is still processing.", working: true });
        return json(res, 200, complete(login.flow));
      }
      if (empty && step[login.at].type !== "display_and_wait") return json(res, 200, { flow: login.flow, ...step[login.at] });
      if (login.at === "pin" && state.account?.state === "BAD_CREDENTIALS") {
        login = null;
        return json(res, 422, { error: "this login has ended; call messenger_login_start to begin again: Meta has stopped this account's session (fb-checkpoint-required). The PIN was NOT sent." });
      }
      if (login.at === "pin" && slowPin && input.pin) {
        slowPin = false;
        login.working = true;
        return json(res, 200, { flow: login.flow, type: "working", step_id: "fi.mau.meta.history_pin", instructions: "Meta is still processing.", working: true });
      }
      if (login.at === "creds") {
        if (input.password !== "correct horse") {
          login = null;
          return json(res, 422, { error: "this login has ended; call messenger_login_start to begin again: Incorrect password" });
        }
        login.at = "approve";
      } else if (login.at === "approve") {
        login.at = "pin";
      } else if (login.at === "pin" || login.at === "cookies") {
        return json(res, 200, complete(login.flow));
      }
      return json(res, 200, { flow: login.flow, ...step[login.at] });
    }
    case "POST /login/cancel":
      if (login?.working) return json(res, 409, { error: "an answer is with Meta right now and cannot be called back: call messenger_login_submit with no input for its result, then cancel or start again" });
      login = null;
      return json(res, 200, { cancelled: true });
    case "POST /logout": {
      const n = state.account ? 1 : 0;
      state.account = null;
      persist();
      return json(res, 200, { logged_out: n });
    }
    case "POST /snapshot": {
      const { path } = await body(req);
      writeFileSync(path, JSON.stringify(state));
      return json(res, 200, { path });
    }
    case "POST /_test/message": {
      const m = await body(req);
      state.seq += 1;
      state.threads[m.thread_id] ??= { id: m.thread_id, name: m.thread_name ?? "", type: "dm", encrypted: false };
      state.messages.push({ seq: state.seq, id: `$e${state.seq}`, sender_id: "200", from_me: false, type: "text", ...m });
      persist();
      return json(res, 200, { seq: state.seq });
    }
    case "POST /_test/slow_pin":
      slowPin = true;
      return json(res, 200, {});
    // The account is stopped and STAYS stopped through a fresh login — the case
    // of Meta checkpointing the new login again. (A real fresh login replaces
    // the account in place and marks it CONNECTING first.)
    case "POST /_test/checkpoint":
      state.account = {
        id: "100001", name: "Test Owner", state: "BAD_CREDENTIALS", state_error: "fb-checkpoint-required",
        state_message: "Checkpoint required, please check the Facebook website to continue",
        action: "Meta has ended this login; the bridge will not reconnect it. Sign in at facebook.com in a browser and do what it asks. If that changes the password, the bridge's session is gone: call messenger_login_start again with the new password.",
      };
      persist();
      return json(res, 200, {});
    case "POST /_test/crash":
      json(res, 200, {});
      return setTimeout(() => process.exit(3), 10);
    default:
      return json(res, 404, { error: `no route ${route}` });
  }
});

server.listen(0, "127.0.0.1", () => emit({ event: "listening", addr: `127.0.0.1:${server.address().port}` }));
process.on("SIGTERM", () => {
  emit({ event: "stopped" });
  server.close(() => process.exit(0));
});
