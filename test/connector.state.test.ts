import { describe, expect, it } from "vitest";
import {
  consoleSessionsFromEnv,
  OAUTH_TX_COOKIE,
  SESSION_COOKIE,
  type OauthTxPayload,
} from "../src/auth/session.ts";
import {
  CONNECTOR_TX_COOKIE,
  CONNECTOR_TX_TTL_MS,
  consoleSessionId,
  readConnectorTx,
  type ConnectorTxPayload,
} from "../src/connectors/state.ts";
import type { Principal } from "../src/auth/index.ts";

/**
 * The in-flight authorization, and what it refuses.
 *
 * There is no server-side state in this flow, which is what makes it survive a
 * second replica and a redeploy — so everything a callback must not take from
 * the request is sealed into one cookie and verified on the way back. The cases
 * here are the ones a state implementation gets wrong: an expired transaction
 * that still verifies, a replay that is accepted twice, a payload that can be
 * edited, and — the subtle one — a sealed value from one flow being accepted by
 * another.
 */

const KEY = "a-console-session-secret-of-adequate-length";

const sessions = () => consoleSessionsFromEnv({ CONSOLE_SESSION_SECRET: KEY })!;

const PRINCIPAL: Principal = {
  kind: "google",
  id: "10928374650192837465",
  label: "tadas@tadasant.com",
  roles: ["admin"],
};

const payload = (
  overrides: Partial<ConnectorTxPayload> = {},
  now = Date.now(),
): ConnectorTxPayload => ({
  v: 1,
  state: "a-high-entropy-state-value-here",
  verifier: "a-pkce-verifier-of-adequate-length",
  slug: "google-sheets-tadas412-ro",
  env: "staging",
  provider: "google",
  terms: "",
  account: "tadas412@gmail.com",
  scopes: [
    "openid",
    "email",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  ],
  variable: "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
  sid: consoleSessionId(PRINCIPAL),
  next: "/ui/google-sheets-tadas412-ro",
  exp: now + CONNECTOR_TX_TTL_MS,
  ...overrides,
});

const cookie = (value: string, name = CONNECTOR_TX_COOKIE): string =>
  `${name}=${encodeURIComponent(value)}`;

describe("the sealed connector transaction", () => {
  it("round-trips every bound term", () => {
    const { connector } = sessions();
    const sealed = connector.seal(payload());
    const read = readConnectorTx(connector, cookie(sealed));
    expect(read).toMatchObject({
      slug: "google-sheets-tadas412-ro",
      env: "staging",
      account: "tadas412@gmail.com",
      variable: "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
      sid: "google:10928374650192837465",
    });
  });

  it("ANY replica can read a transaction ANY other replica sealed", () => {
    // The whole reason this is a cookie rather than a map: core may run more
    // than one instance, and a consent begun on one is finished on another as a
    // matter of routine. Two independently-constructed sealers over the same key
    // material stand in for two replicas.
    const replicaA = sessions();
    const replicaB = sessions();
    const sealed = replicaA.connector.seal(payload());
    expect(readConnectorTx(replicaB.connector, cookie(sealed))).not.toBeNull();
  });

  it("refuses an expired transaction", () => {
    const { connector } = sessions();
    const now = Date.now();
    const sealed = connector.seal(payload({ exp: now - 1 }, now));
    expect(readConnectorTx(connector, cookie(sealed), now)).toBeNull();
  });

  it("expires ten minutes after it was issued, not later", () => {
    const { connector } = sessions();
    const now = Date.now();
    const sealed = connector.seal(payload({}, now));
    expect(
      readConnectorTx(connector, cookie(sealed), now + CONNECTOR_TX_TTL_MS - 1),
    ).not.toBeNull();
    expect(
      readConnectorTx(connector, cookie(sealed), now + CONNECTOR_TX_TTL_MS + 1),
    ).toBeNull();
  });

  it("refuses a payload whose fields were edited", () => {
    const { connector } = sessions();
    const sealed = connector.seal(payload());
    const [body, mac] = sealed.split(".") as [string, string];
    const tampered = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as ConnectorTxPayload;
    // The attack this stops: point a transaction at another slug, or at another
    // variable in the same namespace.
    tampered.slug = "secrets";
    tampered.variable = "SECRETS_ADMIN_SERVICE_ACCOUNT_KEY_JSON";
    const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${mac}`;
    expect(readConnectorTx(connector, cookie(forged))).toBeNull();
  });

  it("refuses a transaction sealed under different key material", () => {
    const other = consoleSessionsFromEnv({
      CONSOLE_SESSION_SECRET: "a-completely-different-secret-value",
    })!;
    const sealed = other.connector.seal(payload());
    expect(readConnectorTx(sessions().connector, cookie(sealed))).toBeNull();
  });

  it("is DOMAIN-SEPARATED from the console login transaction and from the session", () => {
    // Same key material, three derived keys. A login transaction presented as a
    // connector transaction would be a payload naming a slug and a parameter,
    // signed by a flow that never considered either.
    const s = sessions();
    const loginTx: OauthTxPayload = {
      v: 1,
      state: "login-state",
      verifier: "login-verifier",
      next: "/ui",
      exp: Date.now() + 60_000,
    };
    expect(readConnectorTx(s.connector, cookie(s.tx.seal(loginTx)))).toBeNull();
    expect(
      readConnectorTx(s.connector, cookie(s.session.seal(payload()))),
    ).toBeNull();
    // And the reverse: a connector transaction is not a login transaction.
    expect(
      s.tx.unseal<ConnectorTxPayload>(s.connector.seal(payload())),
    ).toBeNull();
  });

  it("reads a shadowing cookie without being locked out by one", () => {
    // Anything that can set a cookie on a sibling subdomain can send a longer
    // Path, and RFC 6265 orders that one first. Taking only the first value
    // would be a lockout no human could clear.
    const { connector } = sessions();
    const sealed = connector.seal(payload());
    const header = `${CONNECTOR_TX_COOKIE}=garbage; ${cookie(sealed)}`;
    expect(readConnectorTx(connector, header)).not.toBeNull();
  });

  it("ignores the other console cookies entirely", () => {
    const { connector } = sessions();
    const sealed = connector.seal(payload());
    expect(
      readConnectorTx(
        connector,
        `${SESSION_COOKIE}=x; ${OAUTH_TX_COOKIE}=y; ${cookie(sealed)}`,
      ),
    ).not.toBeNull();
  });
});

describe("binding to the initiating console session", () => {
  it("distinguishes the two console credentials, which mint ids from different spaces", () => {
    expect(consoleSessionId(PRINCIPAL)).toBe("google:10928374650192837465");
    expect(
      consoleSessionId({ ...PRINCIPAL, kind: "console-bypass", id: "admin" }),
    ).toBe("console-bypass:admin");
    // A Google `sub` that happened to equal a bypass id must not collide.
    expect(consoleSessionId({ ...PRINCIPAL, kind: "console-bypass" })).not.toBe(
      consoleSessionId(PRINCIPAL),
    );
  });
});
