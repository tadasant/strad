import { describe, expect, it } from "vitest";
import {
  argShape,
  byteSize,
  errorKind,
  resultShape,
} from "../src/telemetry/redact.ts";
import { identityFromEnv, serviceName } from "../src/telemetry/resource.ts";
import {
  readCgroupMemoryLimit,
  readCgroupMemoryUsage,
} from "../src/telemetry/runtime.ts";
import { startTelemetry } from "../src/telemetry/index.ts";

describe("telemetry no-ops cleanly when unconfigured", () => {
  // staging and prod are LIVE. The single most important property of this whole
  // change is that an unset OTEL_EXPORTER_OTLP_ENDPOINT is a fully supported
  // state that cannot break boot.

  it("starts disabled, and does not throw, when no endpoint is set", () => {
    const handle = startTelemetry({ env: {}, log: () => {} });
    expect(handle.enabled).toBe(false);
    expect(handle.memoryUtilization()).toBeNull();
  });

  it("shuts down without throwing when disabled", async () => {
    const handle = startTelemetry({ env: {}, log: () => {} });
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("survives a malformed endpoint rather than failing the boot", () => {
    // A typo'd endpoint in the app spec must degrade to "no telemetry", never to
    // "the gateway will not start". A deploy that takes strad down because the
    // collector URL had a stray space is a self-inflicted outage.
    const handle = startTelemetry({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "not a url at all" },
      log: () => {},
    });
    expect(() => handle.memoryUtilization()).not.toThrow();
  });
});

describe("service identity", () => {
  it("derives a per-component service name so 13 processes are distinguishable", () => {
    const core = identityFromEnv({ STRAD_MODE: "core" });
    expect(serviceName({}, core)).toBe("strad-core");

    const bundle = identityFromEnv({
      STRAD_MODE: "bundle",
      STRAD_COMPONENT: "bundle-fetchpet",
    });
    expect(serviceName({}, bundle)).toBe("strad-bundle-fetchpet");
  });

  it("lets OTEL_SERVICE_NAME win, because that is the standard knob", () => {
    const identity = identityFromEnv({ STRAD_COMPONENT: "bundle-fetchpet" });
    expect(serviceName({ OTEL_SERVICE_NAME: "strad" }, identity)).toBe("strad");
  });

  it("reads the environment and version an app spec injects", () => {
    const identity = identityFromEnv({
      STRAD_MODE: "bundle",
      STRAD_COMPONENT: "bundle-goodeggs",
      STRAD_ENV: "staging",
      STRAD_VERSION: "0.1.7",
    });
    expect(identity.environment).toBe("staging");
    expect(identity.version).toBe("0.1.7");
    expect(identity.component).toBe("bundle-goodeggs");
  });
});

describe("cgroup memory: the OOM predictor", () => {
  // This is the number the OOM killer actually consults. Getting it from
  // os.totalmem() instead would report the HOST's memory inside a 1GB container
  // and read ~4% utilisation while the kernel is about to kill you.

  it("reads a cgroup v2 limit", () => {
    const limit = readCgroupMemoryLimit((p) =>
      p === "/sys/fs/cgroup/memory.max" ? "1073741824\n" : null,
    );
    expect(limit).toBe(1_073_741_824);
  });

  it("treats cgroup v2 'max' as NO limit, not as a number", () => {
    // An unlimited container must read as "unknown", not as a fake limit that
    // makes utilisation look wonderful forever.
    const limit = readCgroupMemoryLimit((p) =>
      p === "/sys/fs/cgroup/memory.max" ? "max\n" : null,
    );
    expect(limit).toBeNull();
  });

  it("falls back to cgroup v1", () => {
    const limit = readCgroupMemoryLimit((p) =>
      p === "/sys/fs/cgroup/memory/memory.limit_in_bytes" ? "536870912" : null,
    );
    expect(limit).toBe(536_870_912);
  });

  it("treats cgroup v1's PAGE_COUNTER_MAX sentinel as NO limit", () => {
    // v1 reports "no limit" as a number near 2^63. Believing it would compute a
    // utilisation of 0.0000000006 and never alert on anything.
    const limit = readCgroupMemoryLimit((p) =>
      p === "/sys/fs/cgroup/memory/memory.limit_in_bytes"
        ? "9223372036854771712"
        : null,
    );
    expect(limit).toBeNull();
  });

  it("returns null when there is no cgroup at all (a dev laptop)", () => {
    expect(readCgroupMemoryLimit(() => null)).toBeNull();
    expect(readCgroupMemoryUsage(() => null)).toBeNull();
  });

  it("reads current usage", () => {
    const usage = readCgroupMemoryUsage((p) =>
      p === "/sys/fs/cgroup/memory.current" ? "545259520\n" : null,
    );
    // ~545MB — the known Chromium peak.
    expect(usage).toBe(545_259_520);
  });
});

describe("error classification records a KIND, never a message", () => {
  it("calls out the MCP SDK's 60s-at-every-hop timeout specifically", () => {
    expect(errorKind(new Error("Request timed out"))).toBe("timeout");
    expect(errorKind(new Error("MCP error -32001: Request timeout"))).toBe(
      "timeout",
    );
  });

  it("separates an unreachable upstream from a failing one", () => {
    expect(errorKind(new Error("fetch failed"))).toBe("upstream_unavailable");
    expect(errorKind(new Error("connect ECONNREFUSED 10.0.0.1:8080"))).toBe(
      "upstream_unavailable",
    );
  });

  it("classifies strad's own authorization refusals", () => {
    expect(
      errorKind(new Error('server "beta" is not selected for this request')),
    ).toBe("not_selected");
  });

  it("returns a fixed enum, so a secret in a message can never become a label", () => {
    // The whole point: whatever the upstream said, the ATTRIBUTE is one of a
    // closed set. A message containing a vault item cannot become a span tag.
    const kind = errorKind(
      new Error("failed: password=hunter2 token=sk-live-abcdef"),
    );
    expect(kind).toBe("unknown");
    expect([
      "timeout",
      "upstream_unavailable",
      "upstream_error",
      "not_selected",
      "not_mounted",
      "tool_error",
      "unknown",
    ]).toContain(kind);
  });
});

describe("shape helpers record size and count, never content", () => {
  it("counts arguments without naming or valuing them", () => {
    const shape = argShape({ password: "hunter2", vault: "op://x/y" });
    expect(shape["mcp.tool.arg_count"]).toBe(2);
    expect(shape["mcp.tool.args_bytes"]).toBeGreaterThan(0);

    // Nothing in the returned object may contain the values — or the KEYS.
    const serialized = JSON.stringify(shape);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("op://");
    expect(serialized).not.toContain("password");
  });

  it("describes a result by size and block count", () => {
    const shape = resultShape({
      content: [{ type: "text", text: "SECRET-VALUE" }],
      isError: false,
    });
    expect(shape["mcp.tool.result_blocks"]).toBe(1);
    expect(shape["mcp.tool.is_error"]).toBe(false);
    expect(JSON.stringify(shape)).not.toContain("SECRET-VALUE");
  });

  it("survives an unserializable payload instead of breaking the tool call", () => {
    // Telemetry must never be the reason a request fails.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(byteSize(cyclic)).toBe(0);
    expect(() => argShape(cyclic)).not.toThrow();
  });
});
