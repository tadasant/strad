import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import { parseImage, renderAppSpec } from "../src/deploy/appspec.ts";
import { slugEnvView } from "../src/secrets/env-prefix.ts";
import {
  connectorVariables,
  ownNamespaceNamesBySlug,
  unreadParameters,
} from "../src/deploy/server-namespaces.ts";

/**
 * THE DEPLOY-ORDERING ANSWER, as a test.
 *
 * There is a genuine cycle in this feature. `render-spec` exits 1 on the first
 * `${NAME}` it cannot resolve and it renders the WHOLE app spec, so a slug that
 * declared `${GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN}` before that token existed would
 * fail EVERY other server's deploy. But the token cannot exist until a human
 * completes the console consent flow, and the human cannot reach the console
 * flow until the slug is deployed and visible.
 *
 * The answer is that a connector's variables are never `${NAME}` references at
 * all: the renderer injects them from the slug's own namespace, each one only if
 * the store holds it. So the ordering is one-phase —
 *
 *   seed the client id and secret -> deploy (slug mounts, degraded)
 *   -> connect in the console -> next deploy picks the token up
 *
 * — and an unconnected slug costs its own capability and nobody else's. These
 * assertions are what stop that being quietly undone.
 */

const SHEETS_RO = "https://www.googleapis.com/auth/spreadsheets.readonly";
const IMAGE = "ghcr.io/tadasant/strad-bundle:1.0.0";

const CONFIG = parseConfig(`
version: 1
gateway:
  name: strad
  env: prod
  publicUrl: https://strad.example
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle
servers:
  - slug: google-sheets-personal-ro
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /google-sheets-personal-ro
    entitlements: [admin]
    oauth:
      provider: google
      account: personal@example.com
      scopes: [${SHEETS_RO}]
  - slug: google-sheets-personal-rw
    kind: supplementary-image
    image: ${IMAGE}
    bundle: bundle
    path: /google-sheets-personal-rw
    entitlements: [admin]
    oauth:
      provider: google
      account: personal@example.com
      scopes: [https://www.googleapis.com/auth/spreadsheets]
`);

const render = (serverSecrets: Record<string, Record<string, string>>) =>
  renderAppSpec({
    config: CONFIG,
    appName: "strad-prod",
    region: "nyc",
    image: parseImage("registry.example/strad:1.0.0"),
    env: [],
    serverSecrets,
  });

const bundleEnv = (
  spec: ReturnType<typeof renderAppSpec>,
): Record<string, string> => {
  const service = spec.services.find((s) => s.name === "bundle");
  if (!service) throw new Error("no bundle component");
  return Object.fromEntries(
    (service.envs ?? []).map((e) => [e.key, e.value ?? ""]),
  );
};

/**
 * What the MOUNT sees, which is not what the spec says.
 *
 * `slugEnvView` starts from the whole environment and OVERLAYS `<SLUG>__<NAME>`,
 * so a slug with no per-slug name of its own falls back to the bare one. Every
 * isolation claim in this file has to be asserted through here — asserting that
 * a slug's ALIAS is absent proves nothing about what its process reads.
 */
const mountSees = (
  spec: ReturnType<typeof renderAppSpec>,
  slug: string,
): Record<string, string | undefined> => slugEnvView(bundleEnv(spec), slug);

