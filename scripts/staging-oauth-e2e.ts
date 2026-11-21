/**
 * End-to-end check of strad's own /mcp authorization server, against a REAL
 * deployment — staging, by default — with a throwaway test client and nothing
 * but `echo`.
 *
 *   node --experimental-transform-types scripts/staging-oauth-e2e.ts <command>
 *
 * Commands:
 *
 *   keygen  [--key <path>]   Generate an ES256 key pair for the confidential
 *                            test client. The private JWK is written to
 *                            <path> (mode 600) and never printed; the public
 *                            key is ADDED to
 *                            docs/public/oauth-test-clients/staging-confidential.jwks.json,
 *                            which has to merge (and the docs site deploy)
 *                            before strad can verify an assertion signed
 *                            with it.
 *   check                    The part no human is needed for: both metadata
 *                            documents, what they advertise, the closed
 *                            registration endpoint, the test clients'
 *                            documents, and the two authorize-time refusals
 *                            (a slug beyond the client's ceiling, an unlisted
 *                            client). Exits 2 when the authorization server is
 *                            not running at all.
 *   run --client confidential|public [--key <path>] [--keep <state>]
 *                            `check`, then one Google sign-in by a human, then
 *                            everything after it unattended: code exchange,
 *                            /mcp through `echo` and the 424 beside it,
 *                            refresh rotation and the reuse grace, single
 *                            access-token revocation, and a terminal step —
 *                            an explicit grant revocation (confidential) or a
 *                            refresh-token replay that revokes the grant
 *                            (public). `--keep` stops before the terminal step
 *                            and writes the live tokens to <state>, so a
 *                            redeploy can sit in between.
 *   resume --state <path> [--key <path>]
 *                            Continue a `--keep` run: the grant must still be
 *                            live after the restart, and then the terminal step.
 *
 * Options: --base <origin> (default https://staging.strad.tadasant.com),
 * --docs <origin> (default https://docs.strad.tadasant.com), --port <n> for the
 * loopback callback (53682 or 53683, the two the documents list).
 *
 * THE ONE HUMAN STEP is the Google sign-in: strad's authorization server
 * federates to Google, and a Workspace account is the only thing that can say
 * yes. The script prints the authorize URL and takes the code from whichever
 * arrives first — the loopback callback (when the browser runs on this
 * machine) or the address bar of the page the browser lands on, pasted here
 * (when it does not: the redirect to 127.0.0.1 fails there, and its URL still
 * carries the code).
 *
 * The private key never leaves this machine and is never printed. Tokens are
 * printed only as their first eight characters. See
 * docs/operate/staging-oauth-e2e.md for the procedure and what each step proves.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JWKS_FILE = resolve(
  REPO,
  "docs/public/oauth-test-clients/staging-confidential.jwks.json",
);
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

type ClientKind = "confidential" | "public";

interface Args {
  command: string;
  base: string;
  docs: string;
  client: ClientKind;
  key: string;
  keep?: string;
  state?: string;
  port: number;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i] ?? "";
    if (!name.startsWith("--")) throw new Error(`unexpected argument ${name}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} needs a value`);
    }
    flags.set(name.slice(2), value);
    i++;
  }
  const client = flags.get("client") ?? "confidential";
  if (client !== "confidential" && client !== "public") {
    throw new Error("--client is confidential or public");
  }
  const home = process.env.HOME ?? ".";
  return {
    command,
    base: (flags.get("base") ?? "https://staging.strad.tadasant.com").replace(
      /\/+$/,
      "",
    ),
    docs: (flags.get("docs") ?? "https://docs.strad.tadasant.com").replace(
      /\/+$/,
      "",
    ),
    client,
    key:
      flags.get("key") ??
      `${home}/.config/strad-oauth-test/staging-confidential.private.jwk.json`,
    keep: flags.get("keep"),
    state: flags.get("state"),
    port: Number(flags.get("port") ?? 53682),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failures = 0;
/** Set when the authorization server is not running at all: exit 2, not 1. */
let notRunning = false;

function pass(what: string): void {
  console.log(`  ok    ${what}`);
}

