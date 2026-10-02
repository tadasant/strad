import { afterEach, describe, expect, it, vi } from "vitest";

import { startParamRefresh } from "../src/param-store.js";

/**
 * `servedAs` exists for the boot log alone: a `paramsRefresh:` plan names
 * GATEWAY slugs, and monarch's two slugs share one mount at `/monarch-money`.
 * Without the alias the log claims nothing reads a variable that a live-env
 * mount reads on every request — the one line an operator would trust.
 */
describe("startParamRefresh and gateway slugs served at another mount's path", () => {
  afterEach(() => vi.restoreAllMocks());

  function bootLog(mounts: Parameters<typeof startParamRefresh>[0]["mounts"]) {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startParamRefresh({
      mounts,
      env: {
        STRAD_PARAM_REFRESH: JSON.stringify({ "monarch-money-readwrite": ["MONARCH_COOKIE"] }),
      },
      clientFor: () => ({ get: async () => undefined, put: async () => {} }),
      timer: { set: () => 0, clear: () => {} },
    });
    expect(handle).not.toBeNull();
    return spy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  it("finds the mount through servedAs and reports it as reading per call", () => {
    const out = bootLog([
      { slug: "monarch-money", liveEnv: true, servedAs: ["monarch-money-readwrite"] },
    ]);
    expect(out).toContain("this mount reads its credential per call");
    expect(out).not.toContain("serves no mount");
  });

  it("without the alias, says no mount is served there", () => {
    const out = bootLog([{ slug: "monarch-money", liveEnv: true }]);
    expect(out).toContain("serves no mount at /monarch-money-readwrite");
  });
});
