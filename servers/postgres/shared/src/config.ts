/**
 * What this server runs on, and the error a human gets when it is missing.
 *
 * A SLUG IS ONE DATABASE. `DATABASE_URI` is a `postgres://` URI naming one
 * host, one database and one role, and the bundle host mounts one instance per
 * slug that carries it under its own name. The role is what decides what the
 * slug can see: this server adds no grants and cannot take any away, so the
 * role should be a read-only one (`pg_read_all_data`, or SELECT on what the
 * slug is for). Every guard in `query.ts` and `sql.ts` sits on top of that role,
 * not in place of it.
 *
 * TLS IS REQUIRED. The URI must say `sslmode=require`, `verify-ca` or
 * `verify-full`. Anything weaker — `disable`, `allow`, `prefer`, or no sslmode
 * at all, which libpq reads as `prefer` — is refused, because each of them can
 * send the password in cleartext. The modes mean what they mean in libpq, not
 * what node-postgres makes of them: `require` encrypts and does not verify the
 * certificate (a managed Postgres often presents one signed by a provider CA no
 * trust store carries), `verify-ca` checks the chain against
 * `DATABASE_CA_CERT`, and `verify-full` checks the chain and the host name.
 *
 * THE URI IS A SECRET, WHOLE. It carries the password, so no error built here
 * quotes it, or any part of its query string, back. A value we refuse is named
 * by its variable and the rule it broke.
 *
 * READ AT CALL TIME, NEVER AT BOOT. A missing credential is one failed tool
 * call, not a failed bundle; `tools/list` works with nothing configured.
 */

export const ENV = {
  uri: "DATABASE_URI",
  caCert: "DATABASE_CA_CERT",
} as const;

/**
 * The variables that MAKE an instance of this server: the URI alone. The
 * bundle host mounts a per-slug instance for every slug that carries it under
 * its own name.
 */
export const POSTGRES_ENV_NAMES = [ENV.uri] as const;

export type SslMode = "require" | "verify-ca" | "verify-full";

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Secret. Always present: a URI without one is refused. */
  password: string;
  sslmode: SslMode;
  /** PEM, for verify-ca / verify-full. Absent means the system trust store. */
  ca?: string;
  /** The raw URI, kept only so it can be scrubbed from anything we return. */
  uri: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Repeated in every credential error: the error is all an agent mid-call sees. */
export const HOW_TO_GET_IT =
  `${ENV.uri} is a postgres:// URI for a READ-ONLY role, with sslmode=require ` +
  `or stricter, e.g. postgres://reader:<password>@db.example.com:5432/app?sslmode=require. ` +
  `${ENV.caCert} (optional) is the server's CA certificate as PEM, for ` +
  `sslmode=verify-ca or verify-full. Both go into this deployment's secrets, ` +
  `not into a tool call.`;

const SSL_MODES: readonly SslMode[] = ["require", "verify-ca", "verify-full"];
const WEAK_SSL_MODES = ["disable", "allow", "prefer"];

/** Query parameters a URI may carry. Anything else is refused by NAME. */
const ALLOWED_PARAMS = new Set(["sslmode"]);

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** The required variables this deployment is missing, in declaration order. */
export function missingCredentials(env: Env = process.env): string[] {
  return POSTGRES_ENV_NAMES.filter((name) => value(env, name) === undefined);
}

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new ConfigError(`${ENV.uri} has a ${what} that is not valid percent-encoding.`);
  }
}

export function loadConfig(env: Env = process.env): PostgresConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(`Postgres is not configured: ${ENV.uri} is not set. ${HOW_TO_GET_IT}`);
  }
  const raw = value(env, ENV.uri)!;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${ENV.uri} is not a URI. ${HOW_TO_GET_IT}`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError(`${ENV.uri} must start postgres:// or postgresql://. ${HOW_TO_GET_IT}`);
  }
  if (!url.hostname) {
    throw new ConfigError(`${ENV.uri} names no host. ${HOW_TO_GET_IT}`);
  }
  if (url.hostname.includes(",")) {
    throw new ConfigError(`${ENV.uri} must name one host, not a list.`);
  }
  if (url.hash) {
    throw new ConfigError(`${ENV.uri} must not carry a fragment.`);
  }
  for (const name of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(name)) {
      throw new ConfigError(
        `${ENV.uri} carries the parameter "${name}", which this server does not ` +
          `accept. Only sslmode is read; the role, database and TLS settings are ` +
          `the whole configuration.`,
      );
    }
  }
  const modes = url.searchParams.getAll("sslmode");
  if (modes.length > 1) {
    throw new ConfigError(`${ENV.uri} gives sslmode more than once.`);
  }
  const mode = modes[0];
  if (mode === undefined) {
    throw new ConfigError(
      `${ENV.uri} must say sslmode=require (or verify-ca, verify-full). With no ` +
        `sslmode the connection may fall back to cleartext and send the password ` +
        `unencrypted.`,
    );
  }
  if (!SSL_MODES.includes(mode as SslMode)) {
    throw new ConfigError(
      WEAK_SSL_MODES.includes(mode)
        ? `${ENV.uri} says sslmode=${mode}, which can connect without TLS and send ` +
            `the password in cleartext. Use sslmode=require, verify-ca or verify-full.`
        : `${ENV.uri} has an sslmode this server does not know. Use require, ` +
            `verify-ca or verify-full.`,
    );
  }
  const database = decode(url.pathname.replace(/^\//, ""), "database name");
  if (!database || database.includes("/")) {
    throw new ConfigError(`${ENV.uri} must name one database, e.g. .../app?sslmode=require.`);
  }
  const user = decode(url.username, "user name");
  if (!user) {
    throw new ConfigError(`${ENV.uri} names no user. ${HOW_TO_GET_IT}`);
  }
  const port = url.port === "" ? 5432 : Number(url.port);
  if (url.password === "") {
    // Without one, node-postgres falls back to PGPASSWORD and ~/.pgpass — the
    // whole bundle's environment, not this slug's.
    throw new ConfigError(`${ENV.uri} carries no password. ${HOW_TO_GET_IT}`);
  }
  const password = decode(url.password, "password");
  const ca = value(env, ENV.caCert);
  if (ca !== undefined && !ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new ConfigError(`${ENV.caCert} must be a PEM certificate (-----BEGIN CERTIFICATE-----).`);
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    database,
    user,
    password,
    sslmode: mode as SslMode,
    ...(ca === undefined ? {} : { ca: ca.replace(/\\n/g, "\n") }),
    uri: raw,
  };
}

/**
 * Everything secret this config carries, in every spelling it could come back
 * in: the URI as given, the password percent-encoded and decoded. A driver
 * error that quoted any of them is rewritten before it leaves the server.
 */
export function secretsOf(config: PostgresConfig): string[] {
  const out = new Set<string>([config.uri]);
  for (const form of [config.password, encodeURIComponent(config.password)]) {
    out.add(form);
    // Results are scrubbed after JSON serialisation, where a `"` or `\\` in the
    // password comes back escaped.
    out.add(JSON.stringify(form).slice(1, -1));
  }
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

/** Any secret this server knows of, and any URI-shaped credential, removed. */
export function scrubber(secrets: readonly string[]): (text: string) => string {
  return (text) => {
    let out = text;
    for (const s of secrets) out = out.split(s).join("[redacted]");
    // A postgres URI with a password in it that is NOT ours — one a query
    // returned, or a driver quoted after re-encoding — keeps its shape and
    // loses its password.
    return out.replace(/(postgres(?:ql)?:\/\/[^\s:@/]*:)[^\s@/]+@/gi, "$1[redacted]@");
  };
}
