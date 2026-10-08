import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  parseImage,
  renderAppSpec,
  type EnvVar,
} from "../src/deploy/appspec.ts";

/**
 * Telemetry has to reach the containers we actually care about.
 *
 * The trap this file exists to spring: a supplementary component (fetchpet,
 * bundle-google — the ones running Chromium and the `op` CLI) does NOT receive
 * the broadcast `env` list. It gets its own scoped secrets, and then only the
 * SECRET-typed entries of the shared env. That is correct for STRAD_CONFIG_YAML
 * and it is a disaster for OTEL_EXPORTER_OTLP_ENDPOINT, which is a GENERAL var:
 * without an explicit passthrough, telemetry would light up the core and every
 * strad-image bundle, and silently skip every container where the memory
 * actually lives.
 *
 * There is no error when you get this wrong. There is just a dashboard missing
 * the six components you built it for.
 */

const CONFIG = parseConfig(`
version: 1
gateway:
  name: strad
  env: staging
  publicUrl: https://staging.strad.tadasant.com
auth:
  staticTokens: { enabled: true }
roles:
  admin: { servers: ["*"] }
bundles:
  - name: bundle-echo
  - name: bundle-fetchpet
    instanceSizeSlug: apps-s-1vcpu-1gb
servers:
  - slug: echo
    kind: builtin
    module: "./servers/echo.js"
    bundle: core
    entitlements: [admin]
  - slug: bundled
    kind: builtin
    module: "./servers/echo.js"
    bundle: bundle-echo
    entitlements: [admin]
  - slug: fetchpet
    kind: supplementary-image
    image: ghcr.io/tadasant/strad-server-fetchpet:latest
    bundle: bundle-fetchpet
    entitlements: [admin]
    env:
      FETCHPET_USERNAME: "\${FETCHPET_USERNAME}"
`);

