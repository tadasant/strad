/**
 * What this server runs on, and the error a human gets when part of it is
 * missing.
 *
 * ONE HATCHBOX APP PER SLUG. `HATCHBOX_APP_ID` is the variable that makes an
 * instance — the bundle host mounts one for every slug that carries it under
 * its own name — and every other value describes that one app: its account,
 * its deploy webhook, the web server its puma runs on.
 *
 * THREE CREDENTIALS, THREE GROUPS OF TOOLS, CONFIGURED SEPARATELY. Hatchbox
 * issues three things that act on an app, and each one reaches exactly one
 * group of tools:
 *
 *   - the API key (with the account and app ids) — `setEnvVar`, `deleteEnvVars`
 *   - the deploy key — `triggerDeploy`, `checkDeploy`
 *   - an SSH key for the web server's `deploy` user — `getEnvVars`, `getEnvVar`
 *
 * A slug is given the credentials of the tools it is allowed, and no others,
 * so a read-only slug cannot write an env var even if the gateway's `tools:`
 * policy were removed: the key that would do it is not in its environment.
 * A tool whose credential is absent still LISTS, and its call fails naming the
 * variables — never an empty `tools/list` (pulsemcp/pulsemcp#3492).
 *
 * NO FLAG NARROWS THE SURFACE. The npm `hatchbox-mcp-server` gated its tools
 * on `READONLY` and `ALLOW_DEPLOYS` and on `WEB_SERVER_IP_ADDRESS` being set,
 * which is how a slug could come up with zero tools and nothing said so. In
 * strad, capability is the gateway's per-slug `tools:` policy. Those
 * variables are therefore REFUSED rather than ignored: a config carried over
 * with `READONLY=true` would otherwise look narrowed and not be.
 *
 * READ AT CALL TIME, NEVER AT BOOT. A missing credential is one failed tool
 * call, not a failed bundle.
 */
import ssh2 from "ssh2";
import { ConfigError } from "./errors.js";
import { parseHostKeyPins, type HostKeyPin } from "./host-key.js";

const { utils } = ssh2;

export const ENV = {
  appId: "HATCHBOX_APP_ID",
  accountId: "HATCHBOX_ACCOUNT_ID",
  apiKey: "HATCHBOX_API_KEY",
  deployKey: "HATCHBOX_DEPLOY_KEY",
  sshHost: "HATCHBOX_SSH_HOST",
  sshPort: "HATCHBOX_SSH_PORT",
  sshUsername: "HATCHBOX_SSH_USERNAME",
  sshPrivateKey: "HATCHBOX_SSH_PRIVATE_KEY",
  sshPassphrase: "HATCHBOX_SSH_PASSPHRASE",
  sshHostKey: "HATCHBOX_SSH_HOST_KEY",
  appName: "HATCHBOX_APP_NAME",
} as const;

/**
 * The variable that MAKES an instance of this server. Every slug sets it, of
 * whichever tier, and it is not a secret — which is what lets a deploy-only
 * slug and an SSH-only slug each be discovered without the other's key.
 */
export const HATCHBOX_ENV_NAMES = [ENV.appId] as const;

/** The secrets. A per-slug instance never inherits one of these from a sibling. */
export const HATCHBOX_CREDENTIAL_NAMES = [
  ENV.apiKey,
  ENV.deployKey,
  ENV.sshPrivateKey,
  ENV.sshPassphrase,
] as const;

/**
 * The upstream package's variables, which this server does not read and
 * refuses to run beside. `SSH_KEY_PATH` named a key FILE on the agent's disk;
 * here the key is a value (`HATCHBOX_SSH_PRIVATE_KEY`), as in strad's ssh
 * server. The two flags are replaced by the gateway's `tools:` policy.
 */
export const LEGACY_ENV: Readonly<Record<string, string>> = {
  READONLY:
    "a `tools:` allow list on the slug (strad's gateway enforces it on tools/list and tools/call), and leaving HATCHBOX_API_KEY out of a slug that must not write",
  ALLOW_DEPLOYS:
    "a `tools:` allow list on the slug, and leaving HATCHBOX_DEPLOY_KEY out of a slug that must not deploy",
  WEB_SERVER_IP_ADDRESS: `${ENV.sshHost}`,
  SSH_KEY_PATH: `${ENV.sshPrivateKey} (the key itself, not a path) and ${ENV.sshHostKey} (the server's pinned host key)`,
};

