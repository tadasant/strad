import { describe, expect, it } from "vitest";

import { enableCapability } from "../src/config.js";

const KEY = "fresh-key-0123456789abcdef0123456789abcdef";

describe("enabling a server in an existing config", () => {
  it("adds a server the config predates, named after the shell server's suffix", () => {
    const raw: Record<string, unknown> = {
      capabilities: {
        shell: { enabled: true, key: KEY, displayName: "shell-tadas-mbp" },
      },
    };
    expect(enableCapability(raw, "computer-headless", KEY)).toEqual({
      changed: true,
      displayName: "computer-use-tadas-mbp-headless",
    });
    expect(enableCapability(raw, "computer", KEY, "other")).toEqual({
      changed: true,
      displayName: "computer-use-other",
    });
    const caps = raw.capabilities as Record<string, { enabled: boolean }>;
    expect(caps["computer-headless"]!.enabled).toBe(true);
    expect(caps.computer!.enabled).toBe(true);
    expect(caps.shell!.enabled).toBe(true);
  });

  it("leaves a server its owner switched OFF switched off — a re-run of the installer must not re-enable it", () => {
    const raw: Record<string, unknown> = {
      capabilities: { computer: { enabled: false, key: KEY } },
    };
    expect(
      enableCapability(
        raw,
        "computer",
        "new-key-0123456789abcdef0123456789abcdef",
      ),
    ).toEqual({ changed: false });
    expect(raw).toEqual({
      capabilities: { computer: { enabled: false, key: KEY } },
    });
  });

  it("keeps an existing key rather than rotating it", () => {
    const raw: Record<string, unknown> = {
      capabilities: { shell: { enabled: true, key: KEY } },
    };
    expect(
      enableCapability(
        raw,
        "shell",
        "another-key-0123456789abcdef0123456789ab",
      ),
    ).toEqual({ changed: false });
    expect(
      (raw.capabilities as Record<string, { key: string }>).shell!.key,
    ).toBe(KEY);
  });
});
