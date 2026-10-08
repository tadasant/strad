import type { Server } from "node:http";
import { Script } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tokenStoreFromConfig } from "../src/auth/index.ts";
import { parseConfig } from "../src/config/load.ts";
import { Registry } from "../src/gateway/registry.ts";
import { createApp } from "../src/http/app.ts";
import { createFakeGcp, type FakeGcp } from "../src/secrets/parameters/fake.ts";
import { encodeSecretValue } from "../src/secrets/parameters/wire.ts";
import {
  EnvSecretProvider,
  sharedSecretProviders,
} from "../src/secrets/provider/index.ts";
import {
  formatBulkRow,
  parseBulkCsv,
  parseBulkKind,
} from "../src/ui/bulk-params.ts";

/**
 * Bulk add on the parameters page (`src/ui/bulk-params.ts`, `POST
 * /ui/:server/bulk`).
 *
 *   1. The CSV format: quoting, commas, quotes, line breaks, blank lines,
 *      comments, a header, and every malformed shape reported by line — with no
 *      value in any message.
 *   2. The parser the browser runs is THIS parser, inlined by `toString()`, so
 *      it must still be valid JS once it leaves the module.
 *   3. Through the real app: every line goes through the single create, nothing
 *      is written when any line is invalid, a store failure on one line does not
 *      drop the rest, and no value — secret or not — comes back in the page.
 */

const CANARY = "sk-live-BULK-CANARY-91c3";
const BOOTSTRAP = "bootstrap-secret-bulk";
const NS = "/strad/test/mcp/";

// --- 1. the format --------------------------------------------------------------