/** Every name this tree reads or refuses: what a per-slug view reads under its own name only. */
export const HATCHBOX_ALL_ENV_NAMES: readonly string[] = [
  ...Object.values(ENV),
  ...Object.keys(LEGACY_ENV),
];

export type ToolGroup = "ssh" | "api" | "deploy";

/** The variables each group of tools cannot run without, in the order an error names them. */
export const GROUP_REQUIRES: Readonly<Record<ToolGroup, readonly string[]>> = {
  ssh: [ENV.appId, ENV.sshHost, ENV.sshPrivateKey, ENV.sshHostKey],
  api: [ENV.appId, ENV.accountId, ENV.apiKey],
  deploy: [ENV.appId, ENV.deployKey],
};

/** Repeated in every credential error: the error is all an agent mid-call sees. */
export const HOW_TO_GET_IT: Readonly<Record<ToolGroup, string>> = {
  ssh:
    `${ENV.sshHost} is the web server's address. ` +
    `${ENV.sshPrivateKey} is a private key whose public half a human added to ` +
    `the server's deploy user. ` +
    `${ENV.sshHostKey} is the server's host key line from ` +
    `\`ssh-keyscan <host>\`, verified out of band, or its "SHA256:..." ` +
    `fingerprint. Set ${ENV.appName} when the server runs more than one app.`,
  api:
    `${ENV.apiKey} is an API key from the Hatchbox account settings. ` +
    `${ENV.accountId} and ${ENV.appId} are the ids in the account's and the ` +
    `app's URLs in Hatchbox.`,
  deploy:
    `${ENV.deployKey} is the app's deploy key, shown in the URL on its ` +
    `Repository tab in Hatchbox.`,
};

/** Where the values go, appended to every credential error. */
const WHERE =
  "These are set by a human in this strad deployment's secrets for this slug, " +
  "never passed in a tool call.";

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

/** The variables `group` is missing, in declaration order. */
export function missingFor(group: ToolGroup, env: Env): string[] {
  return GROUP_REQUIRES[group].filter((name) => value(env, name) === undefined);
}

/** The groups this environment configures. */
export function configuredGroups(env: Env): ToolGroup[] {
  return (Object.keys(GROUP_REQUIRES) as ToolGroup[]).filter(
    (group) => missingFor(group, env).length === 0,
  );
}

/** The upstream variables present in this environment, which make every call fail. */
export function legacyPresent(env: Env): string[] {
  return Object.keys(LEGACY_ENV).filter((name) => value(env, name) !== undefined);
}

/** The refusal for a slug carrying an upstream variable. Null when it carries none. */
export function legacyError(env: Env): ConfigError | null {
  const present = legacyPresent(env);
  if (present.length === 0) return null;
  return new ConfigError(
    `This slug sets ${present.join(" and ")}, which strad's Hatchbox server does ` +
      `not read, so every tool refuses until ${present.length === 1 ? "it is" : "they are"} ` +
      `removed. Instead of ` +
      present.map((name) => `${name}, use ${LEGACY_ENV[name]}`).join("; instead of ") +
      `.`,
  );
}

/**
 * Why this mount cannot serve ANY tool, or null when at least one group is
 * configured and nothing refuses. The bundle host reports it on /healthz.
 */
export function degradedReason(env: Env): string | null {
  const legacy = legacyPresent(env);
  if (legacy.length > 0) {
    return `${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} set, which this server refuses; every tool will fail`;
  }
  if (configuredGroups(env).length > 0) return null;
  const missing = [
    ...new Set((Object.keys(GROUP_REQUIRES) as ToolGroup[]).flatMap((g) => missingFor(g, env))),
  ];
  return `no tool group is configured (${missing.join(", ")} not set); every tool will fail`;
}

/** Account and app ids go into a URL path, so they are held to a path-safe shape. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Hatchbox's app names are slugs; the name goes into a pgrep pattern, so nothing else. */
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A deploy key goes into a URL path. Hatchbox's are URL-safe tokens. */
const DEPLOY_KEY = /^[A-Za-z0-9_-]{8,256}$/;

function requireGroup(group: ToolGroup, env: Env): void {
  const missing = missingFor(group, env);
  if (missing.length === 0) return;
  throw new ConfigError(
    `This Hatchbox slug is not configured for this tool: ${missing.join(", ")} ` +
      `${missing.length === 1 ? "is" : "are"} not set. ${HOW_TO_GET_IT[group]} ${WHERE}`,
  );
}

function id(env: Env, name: string): string {
  const v = value(env, name)!;
  if (!ID.test(v)) {
    throw new ConfigError(`${name} must be the id from the app's Hatchbox URL (letters, digits, - or _).`);
  }
  return v;
}

