import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { createFakeGcp } from "../src/secrets/parameters/fake.ts";
import {
  isServerParamKind,
  layerNamespaces,
  oauthNamespace,
  oauthParameterPath,
  parameterPath,
  SERVER_PARAM_KINDS,
  serverKindNamespace,
  serverNamespaces,
  staticNamespace,
} from "../src/secrets/parameters/index.ts";
import { buildSecretProviders } from "../src/secrets/provider/index.ts";
import { Registry } from "../src/gateway/registry.ts";
import { sharedSecretProviders } from "../src/secrets/provider/index.ts";
import { EnvSecretProvider } from "../src/secrets/provider/index.ts";

/**
 * THE `oauth` KIND, from the path up.
 *
 * The canonical namespace has always been
 * `/strad/{env}/mcp/{slug}/{kind}/{VARIABLE}` with `static` as the only kind a
 * resolver read. This suite is about the second one, and about the single
 * property that makes it worth having: **a value under `oauth/` resolves exactly
 * as a value under `static/` does.** A kind that were written by the console and
 * read by nothing would be a credential minted into a drawer — the same failure
 * the connector's config gate already refuses in another shape.
 *
 * So the assertions below are deliberately about RESOLUTION rather than about
 * string building. The path helpers are one `describe`; the rest drive the real
 * store client, the real providers and the real registry.
 */

const ENV = "test";
const SLUG = "sheets";
const TOKEN = "TOKEN";

describe("the oauth kind: paths", () => {
  it("composes and round-trips through the same builder as static", () => {
    expect(oauthNamespace(ENV, SLUG)).toBe("/strad/test/mcp/sheets/oauth/");
    expect(staticNamespace(ENV, SLUG)).toBe("/strad/test/mcp/sheets/static/");
    expect(oauthParameterPath(ENV, SLUG, TOKEN)).toBe(
      "/strad/test/mcp/sheets/oauth/TOKEN",
    );
    // Both kinds come out of ONE builder, so a third could not be spelled
    // differently from the two that exist.
    for (const kind of SERVER_PARAM_KINDS) {
      expect(serverKindNamespace(ENV, SLUG, kind)).toBe(
        `/strad/test/mcp/sheets/${kind}/`,
      );
    }
  });

  it("orders a server's namespaces oauth-first, which is the resolution order", () => {
    expect(serverNamespaces(ENV, SLUG)).toEqual([
      oauthNamespace(ENV, SLUG),
      staticNamespace(ENV, SLUG),
    ]);
  });

  it("recognises exactly the two kinds a resolver reads", () => {
    expect(isServerParamKind("oauth")).toBe(true);
    expect(isServerParamKind("static")).toBe(true);
    // A typo'd kind is not a kind. Routing one would be worse than refusing it:
    // a human would believe a parked credential inert while it was injected.
    expect(isServerParamKind("statik")).toBe(false);
    expect(isServerParamKind("")).toBe(false);
  });
});

/** The exact shape `:render` hands back when it could not dereference. */
const UNRENDERED =
  '__REF__("//secretmanager.googleapis.com/projects/p/secrets/s/versions/1")';

describe("the oauth kind: layering", () => {
  it("lets the minted value win over the typed one", () => {
    expect(
      layerNamespaces([{ TOKEN: "minted" }, { TOKEN: "typed", OTHER: "x" }]),
    ).toEqual({ TOKEN: "minted", OTHER: "x" });
  });

  it("does NOT let an unusable higher layer shadow a working lower one", () => {
    // `resolve()` does not promise a value: a `:render` that could not
    // dereference hands the `__REF__` pointer back, and an empty payload
    // resolves to "". Taking either over a real credential would bake a
    // non-credential onto a container AND suppress the value that works.
    expect(layerNamespaces([{ TOKEN: UNRENDERED }, { TOKEN: "real" }])).toEqual(
      { TOKEN: "real" },
    );
    expect(layerNamespaces([{ TOKEN: "" }, { TOKEN: "real" }])).toEqual({
      TOKEN: "real",
    });
  });

  it("keeps an unusable value when no layer has a better one", () => {
    // Kept rather than dropped, so `substitutionBag` can still report it BY
    // NAME. A name that vanished here would be reported as absent instead,
    // which is a different and less actionable diagnosis.
    expect(layerNamespaces([{ TOKEN: UNRENDERED }, {}])).toEqual({
      TOKEN: UNRENDERED,
    });
  });
});

// ---------------------------------------------------------------------------
// Resolution, through the real store client
// ---------------------------------------------------------------------------

