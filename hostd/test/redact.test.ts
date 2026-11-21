import { describe, expect, it } from "vitest";

import {
  credentialPageMatcher,
  DEFAULT_CREDENTIAL_PAGES,
  REDACTED,
  redactText,
  redactValue,
} from "../src/browser/redact.js";
import { testConfig } from "./helpers.js";

/** Deterministic pseudo-random strings (mulberry32), so a failure reproduces. */
function rand(alphabet: string, n: number, seed = 7): string {
  let a = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out += alphabet[Math.floor(r * alphabet.length)];
  }
  return out;
}
const HEX = "0123456789abcdef";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64 = ALNUM + "+/";

const gone = (input: string) => {
  const r = redactText(input);
  return { ...r, leaked: (v: string) => r.text.includes(v) };
};

describe("redacting token-shaped values", () => {
  it.each([
    ["GitHub classic", `ghp_${rand(ALNUM, 36)}`],
    ["GitHub fine-grained", `github_pat_11ABCDEFG0_${rand(ALNUM, 59)}`],
    ["Slack bot", `xoxb-1234567890-1234567890123-${rand(ALNUM, 24)}`],
    ["Slack user", `xoxp-1234567890-${rand(ALNUM, 30)}`],
    ["Slack app", `xapp-1-A0123-${rand(ALNUM, 30)}`],
    ["OpenAI", `sk-proj-${rand(ALNUM, 48)}`],
    ["Anthropic", `sk-ant-api03-${rand(ALNUM, 80)}`],
    ["OpenRouter", `sk-or-v1-${rand(HEX, 64)}`],
    ["GitLab", `glpat-${rand(ALNUM, 20)}`],
    ["Stripe", `sk_live_${rand(ALNUM, 24)}`],
    ["Linear", `lin_api_${rand(ALNUM, 40)}`],
    ["Sentry org token", `sntrys_${rand(B64, 60)}`],
    ["AWS key id", "AKIAIOSFODNN7EXAMPLE"],
    ["Google API key", `AIza${rand(ALNUM, 35)}`],
    ["npm", `npm_${rand(ALNUM, 36)}`],
    ["DigitalOcean", `dop_v1_${rand(HEX, 64)}`],
    [
      "JWT",
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${rand(ALNUM, 43)}`,
    ],
    // GlitchTip and legacy Sentry auth tokens: 64 hex, no prefix.
    ["GlitchTip / Sentry auth token", rand(HEX, 64)],
    ["base64 secret", rand(B64, 44) + "="],
  ])("%s", (_name, token) => {
    const r = gone(`Your token: ${token}  Created 2 days ago`);
    expect(r.leaked(token)).toBe(false);
    expect(r.text).toContain(REDACTED);
    expect(r.text).toContain("Created 2 days ago");
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  it("the incident: a GlitchTip auth-tokens list, as innerText", () => {
    const a = rand(HEX, 64, 1);
    const b = rand(HEX, 64, 2);
    const page = `Auth Tokens\nCreate New Token\n\n${a}\norg:admin project:read\nDelete\n\n${b}\nproject:read\nDelete`;
    const r = gone(page);
    expect(r.leaked(a)).toBe(false);
    expect(r.leaked(b)).toBe(false);
    expect(r.count).toBe(2);
    expect(r.text).toContain("org:admin project:read");
  });

  it("a DSN's key, and a URL's password", () => {
    const key = rand(HEX, 32);
    const dsn = `https://${key}@glitchtip.example.com/3`;
    const r = gone(`SENTRY_DSN=${dsn}`);
    expect(r.leaked(key)).toBe(false);
    expect(r.text).toContain(`https://${REDACTED}@glitchtip.example.com/3`);
    const pg = gone("postgres://app:hunter2hunter2@db.internal:5432/app");
    expect(pg.leaked("hunter2hunter2")).toBe(false);
    expect(pg.text).toContain("@db.internal:5432/app");
  });

  it("leaves a short bare URL user alone", () => {
    expect(redactText("ssh://git@github.com/o/r.git").count).toBe(0);
  });

  it("PEM blocks, whole or cut off", () => {
    const body = rand(B64, 64);
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n${body}\n-----END PRIVATE KEY-----`;
    const r = gone(`before\n${pem}\nafter`);
    expect(r.text).toBe(`before\n${REDACTED}\nafter`);
    const cut = gone(`x -----BEGIN RSA PRIVATE KEY-----\n${body}`);
    expect(cut.leaked(body)).toBe(false);
  });

  it("a value labelled as a credential, even short of the generic rules", () => {
    const v = rand(ALNUM, 20);
    for (const s of [
      `"api_key": "${v}"`,
      `Authorization: Bearer ${v}`,
      `client_secret=${v}`,
    ]) {
      const r = gone(s);
      expect(r.leaked(v), s).toBe(false);
    }
  });

  it.each([
    ["a git SHA", "commit 84f2992c0de5a1b2c3d4e5f60718293a4b5c6d7e"],
    ["a sha256 digest", `sha256:${rand(HEX, 64)}`],
    ["a UUID", "id 123e4567-e89b-12d3-a456-426614174000"],
    ["a slug", "/blog/how-to-reset-your-password-in-five-easy-steps-2024"],
    [
      "a long path",
      "/tadasant/strad/pull/534/files/src/browser/tools/Redact2.ts",
    ],
    ["CamelCase", "ThisIsAVeryLongCamelCaseIdentifierNameForTesting12"],
    [
      "prose about tokens",
      "Create a token to authenticate the CLI with your account.",
    ],
    ["a preview", "sk-or-v1-abc...xyz  Created just now"],
    ["a label next to a word", "Token authentication_documentation"],
  ])("leaves %s alone", (_name, s) => {
    expect(redactText(s)).toEqual({ text: s, count: 0 });
  });

  it("walks a JSON value, keys included, keeping what it is told to", () => {
    const t = `ghp_${rand(ALNUM, 36)}`;
    const r = redactValue(
      {
        rows: [{ name: "ci", value: t }],
        [t]: 1,
        n: 3,
        selector: `#${t}`,
      },
      new Set(["selector"]),
    );
    expect(JSON.stringify(r.value).split(t).length).toBe(2); // only the kept selector
    expect(r.value.selector).toBe(`#${t}`);
    expect(r.value.n).toBe(3);
    expect(r.count).toBe(2);
  });
});