export interface ApiConfig {
  accountId: string;
  appId: string;
  /** Secret. */
  apiKey: string;
}

export interface DeployConfig {
  appId: string;
  /** Secret: it alone can deploy the app. */
  deployKey: string;
}

export interface SshConfig {
  appId: string;
  host: string;
  port: number;
  username: string;
  /** Normalised to the text ssh2 parses. Secret. */
  privateKey: string;
  /** Secret, when the key is encrypted. */
  passphrase?: string;
  hostKeyPins: HostKeyPin[];
  /** Narrows the puma process match to one app on a shared server. */
  appName?: string;
}

function refuseLegacy(env: Env): void {
  const error = legacyError(env);
  if (error) throw error;
}

export function loadApiConfig(env: Env): ApiConfig {
  refuseLegacy(env);
  requireGroup("api", env);
  return {
    accountId: id(env, ENV.accountId),
    appId: id(env, ENV.appId),
    apiKey: value(env, ENV.apiKey)!,
  };
}

export function loadDeployConfig(env: Env): DeployConfig {
  refuseLegacy(env);
  requireGroup("deploy", env);
  const deployKey = value(env, ENV.deployKey)!;
  if (!DEPLOY_KEY.test(deployKey)) {
    // Never quote it: it is the credential.
    throw new ConfigError(
      `${ENV.deployKey} is not a deploy key: it must be the last path segment of ` +
        `the app's deploy webhook URL (letters, digits, - or _), not the whole URL.`,
    );
  }
  return { appId: id(env, ENV.appId), deployKey };
}

/**
 * A private key pasted into a single-line field arrives with literal `\n`
 * sequences, and one pasted as base64 arrives as one opaque run. Both are
 * recovered, as strad's ssh server does.
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

/**
 * The SSH half, validated — the key PARSED before any connection is opened, so
 * a truncated or encrypted key is a configuration error and not a host refusal.
 */
export function loadSshConfig(env: Env): SshConfig {
  refuseLegacy(env);
  requireGroup("ssh", env);

  let port = 22;
  const rawPort = value(env, ENV.sshPort);
  if (rawPort) {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new ConfigError(`${ENV.sshPort} must be a port number from 1 to 65535; got "${rawPort}".`);
    }
    port = n;
  }

  const username = value(env, ENV.sshUsername) ?? "deploy";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) {
    throw new ConfigError(`${ENV.sshUsername} must be a Unix user name; got "${username}".`);
  }

  const host = value(env, ENV.sshHost)!;
  if (/[\s@/]/.test(host)) {
    throw new ConfigError(`${ENV.sshHost} must be a host name or IP address only, no user, port or path.`);
  }

  const appName = value(env, ENV.appName);
  if (appName !== undefined && !APP_NAME.test(appName)) {
    throw new ConfigError(
      `${ENV.appName} must be the app's name as Hatchbox shows it (letters, digits, ., - or _); got "${appName}".`,
    );
  }

  const passphrase = value(env, ENV.sshPassphrase);
  const privateKey = normalisePrivateKey(env[ENV.sshPrivateKey]!);
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    // ssh2's parse errors describe the failure, never the key.
    throw new ConfigError(
      `${ENV.sshPrivateKey} could not be read as a private key: ${parsed.message}. ` +
        `It must be the full key, BEGIN and END lines included` +
        (passphrase ? "" : `, and ${ENV.sshPassphrase} must be set if it is encrypted`) +
        `.`,
    );
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || !key.isPrivateKey()) {
    throw new ConfigError(
      `${ENV.sshPrivateKey} holds a PUBLIC key. It must be the private half; the ` +
        `public half goes on the server's deploy user.`,
    );
  }

  return {
    appId: id(env, ENV.appId),
    host,
    port,
    username,
    privateKey,
    ...(passphrase === undefined ? {} : { passphrase }),
    hostKeyPins: parseHostKeyPins(env[ENV.sshHostKey]!, ENV.sshHostKey),
    ...(appName === undefined ? {} : { appName }),
  };
}

/** Every secret value in this environment, for scrubbing results and errors. */
export function secretsIn(env: Env): string[] {
  const out: string[] = [];
  for (const name of HATCHBOX_CREDENTIAL_NAMES) {
    const v = value(env, name);
    if (v === undefined) continue;
    out.push(v);
    if (name === ENV.sshPrivateKey) out.push(normalisePrivateKey(v).trim());
  }
  return out;
}
