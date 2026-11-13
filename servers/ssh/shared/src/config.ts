/**
 * What this server runs on, and the error a human gets when part of it is
 * missing.
 *
 * ONE HOST PER INSTANCE. Every value here describes a single machine: where it
 * is, who to log in as, the key to log in with, and the host key that machine
 * must present. strad serves one slug per host, and each slug is its own
 * instance of this server reading its own namespace, so nothing here is a list
 * and nothing is shared between hosts.
 *
 * EVERYTHING COMES FROM THE ENVIRONMENT IT IS HANDED. The bundle host passes an
 * injected view (a store-served instance's own namespace), never `process.env`
 * wholesale, and nothing in this tree reaches past
 * that view. That is what makes five hosts five independent instances in one
 * process.
 *
 * NO SSH AGENT, NO KEY FILE, NO PASSWORD. The upstream this replaces
 * (`ssh-agent-mcp-server`) authenticated through `SSH_AUTH_SOCK` or a key on the
 * local disk, because it ran on the user's laptop. A bundle container has
 * neither and must not grow either: the key arrives as a value, from the store,
 * and lives only in this process. `SSH_AUTH_SOCK` and `SSH_PRIVATE_KEY_PATH` are
 * deliberately not read.
 */
import ssh2 from "ssh2";
import { ConfigError } from "./errors.js";
import { parseHostKeyPins, type HostKeyPin } from "./host-key.js";
import {
  parseProxyAddress,
  TAILNET_SOCKS5_ENV,
  type ProxyAddress,
} from "./tailnet.js";

const { utils } = ssh2;

export const ENV = {
  host: "SSH_HOST",
  port: "SSH_PORT",
  username: "SSH_USERNAME",
  privateKey: "SSH_PRIVATE_KEY",
  passphrase: "SSH_PASSPHRASE",
  hostKey: "SSH_HOST_KEY",
  connectTimeout: "SSH_TIMEOUT",
  commandTimeout: "SSH_COMMAND_TIMEOUT",
  unreachableHint: "SSH_UNREACHABLE_HINT",
} as const;

/**
 * The four values without which there is no safe connection to make. The host
 * key is one of them: an instance with no pin is not "configured, unverified" —
 * it is unconfigured, because the only thing it could do is trust whatever
 * answered.
 */
export const SSH_REQUIRED_ENV_NAMES = [
  ENV.host,
  ENV.username,
  ENV.privateKey,
  ENV.hostKey,
] as const;

export const DEFAULT_PORT = 22;
/**
 * 15 s, half the upstream's 30. A powered-off droplet usually swallows the SYN
 * rather than refusing it, so an unreachable host costs every call the whole
 * timeout; an agent should learn "it is down" in seconds, not half a minute.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** The most `SSH_TIMEOUT` may be set to, in ms. */
export const MAX_CONNECT_TIMEOUT_MS = 120_000;
/** The longest `SSH_UNREACHABLE_HINT` that is kept, in characters. */
export const MAX_UNREACHABLE_HINT = 500;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export interface SshConfig {
  host: string;
  port: number;
  username: string;
  /** The private key, normalised to the text ssh2 parses. Secret. */
  privateKey: string;
  /** Secret, when the key is encrypted. */
  passphrase?: string;
  /** The key's algorithm, e.g. `ssh-ed25519`. Not secret; reported by connection info. */
  keyType: string;
  /** The host keys this machine may present. At least one. */
  hostKeyPins: HostKeyPin[];
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  /**
   * Why this host may be down, and how to bring it up — free text from the
   * slug's namespace, quoted in the unreachable error. Never consulted for
   * anything else: it cannot loosen the pin, the key or who may call.
   */
  unreachableHint?: string;
  /**
   * The bundle's tailnet SOCKS5 listener, when this container has tailnet
   * egress. Set by the bundle HOST (`STRAD_TAILNET_SOCKS5`), never by a slug's
   * namespace, and only ever used for a host that resolves into Tailscale's
   * ranges — see `tailnet.ts`.
   */
  tailnetProxy?: ProxyAddress;
}

/**
 * Where the values go. Repeated in every credential error because the error is
 * the only documentation an agent mid-call can see — and the fix is never
 * something the agent can do itself.
 */
export const HOW_TO_SEED =
  `Each value is a parameter in this slug's own namespace in strad's store ` +
  `(console: /ui/secrets, under the slug, static/<NAME>). ${ENV.privateKey} is ` +
  `the private key in OpenSSH or PEM format; ${ENV.hostKey} is the host's public ` +
  `key line, as printed by \`ssh-keyscan -p <port> <host>\` (verify it ` +
  `out of band) or a "SHA256:..." fingerprint. Only a human seeds these.`;

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

