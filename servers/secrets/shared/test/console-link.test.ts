import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMCPServer } from "../src/index.js";
import type { SecretsStore } from "../src/config.js";
import { VIEWER_ACCOUNT } from "./fake-parameter-manager.js";

/**
 * THE DEEP LINK IS THE WHOLE POINT OF `open_secrets_manager`.
 *
 * The tool returns no value and does nothing to the store; all it produces is a
 * URL that lands a human on the parameter in question. So the URL is the thing
 * under test, and there are two ways it lands on the wrong page — both silent,
 * both on a page that looks entirely correct:
 *
 *   1. The JOIN. `SECRETS_CONSOLE_URL` is free-form enough to carry a query
 *      string, a multi-store console selects its store with `?project=`, and a
 *      link joined with a bare `?` puts the rest of itself INSIDE that value —
 *      which the console reads as a stale bookmark and answers with its first
 *      store.
 *   2. The STORE. One container fronts N stores behind ONE `SECRETS_CONSOLE_URL`,
 *      so a link that leaves `?project=` to the operator's constant names the
 *      right store for at most one of the N. The path resolves to exactly one
 *      store, and that resolved answer is what the link carries.
 *
 * Nothing here touches Parameter Manager: no store is reachable in this file,
 * and none is consulted. The capability lookup is injected for the same reason
 * it is elsewhere — the probe is a live HTTPS call.
 */

const NS = "/strad/staging/mcp/";
const PARAM = `${NS}remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY`;
const PROJECT = "test-project";

/** The other two stores of a multi-store server, and a path in each. */
const NS_A = "/strad/a/mcp/";
const NS_B = "/strad/b/mcp/";
const PARAM_A = `${NS_A}telegram-rw/static/TELEGRAM_SESSION`;
const PARAM_B = `${NS_B}telegram-rw/static/TELEGRAM_SESSION`;

const CAPS_NONE = {
  readSecretValues: false,
  writeParameters: false,
  writeSecretValues: false,
  deleteParameters: false,
  probed: true,
};

const store = (project: string, namespaces: string[]): SecretsStore => ({
  project,
  namespaces,
  account: VIEWER_ACCOUNT,
  viewerKeyVar: `SECRETS_KEY_${project.toUpperCase().replace(/-/g, "_")}`,
});

const ONE_STORE = [store(PROJECT, [NS])];
const TWO_STORES = [store("proj-a", [NS_A]), store("proj-b", [NS_B])];

/** A client over a server whose only interesting property is its `consoleUrl`. */
async function fixture(consoleUrl?: string, stores: SecretsStore[] = ONE_STORE) {
  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    config: { stores, consoleUrl },
    capabilities: () => Promise.resolve(CAPS_NONE),
  });
  await registerHandlers(server);

  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

/** The `url` an agent is handed, or the error text if the tool refused. */
async function link(
  consoleUrl: string | undefined,
  param?: string,
  stores?: SecretsStore[],
) {
  const { client, close } = await fixture(consoleUrl, stores);
  const res = await client.callTool({
    name: "open_secrets_manager",
    arguments: param === undefined ? {} : { secret: param },
  });
  await close();
  const text = (res as { content: { text: string }[] }).content[0].text;
  if (res.isError) return { url: undefined, error: true, text };
  const payload = JSON.parse(text) as {
    url?: string;
    project?: string;
    note?: string;
  };
  return { ...payload, error: false, text };
}

/** The `?project=` a link carries, parsed back out of it. */
function projectOn(url: string): string | null {
  return new URL(url, "https://strad.tadasant.com").searchParams.get("project");
}

/** What `list_managed_namespaces` publishes as the console's address. */
async function advertised(consoleUrl?: string) {
  const { client, close } = await fixture(consoleUrl);
  const res = await client.callTool({
    name: "list_managed_namespaces",
    arguments: {},
  });
  await close();
  return JSON.parse((res as { content: { text: string }[] }).content[0].text)
    .consoleUrl as string | undefined;
}

test("the link names the store the path resolved to", async () => {
  // The console picks its store from `?project=`. A path-only console URL names
  // no store at all, and the console then falls back to whichever store it lists
  // first — right by coincidence, if at all.
  const { url, project } = await link(
    "https://staging.strad.tadasant.com/ui/secrets",
    PARAM,
  );
  assert.equal(
    url,
    `https://staging.strad.tadasant.com/ui/secrets?param=${encodeURIComponent(PARAM)}` +
      `&project=${PROJECT}`,
  );
  // And the resolved store is reported to the agent as well as spliced into the
  // link, so "which project is this in" is answerable without parsing a URL.
  assert.equal(project, PROJECT);
});