describe("credential pages", () => {
  const match = credentialPageMatcher(DEFAULT_CREDENTIAL_PAGES);
  it.each([
    "https://app.glitchtip.com/profile/auth-tokens",
    "https://glitchtip.example.com/profile/auth-tokens/new",
    "https://pulsemcp.sentry.io/settings/account/api/auth-tokens/",
    "https://sentry.io/settings/pulsemcp/auth-tokens/",
    "https://github.com/settings/tokens",
    "https://github.com/settings/personal-access-tokens/new",
    "https://gitlab.com/-/user_settings/personal_access_tokens",
  ])("matches %s", (url) => expect(match(url)).toBeDefined());

  it.each([
    "https://github.com/settings/profile",
    "https://github.com/tadasant/strad",
    "https://app.glitchtip.com/pulsemcp/issues",
  ])("does not match %s", (url) => expect(match(url)).toBeUndefined());

  it("treats only * as special", () => {
    const m = credentialPageMatcher(["https://a.example/x?y=(1)"]);
    expect(m("https://a.example/x?y=(1)")).toBeDefined();
    expect(m("https://aXexample/x?y=(1)")).toBeUndefined();
  });

  it("is on by default and replaceable in config", () => {
    expect(testConfig().browser.credentialPages).toEqual(
      DEFAULT_CREDENTIAL_PAGES,
    );
    expect(
      testConfig({ browser: { credentialPages: [] } }).browser.credentialPages,
    ).toEqual([]);
  });
});