/** The required variables this instance is missing, in declaration order. */
export function missingCredentials(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return SSH_REQUIRED_ENV_NAMES.filter((name) => !present(env, name));
}

/**
 * A private key pasted into a single-line field arrives with literal `\n`
 * sequences, and one pasted as base64 (to survive a form that strips newlines)
 * arrives as one opaque run. Both are recovered here so a human does not have to
 * guess which shape the console wants. Anything else is passed through and
 * ssh2's parser decides.
 */
export function normalisePrivateKey(raw: string): string {
  let text = raw.trim();
  if (!text.includes("\n") && text.includes("\\n")) {
    text = text.split("\\n").join("\n");
  }
  if (!text.startsWith("-----BEGIN")) {
    const compact = text.replace(/\s+/g, "");
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
      const decoded = Buffer.from(compact, "base64").toString("utf8").trim();
      if (decoded.startsWith("-----BEGIN")) text = decoded;
    }
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function parseMs(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = 3_600_000,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > max) {
    throw new ConfigError(
      `${name} must be a whole number of milliseconds between 1000 and ${max}; got "${raw}".`,
    );
  }
  return n;
}

/**
 * One line of plain text, or nothing: control and format characters out (C0,
 * C1, line and paragraph separators, bidi overrides), length capped.
 */
export function parseHint(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return undefined;
  return text.length > MAX_UNREACHABLE_HINT
    ? `${text.slice(0, MAX_UNREACHABLE_HINT - 1)}…`
    : text;
}

/**
 * The whole configuration, validated, or a `ConfigError` that names every
 * problem it can see. Called per tool call rather than once, so a value seeded
 * after boot is picked up on the next call without a restart.
 *
 * The key is PARSED here, not on connect: a key that is truncated, encrypted
 * with no passphrase, or not a key at all is a configuration error, and saying
 * so before a TCP connection is opened keeps it from looking like the host
 * refused us.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SshConfig {
  const missing = missingCredentials(env);
  if (missing.length > 0) {
    throw new ConfigError(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set, so ` +
        `this SSH server will not connect. ${HOW_TO_SEED}`,
    );
  }

  const host = env[ENV.host]!.trim();
  const username = env[ENV.username]!.trim();

  let port = DEFAULT_PORT;
  const rawPort = env[ENV.port]?.trim();
  if (rawPort) {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new ConfigError(
        `${ENV.port} must be a port number from 1 to 65535; got "${rawPort}".`,
      );
    }
    port = n;
  }

  const passphrase = present(env, ENV.passphrase)
    ? env[ENV.passphrase]
    : undefined;
  const privateKey = normalisePrivateKey(env[ENV.privateKey]!);
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    // ssh2's parse errors describe the failure ("Encrypted private OpenSSH key
    // detected, but no passphrase given", "Unsupported key format"), never the
    // key, so the message is safe to pass on.
    throw new ConfigError(
      `${ENV.privateKey} could not be read as a private key: ${parsed.message}. ` +
        `It must be the full key, BEGIN and END lines included` +
        (passphrase
          ? ""
          : `, and ${ENV.passphrase} must be set if it is encrypted`) +
        `.`,
    );
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || !key.isPrivateKey()) {
    throw new ConfigError(
      `${ENV.privateKey} holds a PUBLIC key. It must be the private half — the ` +
        `public half goes in the host's authorized_keys.`,
    );
  }

  const hostKeyPins = parseHostKeyPins(env[ENV.hostKey]!, ENV.hostKey);

  return {
    host,
    port,
    username,
    privateKey,
    passphrase,
    keyType: key.type,
    hostKeyPins,
    // Capped at two minutes: a down host costs every call this long, and
    // core's default `timeoutMs` for a slug is 120 s.
    connectTimeoutMs: parseMs(
      env,
      ENV.connectTimeout,
      DEFAULT_CONNECT_TIMEOUT_MS,
      MAX_CONNECT_TIMEOUT_MS,
    ),
    commandTimeoutMs: parseMs(
      env,
      ENV.commandTimeout,
      DEFAULT_COMMAND_TIMEOUT_MS,
    ),
    unreachableHint: parseHint(env[ENV.unreachableHint]),
    tailnetProxy: parseProxyAddress(env[TAILNET_SOCKS5_ENV]),
  };
}
