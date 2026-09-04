import { test } from "vitest";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMCPServer } from "../src/index.js";
import { VIEWER_ACCOUNT } from "./fake-parameter-manager.js";

/**
 * THE DEEP LINK IS THE WHOLE POINT OF `open_secrets_manager`.
 *
 * The tool returns no value and does nothing to the store; all it produces is a
 * URL that lands a human on the parameter in question. So the URL is the thing
 * under test, and the case that breaks it is the one `SECRETS_CONSOLE_URL` is
 * free-form enough to carry: a query string. A multi-store console selects its
 * store with `?project=`, and a link joined with a bare `?` puts the rest of
 * itself INSIDE that value — which the console reads as a stale bookmark and
 * silently answers with the first store. Wrong store, no error, page that looks
 * entirely correct.
 *
 * Nothing here touches Parameter Manager: no store is reachable in this file,
 * and none is consulted. The capability lookup is injected for the same reason
 * it is elsewhere — the probe is a live HTTPS call.
 */

const NS = "/strad/staging/mcp/";
const PARAM = `${NS}remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_PRIVATE_KEY`;

const CAPS_NONE = {
  readSecretValues: false,
  writeParameters: false,
  writeSecretValues: false,
  deleteParameters: false,
  probed: true,
};

/** A client over a server whose only interesting property is its `consoleUrl`. */
async function fixture(consoleUrl?: string) {
  const { server, registerHandlers } = createMCPServer({
    version: "0.0.0-test",
    config: {
      stores: [
        {
          project: "test-project",
          namespaces: [NS],
          account: VIEWER_ACCOUNT,
          viewerKeyVar: "SECRETS_SERVICE_ACCOUNT_KEY_JSON",
        },
      ],
      consoleUrl,
    },
    capabilities: () => Promise.resolve(CAPS_NONE),
  });
  await registerHandlers(server);

  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

/** The `url` an agent is handed, or the error text if the tool refused. */
async function link(consoleUrl: string | undefined, param?: string) {
  const { client, close } = await fixture(consoleUrl);
  const res = await client.callTool({
    name: "open_secrets_manager",
    arguments: param === undefined ? {} : { secret: param },
  });
  await close();
  const text = (res as { content: { text: string }[] }).content[0].text;
  if (res.isError) return { url: undefined, error: true, text };
  return { url: JSON.parse(text).url as string | undefined, error: false, text };
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

test("a path-only console URL still gets the parameter on a leading '?'", async () => {
  // The shape every config in this repo carries. It must not move.
  const { url } = await link("https://staging.strad.tadasant.com/ui/secrets", PARAM);
  assert.equal(
    url,
    `https://staging.strad.tadasant.com/ui/secrets?param=${encodeURIComponent(PARAM)}`,
  );
});

test("a console URL that already carries a query string joins with '&'", async () => {
  // THE DEFECT. A bare `?` join yields
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
    "https://strad.tadasant.com/ui/secrets?project=zimmer-secrets-prod" +
      `&param=${encodeURIComponent(PARAM)}`,
  );

  // Not just "an ampersand appears somewhere": the two parameters have to parse
  // back to what they mean, which is the property the concatenation broke.
  const parsed = new URL(url!).searchParams;
  assert.equal(parsed.get("project"), "zimmer-secrets-prod");
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
  assert.equal(parsed.get("project"), "p");
});

test("with no parameter the link is the console URL, query string intact", async () => {
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
    `https://strad.tadasant.com/ui/secrets?param=${encodeURIComponent(PARAM)}`,
  );
  // A `?` or a `#` can follow the path, and the last character of a query value
  // or a hash route is not a trailing slash to eat.
  const q = await link("https://strad.tadasant.com/ui/secrets?project=prod/", PARAM);
  assert.equal(new URL(q.url!).searchParams.get("project"), "prod/");
});

test("the parameter lands before a fragment, not inside it", async () => {
  // Concatenated, `?param=` landed after the `#` — inside the fragment, which
  // never reaches the server at all.
  const { url } = await link("https://strad.tadasant.com/ui/secrets#top", PARAM);
  assert.equal(
    url,
    `https://strad.tadasant.com/ui/secrets?param=${encodeURIComponent(PARAM)}#top`,
  );
  assert.equal(new URL(url!).searchParams.get("param"), PARAM);
});

test("an unparseable console URL yields a link, not a thrown tool call", async () => {
  // `SECRETS_CONSOLE_URL` is free-form deployment config and `new URL()` throws
  // on anything without a scheme — including `/ui/secrets`, which is a usable
  // link for a human already on the host. Rejecting it here would turn a
  // cosmetic defect into a broken tool, so the fallback is the concatenation.
  const relative = await link("/ui/secrets", PARAM);
  assert.equal(relative.error, false);
  assert.equal(relative.url, `/ui/secrets?param=${encodeURIComponent(PARAM)}`);

  const nonsense = await link("not a url at all", PARAM);
  assert.equal(nonsense.error, false);
  assert.equal(nonsense.url, `not a url at all?param=${encodeURIComponent(PARAM)}`);

  assert.equal((await link("/ui/secrets", undefined)).url, "/ui/secrets");
  assert.equal(await advertised("/ui/secrets"), "/ui/secrets");

  // AND IT MUST NOT REPRODUCE THE DEFECT IT FELL BACK FROM. A relative value
  // carrying a query string is the relative spelling of the very URL this file
  // is about, and it is the one the URL parser cannot help with.
  const relativeWithQuery = await link("/ui/secrets?project=zimmer-secrets-prod", PARAM);
  assert.equal(
    relativeWithQuery.url,
    `/ui/secrets?project=zimmer-secrets-prod&param=${encodeURIComponent(PARAM)}`,
  );
  const parsed = new URL(relativeWithQuery.url!, "https://strad.tadasant.com").searchParams;
  assert.equal(parsed.get("project"), "zimmer-secrets-prod");
  assert.equal(parsed.get("param"), PARAM);
});

test("no console URL at all is the one case with no link", async () => {
  const { error, text } = await link(undefined, PARAM);
  assert.equal(error, true);
  assert.match(text, /SECRETS_CONSOLE_URL/);
  assert.equal(await advertised(undefined), undefined);
});
