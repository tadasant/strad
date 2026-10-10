import type { LookupAddress } from "node:dns";
import dns from "node:dns";

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertFetchableUrl,
  blockedAddressReason,
  BlockedUrlError,
  createGuardedLookup,
  describeUrl,
  parseAllowedHosts,
} from "../src/url-guard.js";

const NONE = new Set<string>();

describe("assertFetchableUrl", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/a.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "javascript:alert(1)",
    "gopher://example.com/",
  ])("refuses the scheme of %s", (input) => {
    expect(() => assertFetchableUrl(input, NONE)).toThrow(
      /http and https only/,
    );
  });

  it("refuses a local path with a pointer to uploading it", () => {
    expect(() => assertFetchableUrl("/tmp/screenshot.png", NONE)).toThrow(
      /upload/,
    );
  });

  it.each([
    ["http://127.0.0.1/a.png", /loopback/],
    ["http://10.1.2.3/a.png", /private/],
    ["http://172.20.0.1/a.png", /private/],
    ["http://192.168.1.1/a.png", /private/],
    ["http://169.254.169.254/latest/meta-data/", /link-local/],
    ["http://100.64.0.1/a.png", /carrier-grade/],
    ["http://0.0.0.0/a.png", /this network/],
    ["http://[::1]/a.png", /loopback/],
    ["http://[fe80::1]/a.png", /link-local/],
    ["http://[fd00::1]/a.png", /unique-local/],
    ["http://[::ffff:127.0.0.1]/a.png", /IPv4-mapped/],
    ["http://2130706433/a.png", /loopback/], // decimal 127.0.0.1, normalised by URL
    ["http://localhost:8080/a.png", /loopback interface/],
    ["http://bundle:8080/mcp", /single-label/],
    ["http://metadata.google.internal/", /private networks/],
  ])("refuses %s", (input, why) => {
    expect(() => assertFetchableUrl(input, NONE)).toThrow(why);
  });

  it("refuses credentials embedded in the URL", () => {
    expect(() =>
      assertFetchableUrl("https://user:pw@example.com/a.png", NONE),
    ).toThrow(/credentials/);
  });

  it("accepts a public https URL", () => {
    expect(
      assertFetchableUrl(
        "https://storage.googleapis.com/b/o.png?X-Goog-Signature=abc",
        NONE,
      ).hostname,
    ).toBe("storage.googleapis.com");
  });

  it("lets the operator allowlist through, and only it", () => {
    const allowed = parseAllowedHosts(" 127.0.0.1 , Dev.Example. ");
    expect(() =>
      assertFetchableUrl("http://127.0.0.1:9/a.png", allowed),
    ).not.toThrow();
    expect(() =>
      assertFetchableUrl("http://127.0.0.2:9/a.png", allowed),
    ).toThrow(BlockedUrlError);
  });

  it("never quotes the query string — a signed link's signature is its credential", () => {
    try {
      assertFetchableUrl("http://10.0.0.1/o.png?X-Goog-Signature=SECRET", NONE);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRET");
    }
    expect(describeUrl(new URL("https://h.example/o.png?sig=SECRET"))).toBe(
      "https://h.example/o.png",
    );
  });
});

describe("the address tables", () => {
  // This guard's tables are derived from strad-fetch's. Two guards are two
  // places a fix must land; this is what notices when only one of them did.
  it("match strad-fetch's, block for block", () => {
    // Compared as data — every { cidr, why, offset, form } entry, in order — so
    // the two trees' formatters (quotes, wrapping) do not matter.
    const tables = (path: string) => {
      const text = readFileSync(new URL(path, import.meta.url), "utf8");
      const start = text.indexOf("const IPV4_BLOCKS");
      const block = text.slice(
        start,
        text.indexOf("/** Dotted-quad only", start),
      );
      return [
        ...block.matchAll(
          /cidr:\s*(['"])(.*?)\1|why:\s*(['"])(.*?)\3|offset:\s*(\d+)|form:\s*(['"])(.*?)\6/g,
        ),
      ].map((m) => m[2] ?? m[4] ?? m[5] ?? m[7]);
    };
    const ours = tables("../src/url-guard.ts");
    expect(ours.length).toBeGreaterThan(40);
    expect(ours).toEqual(
      tables("../../../strad-fetch/shared/src/scraping-client/url-guard.ts"),
    );
  });
});

describe("blockedAddressReason", () => {
  it("fails closed on something that is not an address", () => {
    expect(blockedAddressReason("not-an-ip")).toBe("not an IP address");
  });
  it("passes a public address", () => {
    expect(blockedAddressReason("8.8.8.8")).toBeNull();
    expect(blockedAddressReason("2606:4700::1111")).toBeNull();
  });
});

describe("createGuardedLookup", () => {
  const resolver = (addresses: LookupAddress[]) =>
    ((
      _host: string,
      _opts: unknown,
      cb: (e: null, a: LookupAddress[]) => void,
    ) => cb(null, addresses)) as unknown as typeof dns.lookup;

  const run = (addresses: LookupAddress[], allowed = NONE) =>
    new Promise<unknown>((resolve, reject) =>
      createGuardedLookup(allowed, resolver(addresses))(
        "img.example.com",
        { all: true },
        (err, result) => (err ? reject(err) : resolve(result)),
      ),
    );

  it("refuses a public name that resolves to a private address", async () => {
    await expect(run([{ address: "10.0.0.5", family: 4 }])).rejects.toThrow(
      /resolves to 10\.0\.0\.5/,
    );
  });

  it("refuses a record set with ONE private member rather than racing it", async () => {
    await expect(
      run([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("passes a public record set through", async () => {
    await expect(
      run([{ address: "93.184.216.34", family: 4 }]),
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});