function fail(what: string, detail: string): void {
  failures++;
  console.log(`  FAIL  ${what}: ${detail}`);
}

function expect(cond: boolean, what: string, detail: string): boolean {
  if (cond) pass(what);
  else fail(what, detail);
  return cond;
}

function stage(title: string): void {
  console.log(`\n== ${title}`);
}

/** The first eight characters: enough to tell two tokens apart, no more. */
function short(token: string | undefined): string {
  return token ? `${token.slice(0, 8)}…` : "(none)";
}

// ---------------------------------------------------------------------------
// Keys and assertions
// ---------------------------------------------------------------------------

interface SigningKey {
  kid: string;
  key: KeyObject;
}

function keygen(path: string): void {
  if (existsSync(path)) {
    throw new Error(
      `${path} exists; refusing to overwrite a key. Move it aside first.`,
    );
  }
  const kid = `staging-test-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const priv = {
    ...(pair.privateKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid,
    alg: "ES256",
  };
  const pub = {
    ...(pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid,
    use: "sig",
    alg: "ES256",
  };
  writeFileSync(path, JSON.stringify(priv, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  const jwks = existsSync(JWKS_FILE)
    ? (JSON.parse(readFileSync(JWKS_FILE, "utf8")) as { keys: unknown[] })
    : { keys: [] };
  jwks.keys.push(pub);
  if (jwks.keys.length > 16) {
    throw new Error("strad reads at most 16 keys per set; drop an old one");
  }
  writeFileSync(JWKS_FILE, JSON.stringify(jwks, null, 2) + "\n");
  console.log(`private key: ${path} (mode 600, kid ${kid})`);
  console.log(`public key added to ${JWKS_FILE}`);
  console.log(
    "Merge that file and wait for the docs site to deploy before `run`.",
  );
}

function loadKey(path: string): SigningKey {
  if (!existsSync(path)) {
    throw new Error(
      `no private key at ${path}. Run \`keygen --key ${path}\`, merge the JWKS ` +
        "change, and wait for the docs deploy.",
    );
  }
  const jwk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const kid = String(jwk.kid ?? "");
  return { kid, key: createPrivateKey({ key: jwk as never, format: "jwk" }) };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An RFC 7523 client assertion: ES256, 60 seconds, a fresh jti. */
