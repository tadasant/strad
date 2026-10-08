import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";

import {
  GcsBlobStore,
  GcsHttpError,
  isTransientTransportError,
  PreconditionFailed,
  StateStore,
  TransientStoreError,
} from "../src/index.js";

/**
 * `GcsBlobStore` — Node's own `fetch`, nothing in between — against a local
 * stand-in for the two things it talks to: Google's OAuth 2.0 token endpoint
 * and the slice of the GCS JSON API it calls. `MemoryBlobStore` is faithful to
 * what `BlobStore` promises; this is what checks that the real client keeps
 * those promises on the wire — in particular that a READ reports the
 * generation a later conditional write needs, and that the JWT it signs is one
 * Google would accept.
 *
 * The fake answers as Google documents: a token POST that verifies the
 * assertion's RS256 signature and claims, a metadata GET, an `alt=media` GET
 * honouring `generation`, a multipart upload honouring `ifGenerationMatch` with
 * 412, DELETE, and a paged prefix list. Object calls without the bearer token
 * the fake issued are 401.
 */

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const CLIENT_EMAIL = "bridge@example-project.iam.gserviceaccount.com";

interface Obj {
  data: Buffer;
  generation: number;
  cacheControl?: string;
}
const objects = new Map<string, Obj>();
const seen: string[] = [];
const issued = new Set<string>();
let counter = 1_000;
let tokenFetches = 0;

/**
 * Faults for the next N requests of a kind. `chunked`: a chunked response whose
 * socket closes before the terminating chunk. `short`: a response that declares
 * a `content-length` and closes before sending it — the shape node-fetch 2
 * HUNG on. `hang`: no answer at all. `status`: an answer with that HTTP status.
 */
type Fault =
  | { kind: "chunked" }
  | { kind: "short" }
  | { kind: "hang" }
  | { kind: "status"; code: number; body?: unknown };
let tokenFaults: Fault[] = [];
let objectFaults: Fault[] = [];
const PAGE = 2;

let server: Server;
let endpoint = "";

function verifyAssertion(assertion: string): string | null {
  const [h, p, sig] = assertion.split(".");
  if (!h || !p || !sig) return "malformed";
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (header.alg !== "RS256") return "alg";
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, sig, "base64url");
  if (!ok) return "signature";
  if (claims.iss !== CLIENT_EMAIL) return "iss";
  if (claims.aud !== `${endpoint}/token`) return "aud";
  if (!/devstorage\.read_write/.test(claims.scope)) return "scope";
  const now = Date.now() / 1000;
  if (!(claims.iat <= now + 5 && claims.exp > now && claims.exp - claims.iat <= 3600)) return "times";
  return null;
}

