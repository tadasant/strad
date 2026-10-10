import { describe, expect, it } from "vitest";

import {
  findRedactionMarkers,
  redactSecrets,
  redactUriPasswords,
  REDACTED,
  SECRET_KEY_NAME,
} from "../src/secrets.js";
import { tail } from "../src/tools/apps.js";
import { CLUSTER, DB_PASSWORD, USER_PASSWORD } from "./fake-do.js";

describe("redactSecrets", () => {
  it("removes every password a cluster read carries, at any depth", () => {
    const out = JSON.stringify(redactSecrets(CLUSTER));
    expect(out).not.toContain(DB_PASSWORD);
    expect(out).not.toContain(USER_PASSWORD);
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain("CERTIFICATE");
  });

  it("keeps how to reach the database", () => {
    const out = redactSecrets(CLUSTER);
    expect(out.connection.host).toBe(CLUSTER.connection.host);
    expect(out.connection.port).toBe(25060);
    expect(out.connection.user).toBe("doadmin");
    expect(out.connection.password).toBe(REDACTED);
    expect(out.connection.uri).toBe(
      `postgresql://doadmin:${REDACTED}@db-host.b.db.ondigitalocean.com:25060/defaultdb?sslmode=require`,
    );
    expect(out.users.map((u) => u.name)).toEqual([
      "doadmin",
      "app",
      "kafka-user",
    ]);
  });

  it("does not mutate its input", () => {
    redactSecrets(CLUSTER);
    expect(CLUSTER.connection.password).toBe(DB_PASSWORD);
  });

  it("leaves an empty or null password field as it is", () => {
    expect(redactSecrets({ password: "", other: { password: null } })).toEqual({
      password: "",
      other: { password: null },
    });
  });
});

describe("redactUriPasswords", () => {
  it("strips the password from any scheme and leaves user-only and plain URLs", () => {
    expect(redactUriPasswords("rediss://default:abc123@host:25061")).toBe(
      `rediss://default:${REDACTED}@host:25061`,
    );
    expect(redactUriPasswords("DATABASE_URL=mongodb+srv://u:p4ss@h/db x")).toBe(
      `DATABASE_URL=mongodb+srv://u:${REDACTED}@h/db x`,
    );
    expect(redactUriPasswords("https://user@host/x")).toBe(
      "https://user@host/x",
    );
    expect(redactUriPasswords("https://host:8080/x")).toBe(
      "https://host:8080/x",
    );
  });
});

describe("the credential key pattern", () => {
  it("catches a credential word at the end of a key, at a `_` boundary", () => {
    for (const key of [
      "password",
      "PASSWORD",
      "DATABASE_PASSWORD",
      "passwd",
      "secret",
      "client_secret",
      "token",
      "access_token",
      "GITHUB_TOKEN",
      "api_key",
      "apikey",
      "access_key",
      "access_cert",
      "private_key",
      "secret_key",
      "registry_credentials",
    ]) {
      expect(SECRET_KEY_NAME.test(key), key).toBe(true);
    }
  });

  it("does not catch a key that merely starts with or contains one", () => {
    for (const key of [
      "token_type",
      "tokens_count",
      "password_expires_at",
      "access_token_expires",
      "secrets_count",
      "mytoken",
      "SECRET_KEY_BASE",
      "key",
      "name",
    ]) {
      expect(SECRET_KEY_NAME.test(key), key).toBe(false);
    }
  });
});