function assertion(k: SigningKey, clientId: string, aud: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "ES256", kid: k.kid, typ: "JWT" });
  const body = b64({
    iss: clientId,
    sub: clientId,
    aud,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
  });
  const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), {
    key: k.key,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${sig.toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Ctx {
  args: Args;
  kind: ClientKind;
  clientId: string;
  redirectUri: string;
  resource: string;
  key: SigningKey | null;
}

function docUrl(docs: string, kind: ClientKind | "unlisted"): string {
  return `${docs}/oauth-test-clients/staging-${kind}.json`;
}

async function getJson(
  url: string,
): Promise<{ status: number; type: string; body: unknown }> {
  const res = await fetch(url, { redirect: "manual" });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    body,
  };
}

/** POST a form to the token or revocation endpoint, with or without an assertion. */
async function postForm(
  ctx: Ctx,
  path: string,
  fields: Record<string, string>,
  withAssertion = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new URLSearchParams({ client_id: ctx.clientId, ...fields });
  if (withAssertion && ctx.key) {
    form.set("client_assertion_type", ASSERTION_TYPE);
    form.set(
      "client_assertion",
      assertion(ctx.key, ctx.clientId, ctx.args.base),
    );
  }
  const res = await fetch(`${ctx.args.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

/** List and call echo's tools through /mcp with an OAuth access token. */
async function mcpEcho(
  base: string,
  token: string,
  servers = "echo",
): Promise<
  { ok: true; tools: string[]; echoed: string } | { ok: false; status: string }
> {
  const client = new Client({ name: "strad-staging-oauth-e2e", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${base}/mcp?servers=${servers}`),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } },
      ),
    );
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const text = `oauth-e2e-${randomBytes(4).toString("hex")}`;
    const result = await client.callTool({
      name: "echo__echo",
      arguments: { text },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const echoed = content.map((c) => c.text ?? "").join("");
    return { ok: true, tools, echoed: echoed.includes(text) ? text : echoed };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** The bare HTTP status /mcp answers for this token and selection. */
async function mcpStatus(
  base: string,
  token: string,
  servers: string,
): Promise<number> {
  const res = await fetch(`${base}/mcp?servers=${servers}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "strad-staging-oauth-e2e", version: "1" },
      },
    }),
  });
  await res.text();
  return res.status;
}

// ---------------------------------------------------------------------------
// check — everything no human is needed for
// ---------------------------------------------------------------------------

function authorizeUrl(
  ctx: Ctx,
  params: { scope: string; state: string; challenge: string },
  clientId = ctx.clientId,
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: ctx.redirectUri,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
    scope: params.scope,
    resource: ctx.resource,
  });
  return `${ctx.args.base}/oauth/authorize?${q.toString()}`;
}

async function check(ctx: Ctx): Promise<boolean> {
  const { base, docs } = ctx.args;
  stage(`metadata at ${base}`);
  const prm = await getJson(`${base}/.well-known/oauth-protected-resource/mcp`);
  const asm = await getJson(`${base}/.well-known/oauth-authorization-server`);
  if (asm.status === 404) {
    notRunning = true;
    fail(
      "authorization server is running",
      "/.well-known/oauth-authorization-server answers 404. Either " +
        "auth.mcpOAuth.enabled is false, or GOOGLE_CLIENT_ID / " +
        "GOOGLE_CLIENT_SECRET are not in the store (boot logs say which).",
    );
    return false;
  }
  if (asm.status === 503) {
    notRunning = true;
    fail(
      "the deployment is up",
      "503. Staging sleeps nightly (teardown-staging.yml); dispatch " +
        "deploy-staging.yml to wake it on current main.",
    );
    return false;
  }
  if (
    !expect(
      asm.status === 200,
      "authorization-server metadata",
      `status ${asm.status}`,
    )
  ) {
    return false;
  }
  const meta = asm.body as Record<string, unknown>;
  const list = (k: string): string[] =>
    Array.isArray(meta[k]) ? (meta[k] as string[]) : [];
  expect(
    prm.status === 200 &&
      Array.isArray(
        (prm.body as Record<string, unknown>)?.authorization_servers,
      ),
    "protected-resource metadata names an authorization server",
    `status ${prm.status}`,
  );
  expect(
    meta.issuer === base,
    "issuer is the deployment origin",
    String(meta.issuer),
  );
  expect(
    list("token_endpoint_auth_methods_supported").includes("private_key_jwt"),
    "private_key_jwt is advertised",
    JSON.stringify(list("token_endpoint_auth_methods_supported")),
  );
  expect(
    list("token_endpoint_auth_signing_alg_values_supported").includes("ES256"),
    "ES256 is an accepted assertion algorithm",
    JSON.stringify(list("token_endpoint_auth_signing_alg_values_supported")),
  );
  expect(
    meta.client_id_metadata_document_supported === true,
    "client id metadata documents are supported",
    String(meta.client_id_metadata_document_supported),
  );
  expect(
    meta.registration_endpoint === undefined,
    "no registration endpoint is advertised (dynamicRegistration: false)",
    String(meta.registration_endpoint),
  );
  const scopes = list("scopes_supported");
  expect(
    scopes.includes("slug:echo") &&
      scopes.filter((s) => s.startsWith("slug:")).length === 1,
    "scopes_supported advertises slug:echo and no other slug",
    JSON.stringify(scopes),
  );
  expect(
    typeof meta.revocation_endpoint === "string",
    "a revocation endpoint is advertised",
    String(meta.revocation_endpoint),
  );
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [ctx.redirectUri] }),
  });
  await reg.text();
  expect(
    reg.status === 404,
    "POST /oauth/register answers 404",
    `status ${reg.status}`,
  );

  stage(`test client documents at ${docs}`);
  for (const kind of ["confidential", "public", "unlisted"] as const) {
    const url = docUrl(docs, kind);
    const doc = await getJson(url);
    expect(
      doc.status === 200 &&
        doc.type.split(";")[0]?.trim() === "application/json" &&
        (doc.body as Record<string, unknown>)?.client_id === url,
      `${kind} document is served as JSON and names itself`,
      `status ${doc.status}, content-type ${doc.type}`,
    );
  }
  if (ctx.kind === "confidential") {
    const jwks = await getJson(
      `${docs}/oauth-test-clients/staging-confidential.jwks.json`,
    );
    const kids = (
      ((jwks.body as { keys?: Array<{ kid?: string }> })?.keys ?? []) as Array<{
        kid?: string;
      }>
    ).map((k) => k.kid);
    expect(
      ctx.key !== null && kids.includes(ctx.key.kid),
      "the published JWKS carries this machine's key",
      `local kid ${ctx.key?.kid ?? "(none)"}, published ${JSON.stringify(kids)}. ` +
        "Run keygen and merge the JWKS before `run`.",
    );
  }

  stage("authorize-time refusals (no sign-in needed)");
  const pkce = { state: randomUUID(), challenge: "x".repeat(43) };
  const beyond = await fetch(
    authorizeUrl(ctx, { ...pkce, scope: "slug:echo slug:secrets" }),
    { redirect: "manual" },
  );
  await beyond.text();
  const loc = beyond.headers.get("location") ?? "";
  expect(
    beyond.status === 302 && loc.includes("error=invalid_scope"),
    "a slug beyond the client's ceiling is invalid_scope",
    `status ${beyond.status}, location ${loc.slice(0, 120)}`,
  );
  const unlisted = await fetch(
    authorizeUrl(
      ctx,
      { ...pkce, scope: "slug:echo" },
      docUrl(docs, "unlisted"),
    ),
    { redirect: "manual" },
  );
  await unlisted.text();
  expect(
    unlisted.status === 403,
    "an unlisted client is refused (allowUnlistedClients: false)",
    `status ${unlisted.status}`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// The sign-in
// ---------------------------------------------------------------------------

async function waitForCode(
  port: number,
  expectedState: string,
): Promise<string> {
  return new Promise((resolveCode, reject) => {
    let done = false;
    const finish = (raw: string): boolean => {
      let url: URL;
      try {
        url = new URL(raw.trim(), `http://127.0.0.1:${port}`);
      } catch {
        return false;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (!error && !code) return false;
      if (done) return true;
      done = true;
      server.close();
      rl.close();
      if (error) {
        reject(
          new Error(
            `${error}: ${url.searchParams.get("error_description") ?? ""}`,
          ),
        );
      } else if (url.searchParams.get("state") !== expectedState) {
        reject(new Error("state mismatch on the callback"));
      } else {
        resolveCode(code ?? "");
      }
      return true;
    };
    const server = createServer((req, res) => {
      const ok = finish(req.url ?? "");
      res.writeHead(ok ? 200 : 404, { "content-type": "text/plain" });
      res.end(ok ? "Received. You can close this tab.\n" : "not found\n");
    });
    server.on("error", () => {
      console.log(`  (port ${port} is busy; paste the redirected URL instead)`);
    });
    server.listen(port, "127.0.0.1");
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (!finish(line))
        console.log(
          "  that is not the redirected URL; paste the whole address",
        );
    });
  });
}