test("a path in store B beats a `?project=A` the operator hardcoded", async () => {
  // THE DEFECT. One container, two stores, ONE `SECRETS_CONSOLE_URL` — so the
  // constant in that variable is right for at most one of them, and every
  // parameter in the other one silently opens on the wrong project.
  const configured = "https://strad.tadasant.com/ui/secrets?project=proj-a";

  const b = await link(configured, PARAM_B, TWO_STORES);
  assert.equal(projectOn(b.url!), "proj-b");
  assert.equal(b.project, "proj-b");
  assert.equal(new URL(b.url!).searchParams.get("param"), PARAM_B);
  // Replaced, never duplicated: Express reads a repeated `project=` as an array,
  // which `selectStoreStrict` refuses — the first-store fallback all over again.
  assert.deepEqual(new URL(b.url!).searchParams.getAll("project"), ["proj-b"]);

  // The store the constant happened to name is not a special case: it is
  // resolved from the path exactly like the other one.
  const a = await link(configured, PARAM_A, TWO_STORES);
  assert.equal(projectOn(a.url!), "proj-a");
  assert.equal(a.project, "proj-a");
});

test("a path no store claims leaves the configured link alone, and says so", async () => {
  // `secret` is documented as a canonical path OR a bare variable name, so an
  // argument that resolves to no store is ordinary input — not an error. The
  // tool reads nothing, so there is nothing to refuse: the link is still worth
  // handing over, it just cannot name a store.
  const { url, project, note, error } = await link(
    "https://strad.tadasant.com/ui/secrets?project=proj-a",
    "TELEGRAM_SESSION",
    TWO_STORES,
  );
  assert.equal(error, false);
  assert.equal(projectOn(url!), "proj-a");
  assert.equal(new URL(url!).searchParams.get("param"), "TELEGRAM_SESSION");
  assert.equal(project, undefined);
  assert.match(note!, /cannot name a store/);
  // The note names the namespaces, so the agent can fix the argument itself.
  assert.match(note!, /"\/strad\/a\/mcp\/" \(proj-a\)/);

  // A path in no namespace at all gets the same treatment — this tool never
  // refuses one, because refusing would cost a human the console link.
  const outside = await link(
    "https://strad.tadasant.com/ui/secrets",
    "/strad/tokens/SOMETHING",
    TWO_STORES,
  );
  assert.equal(outside.error, false);
  assert.equal(projectOn(outside.url!), null);
  assert.equal(outside.project, undefined);
  assert.match(outside.note!, /cannot name a store/);
});

test("a single-store server names its store too", async () => {
  // Not a multi-store-only fix. The console's `consoleStores:` is configured
  // separately from this server's `mcpStores:`, so a single-store MCP server can
  // front a console listing four — and the no-`?project=` fallback then lands on
  // whichever of the four is declared first.
  const { url, project, note } = await link(
    "https://strad.tadasant.com/ui/secrets",
    PARAM,
    ONE_STORE,
  );
  assert.equal(projectOn(url!), PROJECT);
  assert.equal(project, PROJECT);
  assert.equal(note, undefined);
});

test("a console URL that already carries a query string joins with '&'", async () => {
  // A bare `?` join yields
  //   .../ui/secrets?project=zimmer-secrets-prod?param=%2Fstrad%2F...
  // whose one `project` value is `zimmer-secrets-prod?param=/strad/...` — no
  // store, so the console falls back to the first one and the human reads the
  // wrong page.
  const { url } = await link(
    "https://strad.tadasant.com/ui/secrets?project=zimmer-secrets-prod",
    PARAM,
  );
  assert.equal(
    url,
    `https://strad.tadasant.com/ui/secrets?project=${PROJECT}` +
      `&param=${encodeURIComponent(PARAM)}`,
  );

  // Not just "an ampersand appears somewhere": the two parameters have to parse
  // back to what they mean, which is the property the concatenation broke.
  const parsed = new URL(url!).searchParams;
  assert.equal(parsed.get("project"), PROJECT);
  assert.equal(parsed.get("param"), PARAM);
});

test("a `param` the configured URL already carries is replaced, not duplicated", async () => {
  // A duplicate would be read as the FIRST one — the configured value — so the
  // deep link would silently ignore the parameter the agent asked for.
  const { url } = await link(
    "https://strad.tadasant.com/ui/secrets?param=%2Fstale%2FOLD&project=p",
    PARAM,
  );
  const parsed = new URL(url!).searchParams;
  assert.deepEqual(parsed.getAll("param"), [PARAM]);
  assert.deepEqual(parsed.getAll("project"), [PROJECT]);
});