describe("parseBulkCsv", () => {
  it("reads one record per line, with the note optional", () => {
    const { records, errors } = parseBulkCsv(
      "telegram-rw/static/,TELEGRAM_API_ID,plain,12345,From my.telegram.org\n" +
        "telegram-rw/static/,TELEGRAM_API_HASH,secret,abc123",
    );
    expect(errors).toEqual([]);
    expect(records).toEqual([
      {
        line: 1,
        prefix: "telegram-rw/static/",
        variable: "TELEGRAM_API_ID",
        kind: "plain",
        value: "12345",
        note: "From my.telegram.org",
      },
      {
        line: 2,
        prefix: "telegram-rw/static/",
        variable: "TELEGRAM_API_HASH",
        kind: "secret",
        value: "abc123",
        note: "",
      },
    ]);
  });

  it("a quoted field holds commas, doubled quotes and line breaks", () => {
    const { records, errors } = parseBulkCsv(
      'p/,A,secret,"x,y,z","a note, with commas"\n' +
        'p/,B,secret,"say ""hi""",\n' +
        'p/,C,secret,"-----BEGIN KEY-----\nabc\n-----END KEY-----",pem\n' +
        "p/,D,plain,after",
    );
    expect(errors).toEqual([]);
    expect(records.map((r) => [r.line, r.variable, r.value, r.note])).toEqual([
      [1, "A", "x,y,z", "a note, with commas"],
      [2, "B", 'say "hi"', ""],
      [3, "C", "-----BEGIN KEY-----\nabc\n-----END KEY-----", "pem"],
      // Line numbers count physical lines, so a three-line value moves D to 6.
      [6, "D", "after", ""],
    ]);
  });

  it("trims an unquoted field and keeps a quoted value byte for byte", () => {
    const { records } = parseBulkCsv(
      ' p/ , A , secret ,  v  , n \np/,B,secret, "  v  " ,n',
    );
    expect(records[0]).toMatchObject({
      prefix: "p/",
      variable: "A",
      kind: "secret",
      value: "v",
      note: "n",
    });
    expect(records[1]?.value).toBe("  v  ");
  });

  it("skips blank lines, # comments and a leading header; reads CRLF", () => {
    const { records, errors } = parseBulkCsv(
      "prefix,variable,kind,value,note\r\n\r\n   \r\n# a comment, with commas\r\np/,A,secret,v\r\n\r\np/,B,plain,w\r\n",
    );
    expect(errors).toEqual([]);
    expect(records.map((r) => [r.line, r.variable])).toEqual([
      [5, "A"],
      [7, "B"],
    ]);
  });

  it("a header is only a header on the first record", () => {
    const { records } = parseBulkCsv("p/,A,secret,v\nprefix,variable,secret,v");
    expect(records.map((r) => r.variable)).toEqual(["A", "variable"]);
  });

  it("reports every malformed line by number, and keeps reading the rest", () => {
    const { records, errors } = parseBulkCsv(
      [
        "p/,TOO_FEW,secret",
        `p/,TOO_MANY,secret,${CANARY},note,extra`,
        `p/,MID,secret,ab"${CANARY}`,
        `p/,AFTER,secret,"${CANARY}"tail,n`,
        "p/,FINE,secret,v",
      ].join("\n"),
    );
    expect(records.map((r) => r.variable)).toEqual(["FINE"]);
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(errors[0]?.message).toMatch(/expected 4 or 5 fields.*found 3/);
    expect(errors[1]?.message).toMatch(/found 6.*Quote a value/);
    expect(errors[2]?.message).toMatch(/quote in the middle/);
    expect(errors[3]?.message).toMatch(/text after its closing quote/);
    // The text of a bad line is very often the credential.
    expect(JSON.stringify(errors)).not.toContain(CANARY);
  });

  it("an unterminated quote is an error on the line it opened on", () => {
    const { records, errors } = parseBulkCsv(
      `p/,A,secret,v\np/,B,secret,"${CANARY}\np/,C,secret,v`,
    );
    expect(records.map((r) => r.variable)).toEqual(["A"]);
    expect(errors).toEqual([
      { line: 2, message: expect.stringMatching(/never closed/) },
    ]);
    expect(JSON.stringify(errors)).not.toContain(CANARY);
  });

  it("a line break inside a quoted value is stored as LF, whatever the browser sent", () => {
    // A textarea submits CRLF. A PEM stored with \r\n is one some parsers reject.
    const { records, errors } = parseBulkCsv(
      'p/,K,secret,"-----BEGIN-----\r\nabc\r\n-----END-----"\r\np/,L,secret,"a\rb"\r\np/,M,plain,v',
    );
    expect(errors).toEqual([]);
    expect(records.map((r) => [r.line, r.variable, r.value])).toEqual([
      [1, "K", "-----BEGIN-----\nabc\n-----END-----"],
      [4, "L", "a\nb"],
      [6, "M", "v"],
    ]);
  });

  it("a first record that only looks like a header is data", () => {
    const { records } = parseBulkCsv("prefix,VARIABLE,secret,x");
    expect(records.map((r) => r.variable)).toEqual(["VARIABLE"]);
  });

  it("empty input is no records and no errors", () => {
    expect(parseBulkCsv("")).toEqual({ records: [], errors: [] });
    expect(parseBulkCsv("\n\n  \n")).toEqual({ records: [], errors: [] });
  });
});

describe("parseBulkKind", () => {
  it("empty means secret; plain and its spellings mean non-secret; anything else is null", () => {
    expect(parseBulkKind("")).toBe(true);
    expect(parseBulkKind("Secret")).toBe(true);
    expect(parseBulkKind("plain")).toBe(false);
    expect(parseBulkKind("non-secret")).toBe(false);
    expect(parseBulkKind("maybe")).toBeNull();
  });
});

describe("formatBulkRow", () => {
  it("round-trips through the parser, quoting only what needs it", () => {
    const rows = [
      { prefix: "p/", variable: "A", kind: "secret", value: "plain", note: "" },
      {
        prefix: "p/",
        variable: "B",
        kind: "plain",
        value: 'x,"y"\nz',
        note: "a, b",
      },
      {
        prefix: "",
        variable: "C",
        kind: "secret",
        value: "  spaced  ",
        note: "n",
      },
      { prefix: "#p/", variable: "D", kind: "secret", value: "v", note: "" },
    ];
    expect(formatBulkRow(rows[0]!)).toBe("p/,A,secret,plain");
    const back = parseBulkCsv(rows.map(formatBulkRow).join("\n"));
    expect(back.errors).toEqual([]);
    expect(back.records.map(({ line: _line, ...r }) => r)).toEqual(rows);
  });
});