function applyFault(res: import("node:http").ServerResponse, fault: Fault): void {
  if (fault.kind === "status") {
    res.writeHead(fault.code, { "content-type": "application/json" });
    res.end(JSON.stringify(fault.body ?? { error: { code: fault.code, message: "fault" } }));
    return;
  }
  if (fault.kind === "hang") return;
  if (fault.kind === "chunked") {
    res.writeHead(200, { "content-type": "application/json" });
  } else {
    res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
  }
  // Destroyed only once the partial body is flushed, so the client always sees
  // a truncated body rather than, under load, no body at all.
  res.write('{"access_token":"tr', () => res.socket?.destroy());
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === "/token") {
        tokenFetches++;
        const fault = tokenFaults.shift();
        if (fault) return applyFault(res, fault);
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
          return json(400, { error: "unsupported_grant_type" });
        }
        const problem = verifyAssertion(form.get("assertion") ?? "");
        if (problem) return json(400, { error: "invalid_grant", error_description: `bad ${problem}` });
        const token = `tok-${randomBytes(6).toString("hex")}`;
        issued.add(token);
        return json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
      }

      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!issued.has(bearer)) return json(401, { error: { code: 401, message: "Invalid Credentials" } });
      const fault = objectFaults.shift();
      if (fault) return applyFault(res, fault);
      const notFound = () => json(404, { error: { code: 404, message: "No such object" } });

      const upload = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/);
      if (req.method === "POST" && upload) {
        assert.equal(url.searchParams.get("uploadType"), "multipart");
        const body = Buffer.concat(chunks);
        const boundary = String(req.headers["content-type"] ?? "").match(/boundary=([^;]+)/)?.[1];
        assert.ok(boundary, "a multipart upload names its boundary");
        const parts = body.toString("latin1").split(`--${boundary}`).slice(1, -1);
        const part = (p: string) => p.slice(p.indexOf("\r\n\r\n") + 4, -2);
        const metadata = JSON.parse(part(parts[0]!)) as { name: string; cacheControl?: string };
        const data = Buffer.from(part(parts[1]!), "latin1");
        const match = url.searchParams.get("ifGenerationMatch");
        const current = objects.get(metadata.name);
        if (match !== null && String(current?.generation ?? 0) !== match) {
          return json(412, { error: { code: 412, message: "conditionNotMet" } });
        }
        const obj = { data, generation: ++counter, cacheControl: metadata.cacheControl };
        objects.set(metadata.name, obj);
        return json(200, { name: metadata.name, generation: String(obj.generation) });
      }

      const one = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
      if (one) {
        const name = decodeURIComponent(one[2]!);
        const obj = objects.get(name);
        if (req.method === "DELETE") {
          if (!obj) return notFound();
          objects.delete(name);
          res.writeHead(204);
          return res.end();
        }
        const wanted = url.searchParams.get("generation");
        if (!obj || (wanted !== null && String(obj.generation) !== wanted)) return notFound();
        if (url.searchParams.get("alt") === "media") {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return res.end(obj.data);
        }
        return json(200, { generation: String(obj.generation) });
      }

      const list = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o$/);
      if (req.method === "GET" && list) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const names = [...objects.keys()].filter((n) => n.startsWith(prefix)).sort();
        const start = Number(url.searchParams.get("pageToken") ?? 0);
        const items = names.slice(start, start + PAGE).map((name) => ({ name }));
        const next = start + PAGE < names.length ? String(start + PAGE) : undefined;
        return json(200, { ...(items.length ? { items } : {}), ...(next ? { nextPageToken: next } : {}) });
      }
      json(501, { error: { code: 501, message: `fake GCS does not serve ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  tokenFaults = [];
  objectFaults = [];
  vi.restoreAllMocks();
});

const FAST = { attempts: 4, baseDelayMs: 1, deadlineMs: 10_000, requestTimeoutMs: 5_000 };

const store = (extra: Partial<ConstructorParameters<typeof GcsBlobStore>[0]> = {}) =>
  new GcsBlobStore({
    bucket: "b",
    clientEmail: CLIENT_EMAIL,
    privateKey,
    apiEndpoint: endpoint,
    tokenUrl: `${endpoint}/token`,
    retry: FAST,
    ...extra,
  });

test("a read reports the generation a conditional write needs", async () => {
  const gcs = store();
  assert.equal(await gcs.read("wa/none.bin"), null);

  const g1 = await gcs.write("wa/a.bin", Buffer.from("one"), null);
  assert.match(g1, /^\d+$/);
  await assert.rejects(gcs.write("wa/a.bin", Buffer.from("again"), null), PreconditionFailed);

  // A FRESH client, as after a restart: nothing cached from the write.
  const reread = await store().read("wa/a.bin");
  assert.equal(reread?.data.toString(), "one");
  assert.equal(reread?.generation, g1);

  const g2 = await store().write("wa/a.bin", Buffer.from("two"), reread!.generation);
  assert.notEqual(g2, g1);
  await assert.rejects(store().write("wa/a.bin", Buffer.from("stale"), g1), PreconditionFailed);
  assert.equal((await gcs.read("wa/a.bin"))?.data.toString(), "two");
  assert.equal(objects.get("wa/a.bin")?.cacheControl, "no-store");

  assert.deepEqual(await gcs.list("wa/"), ["wa/a.bin"]);
  await gcs.delete("wa/a.bin");
  await gcs.delete("wa/a.bin"); // idempotent
  assert.equal(await gcs.read("wa/a.bin"), null);
  assert.ok(
    seen.some((line) => /alt=media/.test(line) && /generation=\d+/.test(line)),
    "the download is pinned to the generation the metadata reported",
  );
});

test("binary data and object names with slashes and spaces round-trip", async () => {
  const gcs = store();
  const data = randomBytes(64 * 1024);
  await gcs.write("wa1/a dir/b+c.bin", data);
  assert.deepEqual((await gcs.read("wa1/a dir/b+c.bin"))?.data, data);
  assert.deepEqual(await gcs.list("wa1/"), ["wa1/a dir/b+c.bin"]);
});

test("a list follows nextPageToken to the end", async () => {
  const gcs = store();
  for (const n of ["a", "b", "c", "d", "e"]) await gcs.write(`wa8/${n}`, Buffer.from(n));
  assert.deepEqual(await gcs.list("wa8/"), ["wa8/a", "wa8/b", "wa8/c", "wa8/d", "wa8/e"]);
  assert.deepEqual(await gcs.list("wa8/none"), []);
});

test("auth survives a restart and keeps being written", async () => {
  // The exact failure: pair (first write), restart, then every write 412s.
  const key = randomBytes(32);
  const first = new StateStore(store(), key, "wa2");
  await first.claimLease();
  await first.readAuth();
  await first.writeAuth('{"v":1}');

  const second = new StateStore(store(), key, "wa2");
  await second.claimLease();
  assert.equal(await second.readAuth(), '{"v":1}');
  await second.writeAuth('{"v":2}');
  await second.writeAuth('{"v":3}');
  const third = new StateStore(store(), key, "wa2");
  assert.equal(await third.readAuth(), '{"v":3}');
});

test("the token: a signed JWT the endpoint verifies, fetched once and reused", async () => {
  const before = tokenFetches;
  const gcs = store();
  await Promise.all([gcs.read("wa9/x"), gcs.read("wa9/y"), gcs.list("wa9/")]);
  await gcs.write("wa9/x", Buffer.from("x"));
  assert.equal(tokenFetches - before, 1, "concurrent and later calls share one token");
});

test("a token request cut off once — production's failure — is retried, and the lease write succeeds", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const before = tokenFetches;
  tokenFaults = [{ kind: "chunked" }];
  const g = await store().write("wa3/lease.json", Buffer.from("one"));
  assert.match(g, /^\d+$/);
  assert.equal(tokenFetches - before, 2, "one cut off, then one that worked");
  const line = warn.mock.calls.map((c) => String(c[0])).find((l) => /try 1\/4/.test(l));
  assert.ok(line, "the retry is logged");
  // The cause chain, with its code: the diagnosis prod's log lacked.
  assert.match(line!, /UND_ERR_SOCKET|terminated/);
  assert.doesNotMatch(line!, /BEGIN|PRIVATE KEY/);
});

test("an object read, write, list and delete cut off mid-body once are retried", async () => {
  const gcs = store();
  for (const kind of ["chunked", "short"] as const) {
    objectFaults = [{ kind }];
    await gcs.write("wa4/a.bin", Buffer.from(kind), objects.has("wa4/a.bin") ? String(objects.get("wa4/a.bin")!.generation) : null);
    assert.equal(objectFaults.length, 0, `the write's first try was cut off (${kind})`);
    objectFaults = [{ kind }];
    assert.equal((await gcs.read("wa4/a.bin"))?.data.toString(), kind);
    assert.equal(objectFaults.length, 0, `the read's first try was cut off (${kind})`);
    objectFaults = [{ kind }];
    assert.deepEqual(await gcs.list("wa4/"), ["wa4/a.bin"]);
    assert.equal(objectFaults.length, 0, `the list's first try was cut off (${kind})`);
  }
  objectFaults = [{ kind: "chunked" }];
  await gcs.delete("wa4/a.bin");
  assert.equal(objectFaults.length, 0, "the delete's first try was cut off");
  assert.equal(await gcs.read("wa4/a.bin"), null);
});

