import { describe, expect, it } from "vitest";

import { redactSecrets, REDACTED } from "../src/secrets.js";
import { redact } from "../src/logging.js";
import { scrubber } from "../src/client.js";
import { TOKEN } from "./fake-hetzner.js";

describe("redactSecrets", () => {
  it("removes a credential field at any depth and leaves its neighbours", () => {
    expect(
      redactSecrets({
        root_password: "hunter2",
        action: { id: 1 },
        nested: [{ password: "x", wss_url: "wss://console", token_type: "a" }],
      }),
    ).toEqual({
      root_password: REDACTED,
      action: { id: 1 },
      nested: [{ password: REDACTED, wss_url: REDACTED, token_type: "a" }],
    });
  });

  it("keeps a null password null: no password was generated", () => {
    expect(redactSecrets({ root_password: null })).toEqual({
      root_password: null,
    });
  });

  it("leaves public keys and fingerprints alone", () => {
    const key = {
      public_key: "ssh-ed25519 " + "A".repeat(68) + " ci",
      fingerprint: "b7:2f:30",
    };
    expect(redactSecrets(key)).toEqual(key);
  });
});

describe("the token", () => {
  it("is scrubbed exactly, and its shape is a backstop", () => {
    expect(scrubber(TOKEN)(`x ${TOKEN} y`)).toBe("x [redacted] y");
    expect(redact(`Bearer ${TOKEN}`)).toBe("Bearer [redacted]");
    expect(redact("/servers/42/actions/13")).toBe("/servers/42/actions/13");
  });

  it("a short token is not used to shred messages", () => {
    expect(scrubber("abc")("abc abc")).toBe("abc abc");
  });
});
