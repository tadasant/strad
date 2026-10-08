import { afterAll, beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { CRC32C } from "@google-cloud/storage";
import { request } from "gaxios";
import { OAuth2Client } from "google-auth-library";

import {
  GcsBlobStore,
  isTransientTransportError,
  PreconditionFailed,
  StateStore,
  TransientStoreError,
} from "../src/index.js";

/**
 * The REAL `@google-cloud/storage` client, against a local stand-in for the
 * slice of the GCS JSON API it calls. `MemoryBlobStore` is faithful to what
 * `BlobStore` promises; this is what checks that `GcsBlobStore` keeps those
 * promises against the actual library — in particular that a READ reports the
 * generation a later conditional write needs. `download()` alone does not, and
 * missing that made every write after the first restart fail its
 * precondition.
 *
 * The fake answers exactly as GCS documents: a metadata GET, an `alt=media`
 * GET honouring `generation`, a multipart upload honouring
 * `ifGenerationMatch` with 412, DELETE, and a prefix list.
 */

interface Obj {
  data: Buffer;
  generation: number;
}
const objects = new Map<string, Obj>();
const seen: string[] = [];
let counter = 1_000;
/**
 * How many of the next requests to cut off mid-body: a CHUNKED response whose
 * socket closes before the terminating chunk. That is the exact shape node-fetch
 * 2 reports as "Invalid response body … : Premature close" (code
 * ERR_STREAM_PREMATURE_CLOSE).
 */
let truncateNext = 0;
let server: Server;
let endpoint = "";

function meta(name: string, o: Obj) {
  return {
    kind: "storage#object",
    bucket: "b",
    name,
    generation: String(o.generation),
    size: String(o.data.length),
    // The client checks an upload against these, as it does against GCS.
    md5Hash: createHash("md5").update(o.data).digest("base64"),
    crc32c: (() => {
      const crc = new CRC32C();
      crc.update(o.data);
      return crc.toString();
    })(),
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/token" || truncateNext > 0) {
        if (url.pathname !== "/token") truncateNext--;
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"access_token":"tr');
        setTimeout(() => res.socket?.destroy(), 5);
        return;
      }
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const notFound = () => json(404, { error: { code: 404, message: "No such object" } });

      const upload = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/);
      if (req.method === "POST" && upload) {
        const body = Buffer.concat(chunks);
        const type = String(req.headers["content-type"] ?? "");
        const boundary = type.match(/boundary=([^;]+)/)?.[1];
        let name = url.searchParams.get("name") ?? "";
        let data = body;
        if (boundary) {
          const parts = body.toString("latin1").split(`--${boundary}`).slice(1, -1);
          const part = (p: string) => p.slice(p.indexOf("\r\n\r\n") + 4, -2);
          name = name || JSON.parse(part(parts[0]!)).name;
          data = Buffer.from(part(parts[1]!), "latin1");
        }
        const match = url.searchParams.get("ifGenerationMatch");
        const current = objects.get(name);
        if (match !== null && String(current?.generation ?? 0) !== match) {
          return json(412, { error: { code: 412, message: "conditionNotMet" } });
        }
        const obj = { data, generation: ++counter };
        objects.set(name, obj);
        return json(200, meta(name, obj));
      }

      const one = url.pathname.match(/^\/(?:download\/)?storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
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
        return json(200, meta(name, obj));
      }

      const list = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o$/);
      if (req.method === "GET" && list) {
        const prefix = url.searchParams.get("prefix") ?? "";
        const items = [...objects].filter(([n]) => n.startsWith(prefix)).map(([n, o]) => meta(n, o));
        return json(200, { kind: "storage#objects", items });
      }
      json(501, { error: { code: 501, message: `fake GCS does not serve ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const FAST = { attempts: 4, baseDelayMs: 1 };

const store = (extra: Partial<ConstructorParameters<typeof GcsBlobStore>[0]> = {}) =>
  new GcsBlobStore({
    bucket: "b",
    clientEmail: "unused@example.iam.gserviceaccount.com",
    privateKey: "unused",
    projectId: "p",
    apiEndpoint: endpoint,
    retry: FAST,
    ...extra,
  });

/**
 * The service-account token fetch, standing in for gtoken's POST to
 * googleapis.com/oauth2/v4/token: the first `failures` fetches go through the
 * REAL gaxios → node-fetch stack to a server that cuts the body off, so the
 * error is the one production saw, not a hand-built copy of it.
 */
class FlakyTokenClient extends OAuth2Client {
  fetches = 0;
  constructor(private failures: number) {
    super();
  }
  override async getRequestHeaders(): Promise<Record<string, string>> {
    this.fetches++;
    if (this.failures > 0) {
      this.failures--;
      await request({ url: `${endpoint}/token`, method: "POST", responseType: "json", retry: false });
    }
    return { Authorization: "Bearer test-token" };
  }
}

test("the real client: a read reports the generation a conditional write needs", async () => {
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

  assert.deepEqual(await gcs.list("wa/"), ["wa/a.bin"]);
  await gcs.delete("wa/a.bin");
  await gcs.delete("wa/a.bin"); // idempotent
  assert.equal(await gcs.read("wa/a.bin"), null);
  assert.ok(
    seen.some((line) => /alt=media/.test(line) && /generation=\d+/.test(line)),
    "the download is pinned to the generation the metadata reported",
  );
});

test("the real client: auth survives a restart and keeps being written", async () => {
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

test("the real stack's Premature close is what the classifier calls transient", async () => {
  const err = await request({ url: `${endpoint}/token`, method: "POST", responseType: "json", retry: false })
    .then(() => assert.fail("the truncated body should not parse"))
    .catch((e: unknown) => e);
  assert.match((err as Error).message, /Invalid response body while trying to fetch .*: Premature close/);
  assert.equal(isTransientTransportError(err), true);
  // GCS answered: not a transport error, and `autoRetry` owns it.
  assert.equal(isTransientTransportError(Object.assign(new Error("ECONNRESET?"), { code: 503 })), false);
  assert.equal(isTransientTransportError(new Error("invalid_grant")), false);
  assert.equal(isTransientTransportError(new PreconditionFailed("x")), false);
});

test("a token fetch that closes prematurely once is retried, and the call succeeds", async () => {
  const auth = new FlakyTokenClient(1);
  const gcs = store({ authClient: auth });
  const g = await gcs.write("wa3/a.bin", Buffer.from("one"), null);
  assert.match(g, /^\d+$/);
  assert.equal(auth.fetches, 2, "one failed token fetch, then one that worked");
  assert.equal((await gcs.read("wa3/a.bin"))?.data.toString(), "one");
});

test("an object read, write and list cut off mid-body once are retried", async () => {
  const gcs = store();
  truncateNext = 1;
  await gcs.write("wa4/a.bin", Buffer.from("one"), null);
  assert.equal(truncateNext, 0, "the write's first try was cut off");
  truncateNext = 1;
  assert.equal((await gcs.read("wa4/a.bin"))?.data.toString(), "one");
  truncateNext = 1;
  assert.deepEqual(await gcs.list("wa4/"), ["wa4/a.bin"]);
  truncateNext = 1;
  await gcs.delete("wa4/a.bin");
  assert.equal(await gcs.read("wa4/a.bin"), null);
});

test("past the budget, the error says transient; retry — and not the transport's text", async () => {
  const auth = new FlakyTokenClient(99);
  const gcs = store({ authClient: auth, retry: { attempts: 3, baseDelayMs: 1 } });
  const err = await gcs.read("wa5/none.bin").catch((e: unknown) => e);
  assert.ok(err instanceof TransientStoreError);
  assert.equal(auth.fetches, 3, "bounded: exactly the budget, no more");
  assert.match(err.message, /transient; retry/);
  assert.doesNotMatch(err.message, /Premature close|googleapis|oauth2|127\.0\.0\.1/);
  assert.match(String((err.cause as Error).message), /Premature close/);
});
