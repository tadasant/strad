/* global chrome */
// The extension half of strad-hostd's browser bridge. The daemon half is
// hostd/src/browser/bridge.ts, and the two speak one JSON protocol over a
// WebSocket THIS side opens: the daemon listens on loopback and never dials in.
//
// What it does: on the daemon's request, attach chrome.debugger to a tab of
// the profile this extension is installed in, relay DevTools commands to it,
// and open, focus and close tabs. What it never does: act on its own. Every
// attach, command and tab operation is a request from a daemon that proved it
// holds the pairing token, and the daemon only makes one under a live grant.
//
// The token never leaves this worker. Any process on the machine can bind the
// daemon's port while the daemon is down and wait for this worker to dial in,
// so the daemon has to prove itself first: it answers the hello with an HMAC
// of the token over a nonce chosen here, and only then does this side prove
// itself the same way over the daemon's nonce. A listener that cannot produce
// the first proof gets hung up on and learns nothing.
//
// Why a WebSocket and not native messaging: native messaging spawns a host
// process per connection, which would be a second daemon with its own
// lifetime; the daemon already exists, already has the grant table, and a
// socket to it is the shorter path. Since Chrome 116 an open WebSocket with
// traffic on it keeps this service worker alive, and the daemon pings it for
// that reason.

const DEFAULT_DAEMON = "ws://127.0.0.1:7312/extension";
const VERSION = chrome.runtime.getManifest().version;

/** The socket the daemon admitted, or null. */
let socket = null;
/** A socket that is opening or in its handshake, so two connects do not race. */
let opening = null;
/** Set before the first await in connect(), so two connects cannot both pass the guard. */
let connecting = false;
/** For the options page. */
let status = { state: "starting", detail: "", since: Date.now() };
/** Tabs this extension has chrome.debugger attached to. */
const attached = new Set();

function setStatus(state, detail = "") {
  status = { state, detail, since: Date.now() };
}

/**
 * Managed storage first: a force-installed extension gets its endpoint and
 * token from the configuration profile that installed it, and a value set
 * there cannot be edited away on the options page. Then chrome.storage.local,
 * which the options page writes for an unpacked install.
 */
async function settings() {
  const managed = await chrome.storage.managed
    .get(["daemon", "token"])
    .catch(() => ({}));
  const local = await chrome.storage.local.get(["daemon", "token"]);
  return {
    daemon: managed.daemon || local.daemon || DEFAULT_DAEMON,
    token: managed.token || local.token || "",
    managed: Boolean(managed.token),
  };
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256(token, "strad-hostd <role> <nonce>"), hex — the same string the daemon signs. */
async function proofFor(token, role, nonce) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`strad-hostd ${role} ${nonce}`),
  );
  return hex(new Uint8Array(sig));
}

async function detachAll() {
  const ids = [...attached];
  attached.clear();
  await Promise.all(
    ids.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})),
  );
}

