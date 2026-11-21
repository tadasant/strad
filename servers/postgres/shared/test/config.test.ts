import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, missingCredentials, POSTGRES_ENV_NAMES, scrubber, secretsOf } from "../src/index.js";

const PASSWORD = "s3cr:t/p@ss%word";
const URI = `postgres://reader:${encodeURIComponent(PASSWORD)}@db.example.com:6543/app?sslmode=require`;

function refusal(uri: string): string {
  try {
    loadConfig({ DATABASE_URI: uri });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("configuration", () => {
  it("is one variable that makes an instance", () => {
    expect(POSTGRES_ENV_NAMES).toEqual(["DATABASE_URI"]);
    expect(missingCredentials({})).toEqual(["DATABASE_URI"]);
    expect(missingCredentials({ DATABASE_URI: "  " })).toEqual(["DATABASE_URI"]);
    expect(missingCredentials({ DATABASE_URI: URI })).toEqual([]);
  });

  it("parses the URI into its parts, decoding the password", () => {
    const c = loadConfig({ DATABASE_URI: URI });
    expect(c).toMatchObject({
      host: "db.example.com",
      port: 6543,
      database: "app",
      user: "reader",
      password: PASSWORD,
      sslmode: "require",
    });
    expect(loadConfig({ DATABASE_URI: "postgresql://u:p@h/d?sslmode=verify-full" }).port).toBe(5432);
  });

  it("requires TLS: sslmode require or stricter, and nothing weaker or absent", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      expect(loadConfig({ DATABASE_URI: `postgres://u:p@h/d?sslmode=${mode}` }).sslmode).toBe(mode);
    }
    expect(refusal("postgres://u:p@h/d")).toMatch(/must say sslmode=require/);
    for (const mode of ["disable", "allow", "prefer"]) {
      expect(refusal(`postgres://u:p@h/d?sslmode=${mode}`)).toMatch(/cleartext/);
    }
    expect(refusal("postgres://u:p@h/d?sslmode=bogus")).toMatch(/does not know/);
    expect(refusal("postgres://u:p@h/d?sslmode=require&sslmode=disable")).toMatch(/more than once/);
  });

  it("refuses parameters it does not read, by name", () => {
    expect(refusal("postgres://u:p@h/d?sslmode=require&sslrootcert=/x")).toMatch(/"sslrootcert"/);
    expect(refusal("postgres://u:p@h/d?sslmode=require&options=-c%20x")).toMatch(/"options"/);
  });

  it("refuses URIs that are not one host, one database, one user", () => {
    expect(refusal("mysql://u:p@h/d?sslmode=require")).toMatch(/postgres:\/\//);
    expect(refusal("postgres://u:p@h/?sslmode=require")).toMatch(/one database/);
    expect(refusal("postgres://:p@h/d?sslmode=require")).toMatch(/no user/);
    // No password would fall back to PGPASSWORD / ~/.pgpass: the bundle's, not the slug's.
    expect(refusal("postgres://u@h/d?sslmode=require")).toMatch(/no password/);
    expect(refusal("not a uri")).toMatch(/not a URI/);
  });

  it("never quotes the URI or the password back in a refusal", () => {
    for (const uri of [
      `postgres://reader:${encodeURIComponent(PASSWORD)}@h/d`,
      `postgres://reader:${encodeURIComponent(PASSWORD)}@h/d?sslmode=disable`,
      `postgres://reader:${encodeURIComponent(PASSWORD)}@h/d?sslmode=require&password=${encodeURIComponent(PASSWORD)}`,
      `postgres://reader:${encodeURIComponent(PASSWORD)}@h/?sslmode=require`,
    ]) {
      const message = refusal(uri);
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain(encodeURIComponent(PASSWORD));
      expect(message).not.toContain(uri);
    }
  });

  it("accepts a PEM CA certificate and refuses anything else there", () => {
    const pem = "-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----";
    const c = loadConfig({ DATABASE_URI: URI, DATABASE_CA_CERT: pem });
    expect(c.ca).toContain("\nAAAA\n");
    expect(() => loadConfig({ DATABASE_URI: URI, DATABASE_CA_CERT: "nope" })).toThrow(/PEM/);
  });

  it("scrubs the URI, the password in both spellings, and any other URI's password", () => {
    const scrub = scrubber(secretsOf(loadConfig({ DATABASE_URI: URI })));
    const out = scrub(
      `uri=${URI} raw=${PASSWORD} enc=${encodeURIComponent(PASSWORD)} other=postgres://x:hunter22@elsewhere/db`,
    );
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(encodeURIComponent(PASSWORD));
    expect(out).not.toContain("hunter22");
    expect(out).toContain("postgres://x:[redacted]@elsewhere/db");
  });

  it("scrubs a password with quotes and backslashes in its JSON-escaped form too", () => {
    const pw = 'rd"pw\\x9zz';
    const scrub = scrubber(
      secretsOf(loadConfig({ DATABASE_URI: `postgres://u:${encodeURIComponent(pw)}@h/d?sslmode=require` })),
    );
    const out = scrub(JSON.stringify({ cell: `it is ${pw}` }));
    expect(out).toBe(JSON.stringify({ cell: "it is [redacted]" }));
  });
});
