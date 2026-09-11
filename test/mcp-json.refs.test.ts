/**
 * SEP-2633's `${scheme:value}` interpolation, and what strad does with each form.
 *
 * The module under test is the credential-bearing half of the `mcp.json` input
 * dialect, so the cases that matter most here are the REFUSALS: every scheme and
 * shape the draft defines that strad cannot honour has to fail by name, because
 * the alternative is a reference silently shipped as literal text into an
 * `Authorization` header.
 */
import { describe, expect, it } from "vitest";
import {
  McpJsonError,
  rewriteInterpolations,
} from "../src/config/mcp-json-refs.ts";

const at = "mcpServers.x.headers.Authorization";

describe("mcp.json interpolation — what is rewritten", () => {
  it("turns ${env:NAME} into strad's own ${NAME}", () => {
    expect(rewriteInterpolations("${env:GRANOLA_TOKEN}", at)).toBe(
      "${GRANOLA_TOKEN}",
    );
  });

  it("rewrites in place, keeping the surrounding text", () => {
    expect(rewriteInterpolations("Bearer ${env:APIFY_TOKEN}", at)).toBe(
      "Bearer ${APIFY_TOKEN}",
    );
  });

  it("rewrites every occurrence, not just the first", () => {
    // The SEP allows multiple interpolations in one string, and the example it
    // gives is exactly this shape.
    expect(
      rewriteInterpolations(
        "postgresql://${env:PG_USER}:${env:PG_PASS}@host/db",
        at,
      ),
    ).toBe("postgresql://${PG_USER}:${PG_PASS}@host/db");
  });

  it("resolves ${value:...} to the literal, because a literal resolves to itself", () => {
    expect(rewriteInterpolations("X-${value:Team}-Key", at)).toBe("X-Team-Key");
  });

  it("leaves a string with no interpolation exactly as written", () => {
    expect(rewriteInterpolations("https://mcp.deepwiki.com/mcp", at)).toBe(
      "https://mcp.deepwiki.com/mcp",
    );
  });
});

describe("mcp.json interpolation — what is refused", () => {
  const refuses = (value: string, pattern: RegExp): void => {
    expect(() => rewriteInterpolations(value, at)).toThrow(McpJsonError);
    expect(() => rewriteInterpolations(value, at)).toThrow(pattern);
  };

  it("refuses the bare ${NAME} form, and names the fix", () => {
    // The likeliest paste: the Claude Code dialect, where the scheme is
    // implicit. Accepting it would make this dialect a third dialect.
    refuses("Bearer ${GITHUB_PAT}", /has no scheme.*\$\{env:GITHUB_PAT\}/s);
  });

  it("refuses a pipe chain, because strad resolves a reference once", () => {
    refuses("${env:FOO | value:bar}", /pipe-chained/);
  });

  it("refuses the input scheme — a boot has nobody to ask", () => {
    refuses("${input:github_pat}", /collect the value from a human/);
  });

  it("refuses an op:// URI rather than claiming a resolver it does not have", () => {
    refuses("${op://myVault/theItem/secret}", /`op` scheme is not one strad/);
  });

  it("refuses an unknown scheme by name", () => {
    refuses("${vault:secret/data/x}", /`vault` scheme is not one strad/);
  });

  it("refuses ${env:...} that does not name an environment variable", () => {
    refuses("${env:9LIVES}", /does not name an environment variable/);
  });

  it("refuses a ${value:...} literal carrying any of $, { or }", () => {
    // Spliced in, one of these can assemble a `${NAME}` nobody wrote, resolved
    // later by a renderer that cannot tell the difference — and the substring
    // `${` is not the thing to refuse, because the two characters can arrive
    // from two different places.
    refuses("${value:a$b}", /may not contain/);
    refuses("${value:a{b}", /may not contain/);
    refuses("${value:$}{SECRET}", /may not contain/);
    refuses("${value:$}${value:{SECRET}}", /may not contain/);
  });

  it("never echoes a payload in a refusal — a value: literal is a config literal", () => {
    for (const value of [
      "${env:FOO | value:hunter2}",
      "${hunter2 with a space}",
      "${env:hunter2-with-dash}",
      "${vault:hunter2}",
      "${value:hunter2$}",
    ]) {
      try {
        rewriteInterpolations(value, at);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toContain("hunter2");
      }
    }
  });

  it("refuses an unterminated interpolation", () => {
    refuses("Bearer ${env:TOKEN", /never closed/);
  });

  it("refuses an empty interpolation", () => {
    refuses("${}", /empty interpolation/);
  });

  it("names the field it refused, and never the value", () => {
    try {
      rewriteInterpolations("${input:x}", at);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message.startsWith(`${at}: `)).toBe(true);
    }
  });
});