async function perform(msg) {
  switch (msg.op) {
    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((t) => ({
          tabId: t.id,
          title: t.title ?? "",
          url: t.url ?? "",
          active: Boolean(t.active),
          windowId: t.windowId,
        })),
      };
    }
    case "create": {
      const tab = await chrome.tabs.create({
        url: msg.url,
        active: !msg.background,
      });
      if (!msg.background)
        await chrome.windows
          .update(tab.windowId, { focused: true })
          .catch(() => {});
      return { tabId: tab.id };
    }
    case "activate": {
      const tab = await chrome.tabs.update(msg.tabId, { active: true });
      await chrome.windows
        .update(tab.windowId, { focused: true })
        .catch(() => {});
      return {};
    }
    case "close":
      await chrome.tabs.remove(msg.tabId);
      return {};
    case "attach":
      if (!attached.has(msg.tabId)) {
        await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
        attached.add(msg.tabId);
      }
      return {};
    case "detach":
      if (attached.has(msg.tabId)) {
        attached.delete(msg.tabId);
        await chrome.debugger.detach({ tabId: msg.tabId }).catch(() => {});
      }
      return {};
    case "detachAll":
      await detachAll();
      return {};
    case "send":
      if (!attached.has(msg.tabId))
        throw new Error(`not attached to tab ${msg.tabId}`);
      return await chrome.debugger.sendCommand(
        { tabId: msg.tabId },
        msg.method,
        msg.params ?? {},
      );
    default:
      throw new Error(`unknown op "${msg.op}"`);
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function onMessage(ws, raw, pairing) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "welcome") {
    // The daemon's proof, over OUR nonce. Anything else on this port is not
    // the daemon, and gets nothing: not the token, not a proof, not a tab.
    const expected = await proofFor(pairing.token, "daemon", pairing.nonce);
    if (
      typeof msg.proof !== "string" ||
      msg.proof !== expected ||
      typeof msg.nonce !== "string"
    ) {
      setStatus(
        "error",
        `something answered at ${pairing.daemon} but did not know the pairing token; not the daemon, or the token has changed`,
      );
      ws.close(4003, "daemon failed proof");
      return;
    }
    send(ws, {
      type: "auth",
      proof: await proofFor(pairing.token, "extension", msg.nonce),
    });
    pairing.daemonName =
      `${msg.daemon ?? "strad-hostd"} ${msg.version ?? ""}`.trim();
    return;
  }
  if (msg.type === "ready") {
    socket = ws;
    opening = null;
    setStatus("connected", pairing.daemonName ?? "strad-hostd");
    return;
  }
  if (msg.type === "ping") {
    send(ws, { type: "pong" });
    return;
  }
  if (msg.type !== "call" || ws !== socket) return;
  try {
    const result = await perform(msg);
    send(ws, { type: "result", id: msg.id, result: result ?? {} });
  } catch (err) {
    send(ws, {
      type: "error",
      id: msg.id,
      message: (err && err.message) || String(err),
    });
  }
}

function emit(event) {
  if (socket) send(socket, { type: "event", ...event });
}

async function connect() {
  if (connecting || opening || (socket && socket.readyState === WebSocket.OPEN))
    return;
  connecting = true;
  let daemon;
  let token;
  let ws;
  try {
    const s = await settings();
    daemon = s.daemon;
    token = s.token;
    if (!token) {
      setStatus(
        "unpaired",
        "no pairing token. Open this extension's options and paste the token from `strad-hostd extension`.",
      );
      return;
    }
    try {
      ws = new WebSocket(daemon);
    } catch (err) {
      setStatus("error", `bad daemon URL ${daemon}: ${err.message}`);
      return;
    }
    opening = ws;
  } finally {
    connecting = false;
  }
  setStatus("connecting", daemon);
  const pairing = {
    daemon,
    token,
    nonce: hex(crypto.getRandomValues(new Uint8Array(32))),
  };
  ws.onopen = () =>
    send(ws, {
      type: "hello",
      nonce: pairing.nonce,
      version: VERSION,
      extensionId: chrome.runtime.id,
    });
  ws.onmessage = (m) => void onMessage(ws, m.data, pairing);
  ws.onclose = (e) => {
    // A socket that was already replaced says nothing: the status is the
    // current socket's, and so are the attachments.
    const current = socket === ws || opening === ws;
    if (opening === ws) opening = null;
    if (socket === ws) socket = null;
    if (!current) return;
    // The daemon is gone, and its grants with it: nothing may stay attached
    // on the say-so of a process that no longer exists.
    void detachAll();
    if (status.state !== "error")
      setStatus(
        "disconnected",
        `${daemon} closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`,
      );
  };
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  emit({ event: "detached", tabId: source.tabId, reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  emit({ event: "tabRemoved", tabId });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "status") {
    void settings().then((s) =>
      reply({
        ...status,
        attached: [...attached],
        extensionId: chrome.runtime.id,
        version: VERSION,
        daemon: s.daemon,
        paired: Boolean(s.token),
        managed: s.managed,
      }),
    );
    return true;
  }
  if (msg && msg.type === "reconnect") {
    if (socket) socket.close(4000, "reconnecting");
    if (opening) opening.close(4000, "reconnecting");
    void connect();
    reply({ ok: true });
  }
  return false;
});

// Reconnect on a clock. Thirty seconds is Chrome's floor for an alarm period,
// and a daemon restart is found within it.
chrome.alarms.create("strad-hostd-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "strad-hostd-reconnect") void connect();
});
chrome.storage.onChanged.addListener(() => {
  if (socket) socket.close(4000, "settings changed");
  if (opening) opening.close(4000, "settings changed");
  void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