describe("the parser the browser runs", () => {
  it("survives toString() as standalone JS and parses identically", () => {
    // `bulkClientScript` inlines these with Function.prototype.toString(). A
    // helper the transpiler injected, or a reference to module scope, would
    // throw here before it threw in a browser.
    const load = new Function(
      `${parseBulkCsv.toString()}\n${parseBulkKind.toString()}\n${formatBulkRow.toString()}\n` +
        "return { parseBulkCsv, parseBulkKind, formatBulkRow };",
    ) as () => {
      parseBulkCsv: typeof parseBulkCsv;
      parseBulkKind: typeof parseBulkKind;
      formatBulkRow: typeof formatBulkRow;
    };
    const inlined = load();
    const input = 'p/,A,secret,"x,""y""",n\nbad"line\n\np/,B,plain,v';
    expect(inlined.parseBulkCsv(input)).toEqual(parseBulkCsv(input));
    expect(inlined.parseBulkKind("plain")).toBe(false);
    expect(
      inlined.formatBulkRow({
        prefix: "p/",
        variable: "A",
        kind: "secret",
        value: "a,b",
        note: "",
      }),
    ).toBe('p/,A,secret,"a,b"');
  });
});

// --- 3. through the real app ----------------------------------------------------

const CONFIG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: secrets
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /secrets
    entitlements: [admin]
    env:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
      SECRETS_SERVICE_ACCOUNT_KEY_JSON: "\${VIEWER_KEY}"
    consoleEnv:
      SECRETS_PROJECT_ID: "demo-project"
      SECRETS_NAMESPACES: "${NS}"
      SECRETS_NAMESPACES_STRICT: "true"
      SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON: "\${ADMIN_KEY}"
