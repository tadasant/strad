import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";
import {
  connectUrl,
  degradedSurfaceNote,
  hostUnavailable,
  INGRESS_STATUS_TOKEN,
  ingressTimeoutNote,
  localTunnelNote,
  originFor,
  playgroundHref,
  readable,
} from "../src/ui/playground.ts";
import { jsonForScript } from "../src/ui/render.ts";

/**
 * `/playground/:server` — the console's human MCP client.
 *
 * Four claims, and each is a decision that could have gone the other way:
 *
 *   1. IT IS A REAL MCP SESSION. `initialize` is answered by strad's own server,
 *      `tools/list` comes back namespaced from the real adapter, and a
 *      `tools/call` reaches the real builtin and returns its real bytes. A page
 *      that rendered `config.servers[].tools` would look identical and would be
 *      a catalogue, not an inspector.
 *   2. IT IS THE CONSOLE SESSION'S OWN ENTITLEMENT, not a privileged view. The
 *      same `entitledServers` + `resolveSelection` pair `/mcp` calls, on the
 *      principal the console gate resolved — so a slug the console identity
 *      cannot have is 424 here exactly as it is there.
 *   3. IT ENFORCES THE `tools:` POLICY, on the listing AND on the action. A
 *      human console that could run a tool the read-only slug withholds would
 *      make the policy a suggestion.
 *   4. IT OPENS NO SECOND DOOR. No console credential reaches `/mcp`, the POST
 *      routes demand JSON (which a cross-site form cannot send), and the copied
 *      connect URL carries no token.
 */

const CONFIG = parseConfig(`
version: 1
gateway:
  name: strad
  env: test
  publicUrl: https://staging.strad.example.com
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: [echo, locked, walled, dead, sleepy] }
  other: { servers: [walled] }
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    options: { greeting: "from the playground" }
  # Same upstream, one tool withheld by policy. The read-only shape, in miniature.
  - slug: locked
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [admin]
    tools:
      deny: [whoami]
  # Configured, enabled, and NOT granted to the console's role.
  - slug: walled
    kind: builtin
    module: "./servers/echo.js"
    entitlements: [other]
  - slug: parked
    kind: builtin
    module: "./servers/echo.js"
    enabled: false
    entitlements: [admin]
  # Entitled, mounted, and its upstream answers nothing: port 1 refuses every
  # connection. The shape a dead slug makes.
  - slug: dead
    kind: remote-http
    url: http://127.0.0.1:1/mcp
    entitlements: [admin]
  # The same dead endpoint, behind the ONE kind for which that is not a fault: a
  # machine somebody switched off. Same port 1, so the connection is refused in
  # a millisecond and the handshake never completes.
  - slug: sleepy
    kind: local-tunnel
    url: http://127.0.0.1:1/mcp
    entitlements: [admin]
    connectTimeoutMs: 300
    tools:
      deny: [forbidden]
    recovery:
      machine: "the MacBook"
      commands: ["launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared"]
`);

const BOOTSTRAP = "bootstrap-secret-xyz";

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_TOKENS: "[]",
};

let server: Server;
let baseUrl: string;
const cookie = `strad_console=${BOOTSTRAP}`;