test("with no parameter the link is the console URL, query string intact", async () => {
  // No parameter is no path, so there is nothing to resolve and nothing to
  // relabel: an operator's `?project=` is the only answer available, and it
  // stands.
  assert.equal(
    (await link("https://strad.tadasant.com/ui/secrets", undefined)).url,
    "https://strad.tadasant.com/ui/secrets",
  );
  assert.equal(
    (await link("https://strad.tadasant.com/ui/secrets?project=prod", undefined)).url,
    "https://strad.tadasant.com/ui/secrets?project=prod",
  );
  // The same helper answers `list_managed_namespaces`, which advertises the
  // console without a parameter.
  assert.equal(
    await advertised("https://strad.tadasant.com/ui/secrets?project=prod"),
    "https://strad.tadasant.com/ui/secrets?project=prod",
  );
});

test("the trailing slash is stripped from the PATH, not from the string", async () => {
  assert.equal(
    (await link("https://strad.tadasant.com/ui/secrets///", PARAM)).url,
    `https://strad.tadasant.com/ui/secrets?param=${encodeURIComponent(PARAM)}` +
      `&project=${PROJECT}`,
  );
  // A `?` or a `#` can follow the path, and the last character of a query value
  // or a hash route is not a trailing slash to eat. (The value under test is a
  // key we do not write; `project` is asserted above.)
  const q = await link("https://strad.tadasant.com/ui/secrets?ns=prod/", PARAM);
  assert.equal(new URL(q.url!).searchParams.get("ns"), "prod/");
});

test("the parameter lands before a fragment, not inside it", async () => {
  // Concatenated, `?param=` landed after the `#` — inside the fragment, which
  // never reaches the server at all.
  const { url } = await link("https://strad.tadasant.com/ui/secrets#top", PARAM);
  assert.equal(
    url,
    `https://strad.tadasant.com/ui/secrets?param=${encodeURIComponent(PARAM)}` +
      `&project=${PROJECT}#top`,
  );
  const parsed = new URL(url!).searchParams;
  assert.equal(parsed.get("param"), PARAM);
  assert.equal(parsed.get("project"), PROJECT);
});

test("an unparseable console URL yields a link, not a thrown tool call", async () => {
  // `SECRETS_CONSOLE_URL` is free-form deployment config and `new URL()` throws
  // on anything without a scheme — including `/ui/secrets`, which is a usable
  // link for a human already on the host. Rejecting it here would turn a
  // cosmetic defect into a broken tool, so the fallback assembles the query by
  // hand — with the SAME two keys and the same replace-not-duplicate rule.
  const relative = await link("/ui/secrets", PARAM);
  assert.equal(relative.error, false);
  assert.equal(
    relative.url,
    `/ui/secrets?param=${encodeURIComponent(PARAM)}&project=${PROJECT}`,
  );

  const nonsense = await link("not a url at all", PARAM);
  assert.equal(nonsense.error, false);
  assert.equal(
    nonsense.url,
    `not a url at all?param=${encodeURIComponent(PARAM)}&project=${PROJECT}`,
  );

  assert.equal((await link("/ui/secrets", undefined)).url, "/ui/secrets");
  assert.equal(await advertised("/ui/secrets"), "/ui/secrets");

  // AND IT MUST NOT REPRODUCE THE DEFECT IT FELL BACK FROM. A relative value
  // carrying a query string is the relative spelling of the very URL this file
  // is about, and it is the one the URL parser cannot help with — including the
  // hardcoded `project=` the resolved store has to override IN PLACE, because a
  // second `project=` reaches the console as an array and selects nothing.
  const relativeWithQuery = await link(
    "/ui/secrets?project=zimmer-secrets-prod",
    PARAM,
  );
  assert.equal(
    relativeWithQuery.url,
    `/ui/secrets?project=${PROJECT}&param=${encodeURIComponent(PARAM)}`,
  );
  const parsed = new URL(relativeWithQuery.url!, "https://strad.tadasant.com")
    .searchParams;
  assert.deepEqual(parsed.getAll("project"), [PROJECT]);
  assert.equal(parsed.get("param"), PARAM);

  // A fragment on an unparseable value is still a fragment: the query goes
  // BEFORE it, or it never reaches the console.
  const fragment = await link("/ui/secrets#top", PARAM);
  assert.equal(
    fragment.url,
    `/ui/secrets?param=${encodeURIComponent(PARAM)}&project=${PROJECT}#top`,
  );
});

test("no console URL at all is the one case with no link", async () => {
  const { error, text } = await link(undefined, PARAM);
  assert.equal(error, true);
  assert.match(text, /SECRETS_CONSOLE_URL/);
  assert.equal(await advertised(undefined), undefined);
});