const CONFIG_YAML = `
version: 1
gateway:
  name: strad
  env: ${ENV}
  publicUrl: https://strad.example
  secrets:
    provider: gcp-parameter-store
auth:
  staticTokens: { enabled: true, store: env }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: ${SLUG}
    kind: remote-http
    url: https://upstream.example/mcp
    entitlements: [admin]
    headers:
      Authorization: "Bearer \${TOKEN}"
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    params: true
    entitlements: [admin]
`;

const CONFIG = parseConfig(CONFIG_YAML);

describe("a server's ${NAME} resolves from the oauth kind", () => {
  it("injects a value the console minted, exactly as a static one", async () => {
    const gcp = createFakeGcp();
    // A SECRET parameter, which is what the consent flow writes: the value lives
    // in Secret Manager behind a `__REF__` pointer in Parameter Manager.
    await gcp.store.create({
      path: oauthParameterPath(ENV, SLUG, TOKEN),
      secret: true,
      value: "minted-by-the-console",
    });

    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: gcp.store,
    });
    expect(await providers.forServer(SLUG).get(TOKEN)).toBe(
      "minted-by-the-console",
    );
  });

  it("prefers the oauth kind over the same name under static", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: parameterPath(ENV, SLUG, TOKEN),
      secret: true,
      value: "typed-by-a-human-months-ago",
    });
    await gcp.store.create({
      path: oauthParameterPath(ENV, SLUG, TOKEN),
      secret: true,
      value: "minted-this-morning",
    });

    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: gcp.store,
    });
    // The fresh grant is the one a call should carry.
    expect(await providers.forServer(SLUG).get(TOKEN)).toBe(
      "minted-this-morning",
    );
  });

  it("still falls back to static, so a pre-existing credential keeps working", async () => {
    // THE MIGRATION PROPERTY. A deployment connected before this kind existed
    // has its token under `static/`, and nothing about this change may break it.
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: parameterPath(ENV, SLUG, TOKEN),
      secret: true,
      value: "seeded-before-the-oauth-kind",
    });

    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: gcp.store,
    });
    expect(await providers.forServer(SLUG).get(TOKEN)).toBe(
      "seeded-before-the-oauth-kind",
    );
  });

  it("prefers either of the slug's own kinds over the gateway namespace", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: `/strad/${ENV}/gateway/static/${TOKEN}`,
      secret: true,
      value: "the-shared-one",
    });
    await gcp.store.create({
      path: oauthParameterPath(ENV, SLUG, TOKEN),
      secret: true,
      value: "this-slug-alone",
    });

    const providers = buildSecretProviders({
      config: CONFIG,
      env: {},
      resolver: gcp.store,
    });
    expect(await providers.forServer(SLUG).get(TOKEN)).toBe("this-slug-alone");
    // The shared namespace is untouched for everyone else.
    expect(await providers.shared.get(TOKEN)).toBe("the-shared-one");
  });
});

describe("a params: true server takes BOTH kinds wholesale", () => {
  it("merges the oauth kind over the static one into a builtin's options", async () => {
    const gcp = createFakeGcp();
    // `greeting` is what the echo builtin reports back out of `ctx.options`, so
    // this is an end-to-end read: store -> registry parameter cache -> layered
    // merge -> the options a tool call actually sees.
    await gcp.store.create({
      path: parameterPath(ENV, "echo", "greeting"),
      secret: false,
      value: "typed-by-a-human",
    });
    await gcp.store.create({
      path: oauthParameterPath(ENV, "echo", "greeting"),
      secret: true,
      value: "minted-by-the-console",
    });

    const registry = await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: { STRAD_MODE: "core" },
      resolver: gcp.store,
    });

    const result = await registry.get("echo")!.callTool("whoami", {});
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text).greeting).toBe("minted-by-the-console");
    await registry.close();
  });

  it("still serves a static-only parameter when the oauth kind is empty", async () => {
    const gcp = createFakeGcp();
    await gcp.store.create({
      path: parameterPath(ENV, "echo", "greeting"),
      secret: false,
      value: "typed-by-a-human",
    });

    const registry = await Registry.build({
      config: CONFIG,
      secrets: sharedSecretProviders(new EnvSecretProvider({})),
      mode: "core",
      env: { STRAD_MODE: "core" },
      resolver: gcp.store,
    });

    const result = await registry.get("echo")!.callTool("whoami", {});
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text).greeting).toBe("typed-by-a-human");
    await registry.close();
  });
});
