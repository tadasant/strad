import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TAILNET_ENV_KEYS } from "../src/deploy/appspec.ts";

/**
 * The tailnet variables cross three npm trees and a shell script, and nothing
 * imports across them: the renderer names them (`src/deploy/appspec.ts`), the
 * image's entrypoint moves the key (`servers/bundle/scripts/boot.sh`), the
 * bundle host reads them and sets the proxy address
 * (`servers/bundle/host/src/tailnet.ts`), the host's instance allowlist lets
 * that address through (`servers/bundle/host/src/mounts.ts`), and the ssh tree
 * reads it (`servers/ssh/shared/src/tailnet.ts`). A drift in any one is a
 * green deploy whose every tailnet host answers "no tailnet egress". A grep is
 * the right strength for "these files still spell it the same way".
 */
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the tailnet variable names, across the trees", () => {
  it("the renderer reserves the names the host reads", () => {
    const host = read("servers/bundle/host/src/tailnet.ts");
    for (const name of TAILNET_ENV_KEYS)
      expect(host, name).toContain(`"${name}"`);
  });

  it("the proxy address is spelled the same by the host, its instance allowlist and the ssh tree", () => {
    for (const path of [
      "servers/bundle/host/src/tailnet.ts",
      "servers/bundle/host/src/mounts.ts",
      "servers/ssh/shared/src/tailnet.ts",
    ]) {
      expect(read(path), path).toContain('"STRAD_TAILNET_SOCKS5"');
    }
  });

  it("boot.sh hands over the key under the names the host reads", () => {
    const boot = read("servers/bundle/scripts/boot.sh");
    const host = read("servers/bundle/host/src/tailnet.ts");
    for (const name of [
      "STRAD_TAILNET_AUTHKEY",
      "STRAD_TAILNET_AUTHKEY_FILE",
    ]) {
      expect(boot, name).toContain(name);
      expect(host, name).toContain(`"${name}"`);
    }
  });

  it("the image starts through boot.sh", () => {
    expect(read("servers/bundle/Dockerfile")).toContain(
      'CMD ["/app/scripts/boot.sh"]',
    );
  });
});