const TELEMETRY_ENV: EnvVar[] = [
  {
    key: "OTEL_EXPORTER_OTLP_ENDPOINT",
    value: "https://otlp.example.com",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
  {
    key: "OTEL_EXPORTER_OTLP_HEADERS",
    value: "Authorization=Bearer super-secret",
    scope: "RUN_TIME",
    type: "SECRET",
  },
  {
    key: "STRAD_CONFIG_YAML",
    value: "version: 1",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
  {
    key: "STRAD_CONFIG_YAML_GZ_B64",
    value: "H4sIAAAAAAAAAytLLSrOzM9TsFQwBAA6Ij1rCwAAAA==",
    scope: "RUN_TIME",
    type: "GENERAL",
  },
];

function render() {
  return renderAppSpec({
    config: CONFIG,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:0.1.7"),
    env: TELEMETRY_ENV,
    secrets: { FETCHPET_USERNAME: "someone" },
    domains: [{ domain: "staging.strad.tadasant.com", type: "PRIMARY" }],
  });
}

const envOf = (spec: ReturnType<typeof render>, name: string) =>
  spec.services.find((s) => s.name === name)!.envs;

const valueOf = (envs: EnvVar[], key: string) =>
  envs.find((e) => e.key === key)?.value;

describe("the OTLP endpoint reaches EVERY component", () => {
  it("reaches the core", () => {
    expect(
      valueOf(envOf(render(), "core"), "OTEL_EXPORTER_OTLP_ENDPOINT"),
    ).toBe("https://otlp.example.com");
  });

  it("reaches a strad-image bundle", () => {
    expect(
      valueOf(envOf(render(), "bundle-echo"), "OTEL_EXPORTER_OTLP_ENDPOINT"),
    ).toBe("https://otlp.example.com");
  });

  it("reaches a SUPPLEMENTARY image — the Chromium one, which is the whole point", () => {
    // This is the assertion that fails if someone removes TELEMETRY_ENV_KEYS.
    expect(
      valueOf(
        envOf(render(), "bundle-fetchpet"),
        "OTEL_EXPORTER_OTLP_ENDPOINT",
      ),
    ).toBe("https://otlp.example.com");
  });

  it("carries the OTLP auth header to a supplementary image as a SECRET", () => {
    const header = envOf(render(), "bundle-fetchpet").find(
      (e) => e.key === "OTEL_EXPORTER_OTLP_HEADERS",
    );
    expect(header?.type).toBe("SECRET");
    expect(header?.value).toBe("Authorization=Bearer super-secret");
  });

  it("still does NOT leak the gateway's config YAML into a supplementary image", () => {
    // The passthrough must be an ALLOWLIST, not "forward everything". A
    // supplementary image has no use for strad's server list, and widening the
    // filter to fix telemetry would have quietly broadcast it.
    expect(
      valueOf(envOf(render(), "bundle-fetchpet"), "STRAD_CONFIG_YAML"),
    ).toBeUndefined();
    // Nor its compressed form, which is the same document.
    expect(
      valueOf(envOf(render(), "bundle-fetchpet"), "STRAD_CONFIG_YAML_GZ_B64"),
    ).toBeUndefined();
  });

  it("does hand the compressed config to every component that runs strad", () => {
    // A strad-image bundle boots through the same loader as core. Without the
    // compressed form it would read the tripwire beside it and refuse to start.
    for (const name of ["core", "bundle-echo"]) {
      expect(
        valueOf(envOf(render(), name), "STRAD_CONFIG_YAML_GZ_B64"),
      ).toBeDefined();
    }
  });
});

describe("every component can name itself in telemetry", () => {
  it("gives each component its own STRAD_COMPONENT", () => {
    const spec = render();
    expect(valueOf(envOf(spec, "core"), "STRAD_COMPONENT")).toBe("core");
    expect(valueOf(envOf(spec, "bundle-echo"), "STRAD_COMPONENT")).toBe(
      "bundle-echo",
    );
    // A supplementary image has no STRAD_BUNDLE and could not otherwise say
    // which of the ~13 processes it is.
    expect(valueOf(envOf(spec, "bundle-fetchpet"), "STRAD_COMPONENT")).toBe(
      "bundle-fetchpet",
    );
  });

  it("reports service.version as the image tag that is actually deployed", () => {
    const spec = render();
    expect(valueOf(envOf(spec, "core"), "STRAD_VERSION")).toBe("0.1.7");
    // The supplementary image ships on its own release cadence, so it reports
    // ITS tag, not the core's.
    expect(valueOf(envOf(spec, "bundle-fetchpet"), "STRAD_VERSION")).toBe(
      "latest",
    );
  });

  it("propagates the deployment environment to every component", () => {
    const spec = render();
    for (const name of ["core", "bundle-echo", "bundle-fetchpet"]) {
      expect(valueOf(envOf(spec, name), "STRAD_ENV")).toBe("staging");
    }
  });
});

describe("adding telemetry does not delete anything (HACKS #18)", () => {
  it("still emits the custom domain", () => {
    // An App Platform spec update is a full REPLACE: an omitted field is a
    // deletion. This already took the staging domain down once. Telemetry is
    // strictly additive, and this is the tripwire that says so.
    expect(render().domains).toEqual([
      { domain: "staging.strad.tadasant.com", type: "PRIMARY" },
    ]);
  });

  it("still scopes a supplementary image's own secrets to its bundle", () => {
    const spec = render();
    expect(valueOf(envOf(spec, "bundle-fetchpet"), "FETCHPET_USERNAME")).toBe(
      "someone",
    );
    // ...and does not broadcast them to the core.
    expect(valueOf(envOf(spec, "core"), "FETCHPET_USERNAME")).toBeUndefined();
  });

  it("keeps the core public and the bundles internal-only", () => {
    const spec = render();
    const core = spec.services.find((s) => s.name === "core")!;
    const bundle = spec.services.find((s) => s.name === "bundle-fetchpet")!;
    expect(core.http_port).toBe(8080);
    expect(core.internal_ports).toBeUndefined();
    expect(bundle.internal_ports).toEqual([8080]);
    expect(bundle.http_port).toBeUndefined();
  });
});