describe("a connector's variables are injected, never referenced", () => {
  it("renders a spec for a slug whose refresh token DOES NOT EXIST YET", () => {
    // The whole point. Two slugs, neither connected, and the deploy is fine.
    const spec = render({
      "google-sheets-personal-ro": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
      },
      "google-sheets-personal-rw": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
      },
    });
    const env = bundleEnv(spec);
    expect(env.GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID).toBe(
      "client-id",
    );
    // Absent, not empty: the mount degrades and says which variable is missing.
    expect(
      "GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN" in env,
    ).toBe(false);
  });

  it("renders a spec when NOTHING at all has been seeded", () => {
    // The very first deploy of a new slug, before the human has seeded even the
    // OAuth application. Still not a fleet-wide failure.
    expect(() => render({})).not.toThrow();
  });

  it("injects the token under the slug's OWN name, and never under the bare one", () => {
    const spec = render({
      "google-sheets-personal-ro": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "ro-refresh",
      },
    });
    const env = bundleEnv(spec);
    expect(
      env.GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBe("ro-refresh");

    // THE BARE NAME IS EMPTY, AND THAT IS THE POINT. The bundle host falls back
    // to it for any slug without an alias, so a connector credential sitting
    // there is a credential every sibling on the bundle inherits.
    expect("GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN" in env).toBe(false);
    expect("GOOGLE_SHEETS_OAUTH_CLIENT_SECRET" in env).toBe(false);

    // And the slug that owns it still reads it, through the view its host uses.
    expect(
      mountSees(spec, "google-sheets-personal-ro")
        .GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBe("ro-refresh");
  });

  it("gives two slugs on one bundle their own tokens, connected independently", () => {
    const spec = render({
      "google-sheets-personal-ro": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "ro-refresh",
      },
      "google-sheets-personal-rw": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "rw-refresh",
      },
    });
    const env = bundleEnv(spec);
    expect(
      env.GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBe("ro-refresh");
    expect(
      env.GOOGLE_SHEETS_PERSONAL_RW__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBe("rw-refresh");
  });

  it("connects one slug without disturbing its unconnected sibling", () => {
    const spec = render({
      "google-sheets-personal-ro": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "ro-refresh",
      },
      "google-sheets-personal-rw": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
      },
    });
    const env = bundleEnv(spec);
    expect(
      env.GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBe("ro-refresh");
    expect(
      "GOOGLE_SHEETS_PERSONAL_RW__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN" in env,
    ).toBe(false);

    // THE ASSERTION THAT MATTERS. An absent alias is not isolation on its own —
    // the host falls back to the bare name. The unconnected `-rw` slug's PROCESS
    // must see no refresh token at all, or it would come up holding its
    // sibling's while its console page said "not connected".
    expect(
      mountSees(spec, "google-sheets-personal-rw")
        .GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBeUndefined();
  });

  it("does not hand an unconnected READ-ONLY slug its read-write sibling's token", () => {
    // The escalation this whole design exists to prevent, in the exact shape the
    // six production slugs take: one OAuth app, one bundle, the same three
    // variable names, and only the write tier connected.
    const spec = render({
      "google-sheets-personal-rw": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "rw-WRITE-SCOPED-TOKEN",
      },
    });
    const ro = mountSees(spec, "google-sheets-personal-ro");
    expect(ro.GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN).toBeUndefined();
    expect(ro.GOOGLE_SHEETS_OAUTH_CLIENT_ID).toBeUndefined();
    expect(ro.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET).toBeUndefined();
    // The connected sibling is unaffected.
    expect(
      mountSees(spec, "google-sheets-personal-rw")
        .GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBe("rw-WRITE-SCOPED-TOKEN");
  });

  it("ships the credentials as SECRET vars on that bundle, not as a broadcast", () => {
    const spec = render({
      "google-sheets-personal-ro": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "ro-refresh",
      },
    });
    const service = spec.services.find((s) => s.name === "bundle")!;
    const token = (service.envs ?? []).find(
      (e) =>
        e.key ===
        "GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    );
    expect(token?.type).toBe("SECRET");

    // Not on core: a connector credential belongs to the container that serves
    // the slug, and core has no business holding a copy.
    const core = spec.services.find((s) => s.name === "core")!;
    expect(
      (core.envs ?? []).some((e) => e.key.includes("OAUTH_REFRESH_TOKEN")),
    ).toBe(false);
  });

  it("ignores an empty value rather than baking a non-credential", () => {
    const spec = render({
      "google-sheets-personal-ro": {
        GOOGLE_SHEETS_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "client-secret",
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "",
      },
    });
    expect(
      "GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN" in
        bundleEnv(spec),
    ).toBe(false);
  });

  it("never reads another slug's namespace for a connector variable", () => {
    // `serverSecrets` is keyed by slug and render-spec fills it from
    // /strad/{env}/mcp/{slug}/static/ alone. A value under the sibling is not a
    // value under this one.
    const spec = render({
      "google-sheets-personal-rw": {
        GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "rw-refresh",
      },
    });
    const env = bundleEnv(spec);
    expect(
      "GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN" in env,
    ).toBe(false);
    expect(
      mountSees(spec, "google-sheets-personal-ro")
        .GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN,
    ).toBeUndefined();
  });
});

describe("a seeded connector parameter is not reported as unread", () => {
  it("counts the three variables as names this slug's namespace serves", () => {
    const names = ownNamespaceNamesBySlug(CONFIG);
    expect([...(names.get("google-sheets-personal-ro") ?? [])].sort()).toEqual([
      "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
      "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
      "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    ]);
  });

  it("does not warn about the client id and secret a human was told to seed", () => {
    const findings = unreadParameters(
      CONFIG,
      new Map([
        [
          "google-sheets-personal-ro",
          [
            "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
            "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
          ],
        ],
      ]),
    );
    expect(findings).toEqual([]);
  });

  it("still warns about a variable this connector does not read", () => {
    const findings = unreadParameters(
      CONFIG,
      new Map([["google-sheets-personal-ro", ["GOOGLE_SHEETS_OAUTH_TYPO"]]]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("GOOGLE_SHEETS_OAUTH_TYPO");
    expect(findings[0]!.message).toContain("This server's connector reads");
  });

  it("names the three variables from the config, for every kind", () => {
    expect(connectorVariables(CONFIG.servers[0]!)).toEqual([
      "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
      "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
      "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    ]);
  });
});