describe("redactSecrets beyond the cluster connection", () => {
  it("redacts ui_connection and schema_registry_connection passwords", () => {
    const out = redactSecrets({
      ui_connection: {
        uri: "https://admin:uiPass1@ui-host:443",
        host: "ui-host",
        user: "admin",
        password: "uiPass1",
      },
      schema_registry_connection: {
        uri: "https://avnadmin:regPass2@sr-host:25065",
        password: "regPass2",
      },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("uiPass1");
    expect(text).not.toContain("regPass2");
    expect(out.ui_connection.host).toBe("ui-host");
    expect(out.ui_connection.user).toBe("admin");
  });

  it("redacts a Kafka user's access_cert and access_key", () => {
    const out = redactSecrets({
      users: [
        {
          name: "k",
          access_cert: "-----BEGIN CERTIFICATE-----x",
          access_key: "-----BEGIN PRIVATE KEY-----y",
        },
      ],
    });
    expect(out.users[0]).toEqual({
      name: "k",
      access_cert: REDACTED,
      access_key: REDACTED,
    });
  });

  it("redacts an app spec log destination's api_key and token", () => {
    const out = redactSecrets({
      log_destinations: [
        {
          name: "dd",
          datadog: { endpoint: "https://http-intake.dd", api_key: "ddKey" },
        },
        { name: "lt", logtail: { token: "ltToken" } },
        {
          name: "os",
          open_search: { basic_auth: { user: "u", password: "osPass" } },
        },
      ],
    });
    expect(out.log_destinations[0]!.datadog).toEqual({
      endpoint: "https://http-intake.dd",
      api_key: REDACTED,
    });
    expect(out.log_destinations[1]!.logtail).toEqual({ token: REDACTED });
    expect(JSON.stringify(out)).not.toContain("osPass");
  });

  it("redacts a whole registry_credentials value", () => {
    const out = redactSecrets({
      image: { registry: "r", registry_credentials: "user:ghp_secret" },
    });
    expect(out.image).toEqual({
      registry: "r",
      registry_credentials: REDACTED,
    });
  });

  it("redacts a GENERAL env var's value when its key names a credential", () => {
    const out = redactSecrets({
      envs: [
        { key: "STRIPE_SECRET", value: "sk_live_1", type: "GENERAL" },
        { key: "GITHUB_TOKEN", value: "ghp_2", scope: "RUN_TIME" },
        { key: "DB_PASSWORD", value: "pw3" },
        { key: "LOG_LEVEL", value: "debug", type: "GENERAL" },
        { key: "TOKEN_TYPE", value: "bearer" },
        { key: "API_KEY", value: "EV[1:abc:def]", type: "SECRET" },
        { key: "ODD", value: "plain-but-secret", type: "SECRET" },
      ],
    });
    expect(out.envs.map((e) => e.value)).toEqual([
      REDACTED,
      REDACTED,
      REDACTED,
      "debug",
      "bearer",
      "EV[1:abc:def]",
      REDACTED,
    ]);
    expect(out.envs[0]!.key).toBe("STRIPE_SECRET");
  });

  it("leaves a value DigitalOcean already encrypted untouched", () => {
    expect(redactSecrets({ password: "EV[1:a:b]" })).toEqual({
      password: "EV[1:a:b]",
    });
  });
});

describe("redactUriPasswords, the harder cases", () => {
  it("takes the password up to the LAST @ before the host", () => {
    expect(redactUriPasswords("postgres://u:p@ss@h/db")).toBe(
      `postgres://u:${REDACTED}@h/db`,
    );
    expect(redactUriPasswords("redis://u:a@b@c@host:6379")).toBe(
      `redis://u:${REDACTED}@host:6379`,
    );
  });

  it("does not run one URI into an @ further along a JSON line", () => {
    expect(
      redactUriPasswords('{"url":"redis://u:pw@h:6379","to":"a@b.com"}'),
    ).toBe(`{"url":"redis://u:${REDACTED}@h:6379","to":"a@b.com"}`);
  });

  it("redacts credential query parameters, and leaves others", () => {
    expect(
      redactUriPasswords(
        "postgres://h/db?user=u&password=s3cret&sslmode=require",
      ),
    ).toBe(`postgres://h/db?user=u&password=${REDACTED}&sslmode=require`);
    expect(
      redactUriPasswords(
        "jdbc:sqlserver://h;user=u;pwd=p1 next ?token=t2&api_key=k3&x=1",
      ),
    ).toBe(
      `jdbc:sqlserver://h;user=u;pwd=${REDACTED} next ?token=${REDACTED}&api_key=${REDACTED}&x=1`,
    );
    expect(
      redactUriPasswords('"https://h/?SSLPASSWORD=p4" and ?secret=p5\''),
    ).toBe(`"https://h/?SSLPASSWORD=${REDACTED}" and ?secret=${REDACTED}'`);
    expect(redactUriPasswords("https://h/?tokens=1&page=2")).toBe(
      "https://h/?tokens=1&page=2",
    );
  });
});

describe("findRedactionMarkers", () => {
  it("finds the marker in any string or key, at any depth, as a path", () => {
    expect(
      findRedactionMarkers(
        {
          name: "web",
          services: [
            {
              envs: [
                { key: "A", value: "ok" },
                { key: "DB", value: `postgres://u:${REDACTED}@h/db` },
              ],
            },
          ],
          [`x${REDACTED}`]: 1,
          alerts: [{ rule: REDACTED }],
        },
        "spec",
      ),
    ).toEqual([
      "spec.services[0].envs[1].value",
      `spec.x${REDACTED}`,
      "spec.alerts[0].rule",
    ]);
  });

  it("finds nothing in a clean spec", () => {
    expect(
      findRedactionMarkers({ a: [1, "b", { c: null, d: "EV[1:x]" }] }),
    ).toEqual([]);
  });
});

describe("tail", () => {
  const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n") + "\n";

  it("keeps the last lines and counts the dropped ones", () => {
    const out = tail(text, 3, 1000);
    expect(out.text).toBe("l7\nl8\nl9");
    expect(out).toMatchObject({
      total_lines: 10,
      returned_lines: 3,
      dropped_lines: 7,
    });
  });

  it("then trims from the front to fit the byte budget", () => {
    const out = tail(text, 10, 5);
    expect(out.text).toBe("l8\nl9");
    expect(out.returned_bytes).toBeLessThanOrEqual(5);
  });

  it("keeps the END of a single line longer than the budget", () => {
    const out = tail("a".repeat(100) + "END", 10, 10);
    expect(out.text.endsWith("END")).toBe(true);
    expect(out.returned_bytes).toBeLessThanOrEqual(10);
  });
});