test("a request that never answers is cut off by the per-request timeout and retried", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const gcs = store({ retry: { ...FAST, requestTimeoutMs: 200 } });
  await gcs.write("wa13/a", Buffer.from("a"));
  objectFaults = [{ kind: "hang" }];
  const started = Date.now();
  assert.equal((await gcs.read("wa13/a"))?.data.toString(), "a");
  assert.equal(objectFaults.length, 0, "the first try hung");
  assert.ok(Date.now() - started < 5_000);
});

test("a 503 is retried on a replayable call, and NOT on an unconditional write", async () => {
  const gcs = store();
  await gcs.write("wa10/a", Buffer.from("a"));
  objectFaults = [{ kind: "status", code: 503 }];
  assert.equal((await gcs.read("wa10/a"))?.data.toString(), "a");
  assert.equal(objectFaults.length, 0);

  const before = seen.length;
  objectFaults = [{ kind: "status", code: 503 }];
  const err = await gcs.write("wa10/a", Buffer.from("b")).catch((e: unknown) => e);
  assert.ok(err instanceof GcsHttpError);
  assert.equal(err.code, 503);
  assert.equal(seen.slice(before).filter((l) => l.startsWith("POST /upload")).length, 1);
});

test("a rejected credential is reported in Google's words, once, not retried", async () => {
  const before = tokenFetches;
  const err = await store({ clientEmail: "someone-else@example.iam.gserviceaccount.com" })
    .read("wa11/x")
    .catch((e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /token request: HTTP 400: invalid_grant: bad iss/);
  assert.equal(tokenFetches - before, 1);
  assert.equal(isTransientTransportError(err), false);
});

test("a private key that does not parse says which variable, and never echoes it", async () => {
  const bad = "-----BEGIN PRIVATE KEY-----\nnot-a-key-at-all\n-----END PRIVATE KEY-----";
  const err = await store({ privateKey: bad }).read("wa12/x").catch((e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /WHATSAPP_GCS_PRIVATE_KEY is not a usable PEM private key/);
  assert.doesNotMatch(err.message, /not-a-key-at-all/);
});

test("past the budget, the error says transient; retry — and not the transport's text", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const before = tokenFetches;
  tokenFaults = Array.from({ length: 10 }, () => ({ kind: "chunked" }) as const);
  const gcs = store({ retry: { ...FAST, attempts: 3 } });
  const err = await gcs.read("wa5/none.bin").catch((e: unknown) => e);
  assert.ok(err instanceof TransientStoreError);
  assert.equal(tokenFetches - before, 3, "bounded: exactly the budget, no more");
  assert.match(err.message, /transient; retry/);
  assert.doesNotMatch(err.message, /terminated|fetch failed|oauth2|127\.0\.0\.1/);
});

test("an unconditional write replays only when the token fetch failed — it was never sent", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Token fetch cut off: the object request was never made, so the replay is safe.
  const t0 = tokenFetches;
  tokenFaults = [{ kind: "chunked" }];
  await store().write("wa6/lease.json", Buffer.from("a"));
  assert.equal(tokenFetches - t0, 2);

  // The object request itself cut off: it may have landed, and a replay could
  // overwrite another process's write in between. Reported, not replayed.
  const before = seen.length;
  objectFaults = [{ kind: "chunked" }];
  const err = await store()
    .write("wa6/lease.json", Buffer.from("b"))
    .catch((e: unknown) => e);
  assert.ok(err instanceof TransientStoreError);
  assert.equal(seen.slice(before).filter((l) => l.startsWith("POST /upload")).length, 1);
});

