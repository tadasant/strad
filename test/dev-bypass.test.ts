import { describe, expect, it } from "vitest";
import { devBypassStatus } from "../src/auth/dev.ts";
import { parseConfig } from "../src/config/load.ts";

const CFG = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: true, roles: [admin] }
roles:
  admin: { servers: ["*"] }
`);

const CFG_OFF = parseConfig(`
version: 1
gateway: { name: strad, env: test }
auth:
  staticTokens: { enabled: true }
  consoleDevBypass: { enabled: false }
roles: {}
`);

describe("console dev bypass gating", () => {
  it("is off when the config flag is off, regardless of env", () => {
    const s = devBypassStatus(CFG_OFF, {
      ALLOW_DEV_AUTH: "true",
      ALLOW_DEV_AUTH_IN_PRODUCTION: "true",
      ADMIN_BOOTSTRAP_TOKEN: "x",
    });
    expect(s.active).toBe(false);
  });

  it("is off unless ALLOW_DEV_AUTH is exactly 'true'", () => {
    for (const v of [undefined, "1", "TRUE", "true ", "yes"]) {
      const s = devBypassStatus(CFG, {
        ...(v === undefined ? {} : { ALLOW_DEV_AUTH: v }),
        ADMIN_BOOTSTRAP_TOKEN: "x",
      });
      expect(s.active, `ALLOW_DEV_AUTH=${v}`).toBe(false);
    }
  });

  it("is on in a non-prod env with the flag, ALLOW_DEV_AUTH and a bootstrap token", () => {
    const s = devBypassStatus(CFG, {
      ALLOW_DEV_AUTH: "true",
      ADMIN_BOOTSTRAP_TOKEN: "x",
    });
    expect(s.active).toBe(true);
  });

  it("FAILS CLOSED in production without the separate prod acknowledgement", () => {
    // The copy-staging-spec-to-prod hole: ALLOW_DEV_AUTH=true rides along, but
    // ALLOW_DEV_AUTH_IN_PRODUCTION does not. The bypass must NOT activate.
    const s = devBypassStatus(CFG, {
      NODE_ENV: "production",
      ALLOW_DEV_AUTH: "true",
      ADMIN_BOOTSTRAP_TOKEN: "x",
    });
    expect(s.active).toBe(false);
    expect(s.reason).toMatch(/ALLOW_DEV_AUTH_IN_PRODUCTION/);
  });

  it("activates in production only with BOTH acknowledgements (this is staging)", () => {
    const s = devBypassStatus(CFG, {
      NODE_ENV: "production",
      ALLOW_DEV_AUTH: "true",
      ALLOW_DEV_AUTH_IN_PRODUCTION: "true",
      ADMIN_BOOTSTRAP_TOKEN: "x",
    });
    expect(s.active).toBe(true);
  });

  it("is off without a bootstrap token even when everything else lines up", () => {
    const s = devBypassStatus(CFG, {
      NODE_ENV: "production",
      ALLOW_DEV_AUTH: "true",
      ALLOW_DEV_AUTH_IN_PRODUCTION: "true",
    });
    expect(s.active).toBe(false);
  });
});