// ---------------------------------------------------------------------------
// run / resume
// ---------------------------------------------------------------------------

interface Live {
  kind: ClientKind;
  access: string;
  refresh: string;
  previousRefresh: string;
  rotatedAt: number;
}

async function refresh(ctx: Ctx, token: string, withAssertion = true) {
  return postForm(
    ctx,
    "/oauth/token",
    {
      grant_type: "refresh_token",
      refresh_token: token,
      resource: ctx.resource,
    },
    withAssertion,
  );
}

async function run(ctx: Ctx): Promise<void> {
  if (!(await check(ctx))) return;

  stage(`sign-in as the ${ctx.kind} test client`);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();
  const url = authorizeUrl(ctx, { scope: "slug:echo", state, challenge });
  console.log(
    "\nOpen this URL, sign in with a tadasant.com Google account, and click Allow:\n\n" +
      `  ${url}\n\n` +
      `If the browser is on another machine, the last page fails to load; paste\n` +
      `its full address here and press enter.\n`,
  );
  const code = await waitForCode(ctx.args.port, state);
  pass("received an authorization code");

  stage("code exchange");
  const exchange = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: ctx.redirectUri,
    resource: ctx.resource,
  };
  if (ctx.kind === "confidential") {
    const bare = await postForm(ctx, "/oauth/token", exchange, false);
    expect(
      bare.status === 401 && bare.body.error === "invalid_client",
      "the code is refused without a client assertion",
      `status ${bare.status} ${String(bare.body.error)}`,
    );
  }
  const tok = await postForm(ctx, "/oauth/token", exchange);
  if (
    !expect(
      tok.status === 200 && typeof tok.body.access_token === "string",
      "the code exchanges for tokens",
      `status ${tok.status} ${String(tok.body.error)} ${String(tok.body.error_description ?? "")}`,
    )
  ) {
    return;
  }
  const at1 = String(tok.body.access_token);
  const rt1 = String(tok.body.refresh_token ?? "");
  expect(rt1 !== "", "a refresh token is issued", "none");
  expect(
    tok.body.scope === "slug:echo",
    "the granted scope is slug:echo",
    String(tok.body.scope),
  );
  expect(
    Number(tok.body.expires_in) <= 300,
    "the access token lives at most the client's 300 s",
    String(tok.body.expires_in),
  );
  console.log(`  (access ${short(at1)}, refresh ${short(rt1)})`);

  stage("/mcp with the access token");
  const listed = await mcpEcho(ctx.args.base, at1);
  expect(
    listed.ok &&
      listed.tools.includes("echo__echo") &&
      listed.echoed.startsWith("oauth-e2e-"),
    "?servers=echo lists echo and echo__echo round-trips",
    listed.ok ? JSON.stringify(listed.tools) : listed.status,
  );
  const other = await mcpStatus(ctx.args.base, at1, "secrets");
  expect(other === 424, "?servers=secrets is 424", `status ${other}`);

  stage("refresh rotation");
  const r2 = await refresh(ctx, rt1);
  const rt2 = String(r2.body.refresh_token ?? "");
  const at2 = String(r2.body.access_token ?? "");
  expect(
    r2.status === 200 && at2 !== "",
    "the refresh succeeds",
    `status ${r2.status} ${String(r2.body.error)}`,
  );
  expect(
    rt2 !== "" && rt2 !== rt1,
    "the refresh token rotates",
    `${short(rt1)} -> ${short(rt2)}`,
  );
  const rotatedAt = Date.now();
  if (ctx.kind === "confidential") {
    const bare = await refresh(ctx, rt2, false);
    expect(
      bare.status === 401 && bare.body.error === "invalid_client",
      "a refresh without a client assertion is refused",
      `status ${bare.status} ${String(bare.body.error)}`,
    );
  }
  const grace = await refresh(ctx, rt1);
  expect(
    grace.status === 200,
    "the previous refresh token inside the reuse grace returns the current generation",
    `status ${grace.status} ${String(grace.body.error)}`,
  );
  const current = String(grace.body.refresh_token ?? rt2);
  const at3 = String(grace.body.access_token ?? at2);

  stage("single access-token revocation");
  const rv = await postForm(ctx, "/oauth/revoke", {
    token: at1,
    token_type_hint: "access_token",
  });
  expect(
    rv.status === 200,
    "revoking the first access token succeeds",
    `status ${rv.status}`,
  );
  const dead = await mcpStatus(ctx.args.base, at1, "echo");
  expect(dead === 401, "the revoked access token gets 401", `status ${dead}`);
  const alive = await mcpEcho(ctx.args.base, at3);
  expect(
    alive.ok,
    "a sibling access token of the same grant still works",
    alive.ok ? "" : alive.status,
  );

  const live: Live = {
    kind: ctx.kind,
    access: at3,
    refresh: current,
    previousRefresh: rt1,
    rotatedAt,
  };
  if (ctx.args.keep) {
    writeFileSync(ctx.args.keep, JSON.stringify(live) + "\n", { mode: 0o600 });
    stage(`kept the live grant in ${ctx.args.keep}`);
    console.log(
      "  Redeploy staging (or restart core), then run:\n" +
        `  node --experimental-transform-types scripts/staging-oauth-e2e.ts resume --state ${ctx.args.keep}`,
    );
    return;
  }
  await terminal(ctx, live);
}