test("the deadline stops new tries even with attempts left", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const before = tokenFetches;
  tokenFaults = Array.from({ length: 60 }, () => ({ kind: "chunked" }) as const);
  const gcs = store({ retry: { attempts: 50, baseDelayMs: 20, deadlineMs: 50, requestTimeoutMs: 5_000 } });
  const err = await gcs.read("wa7/none.bin").catch((e: unknown) => e);
  assert.ok(err instanceof TransientStoreError);
  const tries = tokenFetches - before;
  assert.ok(tries < 50 && tries >= 2, `stopped by the deadline after ${tries}`);
});

test("the classifier: native fetch's failures are transient, an answer is not", async () => {
  // The real errors native fetch raises, from the real socket.
  tokenFaults = [{ kind: "chunked" }];
  const cut = await fetch(`${endpoint}/token`, { method: "POST" })
    .then((r) => r.text())
    .catch((e: unknown) => e);
  assert.ok(cut instanceof Error);
  assert.equal(isTransientTransportError(cut), true);
  const closed = createNetServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const refused = await fetch(`http://127.0.0.1:${closedPort}/`).catch((e: unknown) => e);
  assert.equal(isTransientTransportError(refused), true);
  // A server that accepts and never answers: the per-request timeout's error.
  const silent = createNetServer(() => {});
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const port = (silent.address() as { port: number }).port;
  const timeout = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(50) }).catch(
    (e: unknown) => e,
  );
  silent.close();
  assert.equal(isTransientTransportError(timeout), true);

  // GCS answered: not a transport error.
  assert.equal(isTransientTransportError(new GcsHttpError(503, "reading x", "ECONNRESET?")), false);
  assert.equal(isTransientTransportError(new Error("invalid_grant")), false);
  assert.equal(isTransientTransportError(new PreconditionFailed("x")), false);
});