`);

const KEY = (who: string) =>
  JSON.stringify({
    client_email: `strad-secrets-${who}@demo.iam.gserviceaccount.com`,
    private_key:
      "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
  });
const SECRETS = { ADMIN_KEY: KEY("admin"), VIEWER_KEY: KEY("viewer") };

const env: NodeJS.ProcessEnv = {
  ALLOW_DEV_AUTH: "true",
  ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP,
  STRAD_BUNDLE_URL_BUNDLE: "http://127.0.0.1:1",
  STRAD_TOKENS: "[]",
};

let fake: FakeGcp;
let server: Server;
let baseUrl: string;
let invalidations = 0;
const auth = { authorization: `Bearer ${BOOTSTRAP}` };

beforeAll(async () => {
  fake = createFakeGcp();
  const runtime = new EnvSecretProvider(SECRETS);
  const providers = sharedSecretProviders({
    name: runtime.name,
    get: (name: string) => runtime.get(name),
    invalidate: () => {
      invalidations += 1;
    },
  });
  const registry = await Registry.build({
    config: CONFIG,
    secrets: providers,
    mode: "core",
    env,
  });
  const app = createApp({
    config: CONFIG,
    registry,
    tokenStore: tokenStoreFromConfig(CONFIG, env),
    mode: "core",
    env,
    secrets: SECRETS,
    secretProvider: providers,
    parametersStore: () => fake.store,
    capabilities: () =>
      Promise.resolve({
        readSecretValues: true,
        writeParameters: true,
        writeSecretValues: true,
        deleteParameters: true,
        probed: true,
      }),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  fake.parameters.clear();
  fake.secrets.clear();
  invalidations = 0;
  await fake.store.create({
    path: `${NS}seeded/static/EXISTING`,
    secret: true,
    value: "seed-value",
  });
});

function bulk(
  csv: string,
  extra: Record<string, string> = {},
  headers: Record<string, string> = auth,
) {
  return fetch(`${baseUrl}/ui/secrets/bulk`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      ns: NS,
      project: "demo-project",
      csv,
      ...extra,
    }),
    redirect: "manual",
  });
}

async function paths(): Promise<string[]> {
  return (await fake.store.list(NS)).map((p) => p.path).sort();
}

describe("POST /ui/secrets/bulk", () => {
  it("creates every line through the single create: secret to Secret Manager, plain to Parameter Manager", async () => {
    const res = await bulk(
      [
        "prefix,variable,kind,value,note",
        `telegram-rw/static/,TELEGRAM_API_HASH,secret,${CANARY},From my.telegram.org`,
        `telegram-rw/static/,TELEGRAM_STRING_SESSION,,"${CANARY},with,commas"`,
        "telegram-rw/static/,TELEGRAM_API_ID,plain,12345,App id",
      ].join("\n"),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Created 3 parameters in /strad/test/mcp/.");
    expect(await paths()).toEqual([
      `${NS}seeded/static/EXISTING`,
      `${NS}telegram-rw/static/TELEGRAM_API_HASH`,
      `${NS}telegram-rw/static/TELEGRAM_API_ID`,
      `${NS}telegram-rw/static/TELEGRAM_STRING_SESSION`,
    ]);
    const listed = await fake.store.list(NS);
    expect(
      listed.find((p) => p.variable === "TELEGRAM_API_HASH"),
    ).toMatchObject({
      secret: true,
      note: "From my.telegram.org",
    });
    // Empty kind is secret.
    expect(
      listed.find((p) => p.variable === "TELEGRAM_STRING_SESSION")?.secret,
    ).toBe(true);
    expect(listed.find((p) => p.variable === "TELEGRAM_API_ID")?.secret).toBe(
      false,
    );
    expect(
      await fake.store.reveal(
        `${NS}telegram-rw/static/TELEGRAM_STRING_SESSION`,
      ),
    ).toBe(`${CANARY},with,commas`);
    // The secret values live in Secret Manager only, and never come back.
    expect(fake.pmPayloads().join("\n")).not.toContain(CANARY);
    expect([...fake.secrets.values()].flat()).toContain(
      encodeSecretValue(CANARY),
    );
    expect(html).not.toContain(CANARY);
    // The per-line report, and the runtime told once.
    expect(html).toMatch(/id="bulk-result"/);
    expect((html.match(/class="bulk-out-created/g) ?? []).length).toBe(3);
    expect(invalidations).toBe(1);
  });

  it("writes NOTHING when any line is invalid, reports each line, and refills without values", async () => {
    const res = await bulk(
      [
        `p/static/,GOOD_ONE,secret,${CANARY}`,
        `p/static/,1BAD,secret,${CANARY}`,
        `p/static/,NO_VALUE,secret,`,
        `seeded/static/,EXISTING,secret,${CANARY}`,
        `p/static/,GOOD_ONE,plain,${CANARY}`,
        `p/static/,KIND,maybe,${CANARY}`,
        `UPPER/static/,X,secret,${CANARY}`,
        `p/static/,BROKEN,secret,"${CANARY}"junk`,
      ].join("\n"),
    );
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(await paths()).toEqual([`${NS}seeded/static/EXISTING`]);
    expect(invalidations).toBe(0);
    expect(html).toContain(
      "Nothing was created: 7 of 8 lines need fixing first.",
    );
    expect(html).toContain("valid environment variable name");
    expect(html).toContain("A value is required.");
    expect(html).toContain("already exists");
    expect(html).toContain("Line 1 already creates this path.");
    expect(html).toContain("The kind column must be");
    expect(html).toContain("LOWERCASE");
    expect(html).toContain("could not be read");
    // Line 1 was fine, and is reported as not written rather than dropped.
    expect(html).toMatch(/class="bulk-out-skipped/);
    // The refill carries names and kinds back into the editor, and no value.
    const textarea =
      /<textarea[^>]*id="bulk-csv"[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1] ??
      "";
    expect(textarea).toContain("p/static/,GOOD_ONE,secret,");
    expect(textarea).toContain("seeded/static/,EXISTING,secret,");
    // The unreadable line has no fields to give back; it returns as a comment.
    expect(textarea).toContain("# line 8 could not be read; enter it again");
    expect(html).not.toContain(CANARY);
  });

  it("a store failure on one line does not stop the rest, and that line comes back to the editor", async () => {
    const original = fake.store.create.bind(fake.store);
    fake.store.create = async (p) => {
      if (p.path.endsWith("/B"))
        throw new Error(`upstream said no to ${p.value}`);
      return original(p);
    };
    try {
      const res = await bulk(
        `s/,A,secret,${CANARY}\ns/,B,secret,${CANARY}\ns/,C,plain,c-value`,
      );
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(await paths()).toEqual([
        `${NS}s/A`,
        `${NS}s/C`,
        `${NS}seeded/static/EXISTING`,
      ]);
      expect(html).toContain("Created 2 of 3. 1 failed at the store");
      expect((html.match(/class="bulk-out-created/g) ?? []).length).toBe(2);
      expect(html).toMatch(/class="bulk-out-failed/);
      const textarea =
        /<textarea[^>]*id="bulk-csv"[^>]*>([^<]*)<\/textarea>/.exec(
          html,
        )?.[1] ?? "";
      expect(textarea).toBe("s/,B,secret,");
      // Neither the value nor the upstream's message (which quoted it).
      expect(html).not.toContain(CANARY);
      expect(html).not.toContain("upstream said no");
      expect(invalidations).toBe(1);
    } finally {
      fake.store.create = original;
    }
  });

  it("stores a quoted multi-line value submitted with CRLF as LF", async () => {
    const pem = "-----BEGIN KEY-----\r\nabc\r\n-----END KEY-----";
    const res = await bulk(`s/,PEM,secret,"${pem}",a key`);
    expect(res.status).toBe(200);
    expect(await fake.store.reveal(`${NS}s/PEM`)).toBe(
      "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    );
  });

  it("an unknown store refuses the batch and writes nothing", async () => {
    const res = await bulk("s/,A,secret,v", { project: "not-a-project" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not configured on this console");
    expect(await paths()).toEqual([`${NS}seeded/static/EXISTING`]);
  });

  it("a namespace outside a strict store's list refuses the whole batch", async () => {
    const res = await bulk("s/,A,secret,v", { ns: "/somewhere/else/" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("this store is strict");
    expect(await paths()).toEqual([`${NS}seeded/static/EXISTING`]);
  });

  it("empty input, and more than 100 lines, are refused", async () => {
    expect((await bulk("\n\n")).status).toBe(400);
    const many = Array.from(
      { length: 101 },
      (_, i) => `s/,V_${i},secret,v`,
    ).join("\n");
    const res = await bulk(many);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("At most 100 parameters");
    expect(await paths()).toEqual([`${NS}seeded/static/EXISTING`]);
  });

  it("is behind the SSO gate: no session, no write", async () => {
    const res = await bulk("s/,A,secret,v", {}, {});
    expect(res.status).toBe(401);
    expect(await paths()).toEqual([`${NS}seeded/static/EXISTING`]);
  });

  it("the page carries the bulk form, and its inline script compiles", async () => {
    const res = await fetch(`${baseUrl}/ui/secrets`, { headers: auth });
    const html = await res.text();
    expect(html).toContain('action="/ui/secrets/bulk"');
    expect(html).toContain("Add several parameters");
    expect(html).not.toContain("seed-value");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1] ?? "",
    );
    const bulkScript = scripts.find((s) => s.includes("bulk-rows-body"));
    expect(bulkScript).toBeTruthy();
    expect(() => new Script(bulkScript!)).not.toThrow();
  });
});