async function terminal(ctx: Ctx, live: Live): Promise<void> {
  if (ctx.kind === "confidential") {
    stage("grant revocation through /oauth/revoke");
    const bare = await postForm(
      ctx,
      "/oauth/revoke",
      { token: live.refresh },
      false,
    );
    expect(
      bare.status === 401,
      "a revocation without a client assertion is refused",
      `status ${bare.status}`,
    );
    const rv = await postForm(ctx, "/oauth/revoke", {
      token: live.refresh,
      token_type_hint: "refresh_token",
    });
    expect(
      rv.status === 200,
      "revoking the refresh token succeeds",
      `status ${rv.status}`,
    );
  } else {
    stage("refresh-token replay");
    const wait = Math.max(0, live.rotatedAt + 31_000 - Date.now());
    if (wait > 0) {
      console.log(
        `  waiting ${Math.ceil(wait / 1000)} s for the 30 s reuse grace to pass`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
    const replay = await refresh(ctx, live.previousRefresh);
    expect(
      replay.status === 400 && replay.body.error === "invalid_grant",
      "a spent refresh token after the grace is invalid_grant",
      `status ${replay.status} ${String(replay.body.error)}`,
    );
  }
  const at = await mcpStatus(ctx.args.base, live.access, "echo");
  expect(at === 401, "the grant's access token now gets 401", `status ${at}`);
  const rt = await refresh(ctx, live.refresh);
  expect(
    rt.status === 400 && rt.body.error === "invalid_grant",
    "the grant's current refresh token is now invalid_grant",
    `status ${rt.status} ${String(rt.body.error)}`,
  );
}

async function resume(ctx: Ctx): Promise<void> {
  const live = JSON.parse(readFileSync(ctx.args.state ?? "", "utf8")) as Live;
  stage("the kept grant after a restart");
  const ok = await mcpEcho(ctx.args.base, live.access);
  // An access token may have expired across a slow deploy; the refresh is the
  // real question, since it can only succeed from the durable record.
  if (ok.ok) pass("the kept access token still works");
  const r = await refresh(ctx, live.refresh);
  expect(
    r.status === 200,
    "the kept refresh token rotates after the restart (the record is durable)",
    `status ${r.status} ${String(r.body.error)}`,
  );
  await terminal(ctx, {
    ...live,
    access: String(r.body.access_token ?? live.access),
    previousRefresh: live.refresh,
    refresh: String(r.body.refresh_token ?? live.refresh),
    rotatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "keygen") {
    keygen(args.key);
    return;
  }
  if (!["check", "run", "resume"].includes(args.command)) {
    console.log(
      "usage: staging-oauth-e2e.ts keygen|check|run|resume — see the header of this file",
    );
    process.exitCode = 64;
    return;
  }
  let kind = args.client;
  if (args.command === "resume") {
    kind = (JSON.parse(readFileSync(args.state ?? "", "utf8")) as Live).kind;
  }
  const ctx: Ctx = {
    args,
    kind,
    clientId: docUrl(args.docs, kind),
    redirectUri: `http://127.0.0.1:${args.port}/callback`,
    resource: `${args.base}/mcp`,
    key:
      kind === "confidential" && existsSync(args.key)
        ? loadKey(args.key)
        : null,
  };
  if (kind === "confidential" && args.command !== "check" && ctx.key === null) {
    loadKey(args.key); // throws with the instruction
  }
  if (args.command === "check") await check(ctx);
  else if (args.command === "run") await run(ctx);
  else await resume(ctx);
  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exitCode = notRunning ? 2 : failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
