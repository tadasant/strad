import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/load.ts";
import {
  BUNDLE_LIVENESS_CHECK,
  bundleHeapMiB,
  parseImage,
  renderAppSpec,
} from "../src/deploy/appspec.ts";

/**
 * The two things a `strad-bundle` component is rendered with so that one wedged
 * event loop cannot hold every slug on it down (tadasant/strad#458): a liveness
 * check that RESTARTS it, and an explicit V8 heap ceiling sized from its plan.
 *
 * The failure direction that matters most is the one that breaks an image this
 * repo did not build. A liveness check against an image with no `/healthz`
 * restarts it forever, so "off for anything else" is asserted as hard as "on
 * for the bundle".
 */

function spec(bundles: string, image: string, env = "") {
  const config = parseConfig(`
version: 1
gateway: { name: strad, env: staging }
auth: { staticTokens: { enabled: true } }
roles: { admin: { servers: ["*"] } }
bundles:
${bundles}
servers:
  - slug: thing
    kind: supplementary-image
    image: ${image}
    bundle: bundle
    entitlements: [admin]
${env}
`);
  const rendered = renderAppSpec({
    config,
    appName: "strad-staging",
    region: "nyc",
    image: parseImage("ghcr.io/tadasant/strad:sha-abc1234"),
    env: [],
  });
  const bundle = rendered.services.find((s) => s.name === "bundle");
  expect(bundle).toBeDefined();
  return bundle!;
}

const nodeOptions = (b: ReturnType<typeof spec>) =>
  b.envs.filter((e) => e.key === "NODE_OPTIONS").map((e) => e.value);

describe("renderAppSpec: bundle self-heal (#458)", () => {
  it("a strad-bundle component gets the liveness check and half its plan as heap", () => {
    const b = spec(
      "  - name: bundle\n    instanceSizeSlug: apps-s-1vcpu-2gb",
      "ghcr.io/tadasant/strad-bundle:latest",
    );
    expect(b.liveness_health_check).toEqual(BUNDLE_LIVENESS_CHECK);
    // Explicit, because the component has internal_ports and no http_port.
    expect(b.liveness_health_check!.port).toBe(8080);
    expect(b.liveness_health_check!.http_path).toBe("/healthz");
    expect(nodeOptions(b)).toEqual(["--max-old-space-size=1024"]);
    // A readiness check is NOT added: it would only take the one instance out
    // of rotation, which is the same outage, not a recovery.
    expect(b.health_check).toBeUndefined();
  });

  it("any other image gets neither, by default", () => {
    const b = spec(
      "  - name: bundle\n    instanceSizeSlug: apps-s-1vcpu-2gb",
      "ghcr.io/tadasant/strad-server-good-eggs:latest",
    );
    expect(b.liveness_health_check).toBeUndefined();
    expect(nodeOptions(b)).toEqual([]);
  });

  it("`liveness:` overrides the default in both directions", () => {
    const off = spec(
      "  - name: bundle\n    liveness: false",
      "ghcr.io/tadasant/strad-bundle:latest",
    );
    expect(off.liveness_health_check).toBeUndefined();
    const on = spec(
      "  - name: bundle\n    liveness: true",
      "ghcr.io/tadasant/strad-bundle-internal:latest",
    );
    expect(on.liveness_health_check).toEqual(BUNDLE_LIVENESS_CHECK);
    // Liveness opted in; the heap default still keys on the image alone.
    expect(nodeOptions(on)).toEqual([]);
  });

  it("a server's own NODE_OPTIONS wins over the rendered heap", () => {
    const b = spec(
      "  - name: bundle\n    instanceSizeSlug: apps-s-1vcpu-2gb",
      "ghcr.io/tadasant/strad-bundle:latest",
      '    env:\n      NODE_OPTIONS: "--max-old-space-size=1536"',
    );
    expect(nodeOptions(b)).toEqual(["--max-old-space-size=1536"]);
  });

  it("sizes the heap from the plan name, and declines one it cannot read", () => {
    expect(bundleHeapMiB("apps-s-1vcpu-0.5gb")).toBe(256);
    expect(bundleHeapMiB("apps-s-1vcpu-1gb")).toBe(512);
    expect(bundleHeapMiB("apps-s-1vcpu-2gb")).toBe(1024);
    expect(bundleHeapMiB("apps-s-2vcpu-4gb")).toBe(2048);
    expect(bundleHeapMiB("apps-d-4vcpu-16gb")).toBe(8192);
    expect(bundleHeapMiB("basic-xxs")).toBeNull();
  });
});