beforeAll(async () => {
  const registry = await Registry.build({
    config: CONFIG,
    secrets: sharedSecretProviders(new EnvSecretProvider({})),
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: {},
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server?.close());

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * What the two POST routes answer with. Declared once rather than cast per
 * assertion, so a field renamed in the route breaks compilation here.
 */
interface Payload {
  ok: boolean;
  error?: string;
  detail?: string;
  hostUnavailable?: boolean;
  tool?: string;
  elapsedMs?: number;
  session: { serverName: string; serverVersion: string; transport: string };
  tools: {
    name: string;
    bare: string;
    description: string;
    inputSchema: { required?: string[] };
  }[];
  result: {
    isError?: boolean;
    content: { type?: string; text: string }[];
  };
}

// --- pure units ------------------------------------------------------------

describe("the URL a human copies", () => {
  it("addresses one server and carries no credential", () => {
    const url = connectUrl("https://staging.strad.example.com", "echo");
    expect(url).toBe("https://staging.strad.example.com/mcp?servers=echo");
    expect(url).not.toContain("token");
    expect(url).not.toContain("Bearer");
  });

  it("tolerates a trailing slash on the base and encodes the slug", () => {
    expect(connectUrl("https://x.example.com/", "a b")).toBe(
      "https://x.example.com/mcp?servers=a%20b",
    );
  });

  it("prefers gateway.publicUrl over the request's own origin", () => {
    expect(originFor(CONFIG, "http://127.0.0.1:8080")).toBe(
      "https://staging.strad.example.com",
    );
  });

  it("falls back to the request origin when publicUrl is unset", () => {
    const noUrl = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth: { staticTokens: { enabled: true } }
`);
    expect(originFor(noUrl, "http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(originFor(noUrl, undefined)).toBe("");
  });

  it("encodes the slug in the playground href", () => {
    expect(playgroundHref("echo")).toBe("/playground/echo");
    expect(playgroundHref("a/b")).toBe("/playground/a%2Fb");
  });
});

// --- the gate --------------------------------------------------------------

describe("the playground is behind the console gate", () => {
  it("401s an anonymous GET and leaks no tool name", async () => {
    const res = await fetch(`${baseUrl}/playground/echo`, {
      redirect: "manual",
    });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Sign in required");
    // `.whoami` is a class in the shared theme, so the tool name is asserted in
    // the namespaced form only a listing can produce.
    expect(html).not.toContain("echo__");
  });

  it("401s an anonymous tools/list — the JSON route is not a softer door", async () => {
    const res = await fetch(`${baseUrl}/playground/echo/tools/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("echo__");
  });

  it("401s an anonymous tools/call", async () => {
    const res = await fetch(`${baseUrl}/playground/echo/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "echo", arguments: { text: "hi" } }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a POST that is not JSON, which is what a cross-site form sends", async () => {
    const res = await fetch(`${baseUrl}/playground/echo/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
      body: "tool=echo",
    });
    expect(res.status).toBe(415);
  });

  it("sends /playground with no server back to the index that lists them", async () => {
    const res = await fetch(`${baseUrl}/playground`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui");
  });
});

// --- a real MCP session ----------------------------------------------------

describe("tools/list is a real MCP session, not a rendering of the config", () => {
  it("answers with the handshake's own identity and the adapter's real tools", async () => {
    const res = await post("/playground/echo/tools/list", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;

    expect(body.ok).toBe(true);
    // `initialize` was answered by strad's own MCP server — the gateway name
    // from the config, not a string this route made up.
    expect(body.session.serverName).toBe("strad");
    expect(body.session.serverVersion).toBe("0.1.0");

    const names = body.tools.map((t) => t.bare).sort();
    expect(names).toEqual(["echo", "whoami"]);

    // Namespaced on the wire exactly as /mcp namespaces them, and the schema is
    // the tool's own — that is what the argument editor is built from.
    const echo = body.tools.find((t) => t.bare === "echo")!;
    expect(echo.name).toBe("echo__echo");
    expect(echo.inputSchema.required).toEqual(["text"]);
  });

  it("calls the tool for real and returns the upstream's own bytes", async () => {
    const res = await post("/playground/echo/tools/call", {
      tool: "echo__echo",
      arguments: { text: "hello from the console" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;

    expect(body.ok).toBe(true);
    expect(body.result.isError).not.toBe(true);
    expect(body.result.content[0]!.text).toBe("hello from the console");
    expect(typeof body.elapsedMs).toBe("number");
  });

  it("accepts a bare tool name and namespaces it to this server", async () => {
    const res = await post("/playground/echo/tools/call", {
      tool: "echo",
      arguments: { text: "bare" },
    });
    const body = (await res.json()) as Payload;
    expect(body.tool).toBe("echo__echo");
    expect(body.result.content[0]!.text).toBe("bare");
  });

  it("reaches the real builtin, options and all", async () => {
    const res = await post("/playground/echo/tools/call", {
      tool: "whoami",
      arguments: {},
    });
    const body = (await res.json()) as Payload;
    const reported = JSON.parse(body.result.content[0]!.text);
    expect(reported.greeting).toBe("from the playground");
  });

  it("requires a tool name", async () => {
    const res = await post("/playground/echo/tools/call", { arguments: {} });
    expect(res.status).toBe(400);
  });

  it("refuses an argument list that is not a JSON object", async () => {
    const res = await post("/playground/echo/tools/call", {
      tool: "echo",
      arguments: ["not", "an", "object"],
    });
    expect(res.status).toBe(400);
  });
});

// --- the policy, in both directions ----------------------------------------

describe("what the human sees is what the human may call", () => {
  it("hides a tool the slug's capability policy withholds", async () => {
    const res = await post("/playground/locked/tools/list", {});
    const body = (await res.json()) as Payload;
    const names = body.tools.map((t) => t.bare);
    expect(names).toEqual(["echo"]);
    expect(names).not.toContain("whoami");
  });

  it("refuses to RUN the withheld tool, not merely to list it", async () => {
    const res = await post("/playground/locked/tools/call", {
      tool: "whoami",
      arguments: {},
    });
    // 400, not 502: strad declined on purpose and nothing downstream failed.
    expect(res.status).toBe(400);
    // The SDK surfaces a JSON-RPC error as a thrown McpError; the route relays
    // it to the human who asked for it. What matters is that the call did not
    // succeed and the policy is named.
    const body = (await res.json()) as Payload;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("capability policy");
  });
});

describe("an upstream that cannot be listed is a failure, not an empty toolset", () => {
  it("says so on the page's own session, rather than rendering zero tools", async () => {
    const res = await post("/playground/dead/tools/list", {});
    // 502: the hop failed. Nothing strad decided, so it is not a 4xx.
    expect(res.status).toBe(502);
    const body = (await res.json()) as Payload;
    expect(body.ok).toBe(false);
    // The human gets the reason. An empty list would read as "this server has
    // no tools", which is the exact confusion the /mcp rule exists to end.
    expect(body.error).toBeTruthy();
  });

  it("closes the session either way — a failed listing leaks no client", async () => {
    // Ten failures in a row. A Client or Server left open per failed request
    // would surface here as a hang or a resource warning rather than ten
    // prompt 502s.
    const codes = await Promise.all(
      Array.from({ length: 10 }, () =>
        post("/playground/dead/tools/list", {}).then((r) => r.status),
      ),
    );
    expect(codes).toEqual(Array.from({ length: 10 }, () => 502));
  });
});

describe("one session per request", () => {
  it("keeps concurrent calls from reading each other's results", async () => {
    // The session is built per request and torn down with it, so ten calls in
    // flight at once are ten independent Client/Server pairs over one
    // long-lived adapter. Each must get back exactly what it sent.
    const sent = Array.from({ length: 10 }, (_, i) => `concurrent-${i}`);
    const got = await Promise.all(
      sent.map((text) =>
        post("/playground/echo/tools/call", {
          tool: "echo__echo",
          arguments: { text },
        })
          .then((r) => r.json())
          .then((b) => (b as Payload).result.content[0]!.text),
      ),
    );
    expect(got).toEqual(sent);
  });
});

describe("entitlement is the console session's own, and fails closed", () => {
  it("424s a configured server this console identity is not granted", async () => {
    const res = await fetch(`${baseUrl}/playground/walled`, {
      headers: { cookie },
    });
    expect(res.status).toBe(424);
    const html = await res.text();
    expect(html).toContain("Not available to this console identity");
  });

  it("424s the JSON route for the same server, and lists no tool", async () => {
    const res = await post("/playground/walled/tools/list", {});
    expect(res.status).toBe(424);
    const body = (await res.json()) as Payload;
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain("whoami");
  });

  it("424s a DISABLED server rather than mounting it for a human", async () => {
    const res = await fetch(`${baseUrl}/playground/parked`, {
      headers: { cookie },
    });
    expect(res.status).toBe(424);
    expect(await res.text()).toContain("disabled");
  });

  it("404s a slug that names nothing", async () => {
    const res = await fetch(`${baseUrl}/playground/nope`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});

// --- the page itself -------------------------------------------------------

describe("the playground page", () => {
  it("renders the copy field with the connect URL and no credential", async () => {
    const res = await fetch(`${baseUrl}/playground/echo`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "https://staging.strad.example.com/mcp?servers=echo",
    );
    expect(html).not.toContain(BOOTSTRAP);
    // The claim the whole feature rests on, in the page's own words.
    expect(html).toContain("No model is involved");
  });
});

// --- the icons on the console index ----------------------------------------

describe("the icons on /ui", () => {
  it("gives an entry this identity may OPEN a playground link and a copy control", async () => {
    const html = await (
      await fetch(`${baseUrl}/ui`, { headers: { cookie } })
    ).text();

    expect(html).toContain(`href="/playground/echo"`);
    expect(html).toContain(`href="/playground/locked"`);
    expect(html).toContain(
      `data-url="https://staging.strad.example.com/mcp?servers=echo"`,
    );
  });

  it("gives an ENABLED entry this identity is not entitled to the copy control only", async () => {
    // The same `walled` this file already asserts answers 424 above: enabled,
    // mounted, and not this console session's to open. The icon and the page are
    // one decision, so the offer disappears with the page — while the copy
    // control stays, because what it copies is for an agent's TOKEN to present.
    const html = await (
      await fetch(`${baseUrl}/ui`, { headers: { cookie } })
    ).text();

    expect(html).not.toContain(`href="/playground/walled"`);
    expect(html).toContain(
      `data-url="https://staging.strad.example.com/mcp?servers=walled"`,
    );
  });

  it("gives a DISABLED entry neither — both would lead somewhere that 424s", async () => {
    const html = await (
      await fetch(`${baseUrl}/ui`, { headers: { cookie } })
    ).text();

    expect(html).not.toContain(`href="/playground/parked"`);
    expect(html).not.toContain(`servers=parked`);
  });

  it("puts no credential on the clipboard", async () => {
    const html = await (
      await fetch(`${baseUrl}/ui`, { headers: { cookie } })
    ).text();
    const copied = [...html.matchAll(/data-url="([^"]+)"/g)].map((m) => m[1]!);
    expect(copied.length).toBeGreaterThan(0);
    for (const url of copied) {
      expect(url).not.toContain(BOOTSTRAP);
      expect(url).not.toContain("token");
    }
  });
});

describe("the error a human is shown", () => {
  it("prints the JSON-RPC prefix once, not once per SDK layer", () => {
    expect(
      readable(
        new Error(
          'MCP error -32600: MCP error -32600: tool "whoami" is not permitted',
        ),
      ),
    ).toBe('MCP error -32600: tool "whoami" is not permitted');
  });

  it("leaves a single-prefixed message, and a plain one, alone", () => {
    expect(readable(new Error("MCP error -32603: upstream exploded"))).toBe(
      "MCP error -32603: upstream exploded",
    );
    expect(readable("fetch failed")).toBe("fetch failed");
  });
});

// --- a local-tunnel whose machine is off -----------------------------------

/**
 * The one failure on this page that is NOT a fault.
 *
 * A `local-tunnel` is an MCP server on a machine somebody owns, and that machine
 * is off much of the time by design. The gateway carries that distinction
 * everywhere — a dedicated error class, its own error kind, an exemption from
 * the deploy gate — and the console, the one surface a human actually looks at,
 * used to flatten it to a status code: `Could not open a session: HTTP 504`.
 *
 * Three shapes, and the page words all three from strad's own vocabulary:
 *
 *   1. The listing SUCCEEDS with the degraded surface — one `troubleshoot_host`
 *      tool instead of the server's own. The commonest shape by far, and the one
 *      that would otherwise read as a healthy session with one tool in it.
 *   2. A call raises strad's own `LocalHostUnavailableError`, which the route
 *      classifies by CLASS and the page renders in strad's words.
 *   3. Nothing of strad's arrives at all — a non-JSON body from in front of the
 *      app, which is where the reported `504` came from.
 *
 * Anything that is not a `local-tunnel`, and a `local-tunnel` failing for an
 * unrelated reason, keeps exactly the wording it had.
 */
describe("an offline local-tunnel says so, instead of showing a status code", () => {
  it("flags the degraded surface on a listing that succeeded", async () => {
    const res = await post("/playground/sleepy/tools/list", {});
    // 200: the listing did not fail. That is the trap — the machine is off and
    // the slug still answers, with strad's tool in place of its own.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;

    expect(body.ok).toBe(true);
    expect(body.hostUnavailable).toBe(true);
    expect(body.tools.map((t) => t.name)).toEqual([
      "sleepy__troubleshoot_host",
    ]);
  });

  it("leaves a healthy server's listing unflagged", async () => {
    const res = await post("/playground/echo/tools/list", {});
    const body = (await res.json()) as Payload;
    expect(body.ok).toBe(true);
    expect(body.hostUnavailable).toBe(false);
  });

  it("relays strad's own words when a CALL finds the machine gone", async () => {
    const res = await post("/playground/sleepy/tools/call", {
      tool: "anything",
      arguments: {},
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Payload;

    expect(body.ok).toBe(false);
    // No flag on this path, and none is needed: the session is a real MCP
    // session over an in-memory transport, so `LocalMachineOfflineError` arrives
    // as an `McpError` with its MESSAGE and no class — and that message is
    // strad's own, naming the machine, the kind and the commands.
    expect(body.error).toContain(
      'the machine hosting "sleepy" is not reachable',
    );
    expect(body.error).toContain("Nothing is wrong with strad");
    expect(body.error).toContain("launchctl kickstart");
  });

  it("does NOT flag a local-tunnel failing for an unrelated reason", async () => {
    // A capability policy refusal on the same slug. strad declined on purpose,
    // the machine has nothing to do with it, and the page keeps "Call failed".
    const res = await post("/playground/sleepy/tools/call", {
      tool: "forbidden",
      arguments: {},
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Payload;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("capability policy");
    expect(body.error).not.toContain("local-tunnel server");
  });

  it("does NOT flag a dead upstream that is not a local-tunnel", async () => {
    // Same unreachable endpoint, a kind with no machine to be off. It stays a
    // fault, and the page stays on "Could not open a session: …".
    const res = await post("/playground/dead/tools/list", {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as Payload;
    expect(body.ok).toBe(false);
    expect(body.hostUnavailable).toBeUndefined();
  });
});

describe("the page's own kind-awareness", () => {
  it("hands a local-tunnel page its kind and both sentences", async () => {
    const html = await (
      await fetch(`${baseUrl}/playground/sleepy`, { headers: { cookie } })
    ).text();

    expect(html).toContain('var KIND = "local-tunnel"');
    // As the script's own constants — the page holds no prose of its own, so
    // the sentences it can print are the ones this module builds.
    expect(html).toContain(jsonForScript(degradedSurfaceNote("sleepy")));
    expect(html).toContain(jsonForScript(ingressTimeoutNote("sleepy")));
    // The statuses the page will word kind-awarely, pinned. A 502, a 503 and a
    // 521/522/523 mean strad itself was not reached, and pointing at somebody's
    // laptop for those points at the wrong machine.
    expect(html).toContain("var TIMED_OUT = { 504: 1, 524: 1 }");
    // The amber tone is a real rule, not a class name nothing styles.
    expect(html).toContain(".pg-status-warn{");
    expect(html).toContain(".pg-warn{");
  });

  it("gives another kind's page neither sentence", async () => {
    const html = await (
      await fetch(`${baseUrl}/playground/echo`, { headers: { cookie } })
    ).text();

    expect(html).toContain('var KIND = "builtin"');
    // Empty rather than absent: the script always declares them, and a kind with
    // no machine has nothing to say about one.
    expect(html).toContain('var UNAVAILABLE_NOTE = ""');
    expect(html).toContain('var TIMED_OUT_NOTE = ""');
    expect(html).not.toContain(localTunnelNote("echo"));
    expect(html).not.toContain("is not serving its own tools");
    // The help drawer's paragraph about the kind goes with it.
    expect(html).not.toContain("troubleshoot_host");
  });
});

describe("what counts as the degraded surface", () => {
  const sleepy = CONFIG.servers.find((s) => s.slug === "sleepy")!;
  const echo = CONFIG.servers.find((s) => s.slug === "echo")!;
  const tool = (name: string) => ({
    name,
    inputSchema: { type: "object" as const },
  });

  it("is one troubleshooting tool, on this kind, for this slug", () => {
    expect(hostUnavailable(sleepy, [tool("sleepy__troubleshoot_host")])).toBe(
      true,
    );
  });

  it("is not a server serving its own tools", () => {
    expect(hostUnavailable(sleepy, [tool("sleepy__note_add")])).toBe(false);
    expect(
      hostUnavailable(sleepy, [
        tool("sleepy__troubleshoot_host"),
        tool("sleepy__note_add"),
      ]),
    ).toBe(false);
    expect(hostUnavailable(sleepy, [])).toBe(false);
  });

  it("is not another slug's tool, and not another kind", () => {
    expect(hostUnavailable(sleepy, [tool("other__troubleshoot_host")])).toBe(
      false,
    );
    expect(hostUnavailable(echo, [tool("echo__troubleshoot_host")])).toBe(
      false,
    );
  });
});

describe("the sentences themselves", () => {
  it("says there is a machine, and makes no claim about which failure", () => {
    expect(localTunnelNote("anki")).toBe(
      '"anki" is a local-tunnel server: it serves tools only while the machine hosting it is ' +
        "awake, running the server, and holding its tunnel open.",
    );
    // The two states have opposite remedies, so the shared sentence promises
    // neither. Each composed note says which failure it is talking about.
    expect(localTunnelNote("anki")).not.toContain("expected");
  });

  it("names BOTH unavailable states, because the flag cannot tell them apart", () => {
    const note = degradedSurfaceNote("anki");
    expect(note).toContain("is not serving its own tools");
    expect(note).toContain(localTunnelNote("anki"));
    // A machine that is off is expected. A machine that REFUSED is answering,
    // and telling its owner to restart a tunnel would waste their afternoon.
    expect(note).toContain("expected while it is off");
    expect(note).toContain("refused strad's credentials");
    expect(note).toContain("call it for the diagnosis");
  });

  it("names the status it got, and where it came from", () => {
    expect(ingressTimeoutNote("anki", 504)).toBe(
      "The request timed out — HTTP 504, answered in front of strad rather than by strad " +
        `itself. ${localTunnelNote("anki")} A machine that is off is the expected state for ` +
        "this kind, not a fault in strad, and waiting on one that is not there is the " +
        "commonest reason for this — so check that machine before you check the gateway.",
    );
    // The page substitutes the status it actually received.
    expect(ingressTimeoutNote("anki")).toContain(
      `HTTP ${INGRESS_STATUS_TOKEN}`,
    );
  });
});
