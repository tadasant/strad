import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  CAPABILITY_DEFAULTS,
  CAPABILITY_IDS,
  slugFor,
  type CapabilityId,
} from "./capabilities.js";
import { keysMatch } from "./mcp/auth.js";

/**
 * The daemon's state directory: config, the kill-switch file, the audit log and
 * the control token. One directory, mode 0700, so "what does this thing keep on
 * my machine" has a one-line answer.
 */
export function stateDir(): string {
  return process.env.STRAD_HOSTD_HOME ?? join(homedir(), ".strad-hostd");
}

export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A bearer key short enough to guess is not a lock. */
export const MIN_KEY_LENGTH = 32;

const CapabilityConfig = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * The server's OWN bearer key — the second of the two locks, and the one
     * enforced on this machine. Per capability, so the key strad holds for the
     * browser slug opens nothing on the shell slug.
     */
    key: z.string().min(MIN_KEY_LENGTH).optional(),
    /**
     * The name the consent dialog shows: "Remote control requested by <name>".
     * Defaults to `<capability>-<machine>`; set it to the strad slug.
     */
    displayName: z.string().min(1).max(64).optional(),
    /**
     * What an unanswered dialog means for THIS server, in place of
     * `consent.onTimeout`. Unset, the machine-wide setting applies. It lets a
     * server whose consumer runs unattended — the read-only `messages` server
     * and its nightly sweep — be allowed on timeout without loosening the
     * shell or the computer-use servers with it.
     */
    onTimeout: z.enum(["deny", "allow"]).optional(),
    /**
     * Further keys for this server, by client name — one per local MCP
     * client, so several Claude Code sessions on this machine each hold their
     * own and the dialog and the status page say which one is asking.
     * `strad-hostd key add <server> <name>` mints one; `key revoke` drops it.
     * A client key opens exactly what `key` opens: this server, no other.
     */
    clientKeys: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
        z.string().min(MIN_KEY_LENGTH),
      )
      .default({}),
  })
  .default({ enabled: false });

const ConsentConfig = z
  .object({
    /**
     * `modal` stalls every `request_control` on an on-screen dialog. `none`
     * grants at once, and is refused outside stdio: a server reachable over a
     * network never runs without the gate.
     */
    mode: z.enum(["modal", "none"]).default("modal"),
    /** How long the dialog stays up, and so how long a request stalls. */
    windowSeconds: z.number().int().min(3).max(60).default(10),
    /**
     * What an unanswered dialog means. `deny` — fail closed — is the default:
     * nobody saw the request, so nobody agreed to it. `allow` turns the dialog
     * into a veto window, which is what unattended use needs; it is the owner's
     * decision and it is made here, in a file only they can write.
     */
    onTimeout: z.enum(["deny", "allow"]).default("deny"),
    /**
     * How long a capability refuses new requests, without a dialog, after the
     * owner kills one of its grants or answers "Disallow and cool down". A plain
     * Reject or an unanswered dialog starts none.
     */
    rejectCooldownSeconds: z.number().int().min(0).max(3600).default(60),
    grantMinutes: z.number().int().min(1).max(240).default(30),
    maxGrantMinutes: z.number().int().min(1).max(240).default(120),
    idleMinutes: z.number().int().min(1).max(240).default(10),
    maxActiveGrants: z.number().int().min(1).max(20).default(4),
  })
  .default({});

const ShellConfig = z
  .object({
    /** The shell a command runs under, as a login shell. Defaults per platform. */
    shell: z.string().min(1).optional(),
    /** Where a command runs when the caller names no `cwd`. Defaults to $HOME. */
    defaultCwd: z.string().min(1).optional(),
    /** A command still running after this is killed, whoever is waiting. */
    maxRuntimeSeconds: z.number().int().min(1).max(86_400).default(3600),
    /** Bytes of output kept per command: a head and a tail, the middle dropped. */
    maxCapturedBytes: z.number().int().min(4096).default(2_000_000),
    maxConcurrent: z.number().int().min(1).max(64).default(8),
  })
  .default({});

const BrowserConfig = z
  .object({
    /**
     * Chrome's user-data directory, where a Chrome with remote debugging
     * allowed writes `DevToolsActivePort`. Defaults to the platform's stock
     * Chrome location — i.e. the owner's real profile.
     */
    userDataDir: z.string().min(1).optional(),
    /** An explicit DevTools HTTP endpoint instead, e.g. http://127.0.0.1:9222. */
    cdpUrl: z.string().url().optional(),
  })
  .default({});

const NativeConfig = z
  .object({
    /**
     * How the daemon reaches the helper. `socket`: the LaunchAgent's socket,
     * and never a spawned child — the installer writes this once the agent is
     * in, so a daemon that boots before the helper waits for it rather than
     * spawning a private one whose grants would land on `node`. `stdio`: always
     * spawn. `auto`: the socket if it exists, else spawn.
     */
    mode: z.enum(["auto", "socket", "stdio"]).default("auto"),
    /**
     * Where `strad-hostd-ax` listens when it runs as its own LaunchAgent —
     * which is how it runs behind strad, because TCC attributes a process
     * launchd started to itself and a process node started to node. Defaults
     * to `ax.sock` in the state directory.
     */
    socketPath: z.string().min(1).optional(),
    /**
     * The helper binary, for the stdio (local-run) case where the daemon spawns
     * it as a child. Defaults to `bin/strad-hostd-ax` in the state directory,
     * then the package's own build, then `strad-hostd-ax` on PATH.
     */
    binary: z.string().min(1).optional(),
    /** How long one helper request may take. A stuck app must not stick the daemon. */
    requestTimeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
  })
  .default({});

const ComputerConfig = z
  .object({
    /** Widest screenshot the foreground server returns, in pixels. */
    maxScreenshotWidth: z.number().int().min(320).max(4096).default(1280),
  })
  .default({});

const MessagesConfig = z
  .object({
    /**
     * Where `strad-hostd-messages` listens when it runs as its own
     * LaunchAgent — which is how Full Disk Access lands on it and not on
     * `node`. Defaults to `messages.sock` in the state directory.
     */
    socketPath: z.string().min(1).optional(),
    /**
     * The helper binary, for the stdio (local-run) case. Defaults to
     * `bin/strad-hostd-messages` in the state directory, then the package's
     * own build, then `strad-hostd-messages` on PATH.
     */
    binary: z.string().min(1).optional(),
    /** The largest attachment `imessage_get_attachment` returns, after conversion. */
    maxAttachmentBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
  })
  .default({});

const CustodyConfig = z
  .object({
    /**
     * The strad deployment `deposit` posts to, e.g. "https://strad.example.com".
     * The deposit bearer is derived from THIS server's own key
     * (`capabilities.custody.key`, the one strad holds for the custody slug),
     * so nothing else needs configuring here. https only, but for loopback.
     * Unset, capture works and every deposit says so.
     */
    stradUrl: z
      .string()
      .url()
      .refine((u) => {
        const url = new URL(u);
        return (
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        );
      }, "stradUrl must be https (or http on loopback)")
      .optional(),
    /** Where Chrome saves downloads, for `capture_download`. Defaults to ~/Downloads. */
    downloadsDir: z.string().min(1).optional(),
    /** How long a captured secret is held before it is dropped undeposited. */
    handleMinutes: z.number().int().min(1).max(120).default(15),
  })
  .default({});

const TunnelConfig = z
  .object({
    /** Supervise `cloudflared` as a child, so one LaunchAgent runs everything. */
    enabled: z.boolean().default(false),
    /** A cloudflared config naming the tunnel, its credentials and the ingress. */
    configPath: z.string().min(1).optional(),
    binary: z.string().min(1).default("cloudflared"),
  })
  .default({});

export const ConfigSchema = z
  .object({
    /** Whose machine this is, for the dialog and for a caller's error text. */
    machine: z.string().min(1).max(64).default("this machine"),
    /** Loopback only. The tunnel is what reaches it; nothing else should. */
    port: z.number().int().min(1).max(65_535).default(7311),
    /** The status page and kill buttons. A SEPARATE listener the tunnel never routes. */
    controlPort: z.number().int().min(1).max(65_535).default(7312),
    capabilities: z
      .object({
        shell: CapabilityConfig,
        browser: CapabilityConfig,
        "computer-headless": CapabilityConfig,
        computer: CapabilityConfig,
        messages: CapabilityConfig,
        custody: CapabilityConfig,
      })
      .default({}),
    consent: ConsentConfig,
    shell: ShellConfig,
    browser: BrowserConfig,
    native: NativeConfig,
    computer: ComputerConfig,
    messages: MessagesConfig,
    custody: CustodyConfig,
    tunnel: TunnelConfig,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.port === cfg.controlPort) {
      ctx.addIssue({
        code: "custom",
        path: ["controlPort"],
        message:
          "controlPort must differ from port: the control page is only safe because the tunnel never routes to it",
      });
    }
    if (cfg.consent.grantMinutes > cfg.consent.maxGrantMinutes) {
      ctx.addIssue({
        code: "custom",
        path: ["consent", "grantMinutes"],
        message: "grantMinutes exceeds maxGrantMinutes",
      });
    }
    if (cfg.tunnel.enabled && !cfg.tunnel.configPath) {
      ctx.addIssue({
        code: "custom",
        path: ["tunnel", "configPath"],
        message: "tunnel.enabled needs tunnel.configPath",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  return process.env.STRAD_HOSTD_CONFIG ?? join(stateDir(), "config.json");
}

/** Read and validate the config file. A missing file is the all-defaults config. */
export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return ConfigSchema.parse({});
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`invalid config ${path}:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export function displayName(cfg: Config, id: CapabilityId): string {
  return cfg.capabilities[id].displayName ?? `${id}-hostd`;
}

/** What an unanswered dialog means for one server: its own setting, else the machine's. */
export function onTimeoutFor(cfg: Config, id: CapabilityId): "deny" | "allow" {
  return cfg.capabilities[id].onTimeout ?? cfg.consent.onTimeout;
}

export function enabledCapabilities(cfg: Config): CapabilityId[] {
  return CAPABILITY_IDS.filter((id) => cfg.capabilities[id].enabled);
}

/**
 * Enable a server in a RAW config object (the file's JSON, before parsing),
 * with a fresh key, and leave everything else alone. A server that already
 * has a key is left exactly as it is — enabled or, if its owner switched it
 * off, disabled; re-running the installer must not re-enable it. The display
 * name follows the existing shell server's suffix when none is given, so a
 * re-run without `--suffix` does not name the new server after the default.
 */
export function enableCapability(
  raw: Record<string, unknown>,
  id: CapabilityId,
  key: string,
  suffix?: string,
): { changed: boolean; displayName?: string } {
  const capabilities = (raw.capabilities ??= {}) as Record<
    string,
    | {
        enabled?: boolean;
        key?: string;
        displayName?: string;
        onTimeout?: "deny" | "allow";
      }
    | undefined
  >;
  const existing = capabilities[id];
  if (existing?.key) return { changed: false };
  const derived =
    suffix ??
    /^shell-(.+)$/.exec(capabilities.shell?.displayName ?? "")?.[1] ??
    undefined;
  const displayName = derived ? slugFor(id, derived) : existing?.displayName;
  capabilities[id] = {
    ...CAPABILITY_DEFAULTS[id],
    ...existing,
    enabled: true,
    key,
    ...(displayName ? { displayName } : {}),
  };
  ConfigSchema.parse(raw);
  return { changed: true, displayName };
}

/**
 * The client a presented key belongs to: the server's own key (strad's, or
 * whichever client holds it), or a named client key. Constant-time per
 * candidate; the set is small.
 */
export function matchKey(
  cap: Config["capabilities"][CapabilityId],
  presented: string,
): { ok: true; client?: string } | { ok: false } {
  if (cap.key && keysMatch(presented, cap.key)) return { ok: true };
  for (const [client, key] of Object.entries(cap.clientKeys)) {
    if (keysMatch(presented, key)) return { ok: true, client };
  }
  return { ok: false };
}

/**
 * Re-read every server's keys from the config file into a LIVE config, so a
 * key minted while the daemon runs works without a restart. Only the keys
 * move: everything else a running daemon holds was validated at boot and is
 * wired into listeners and the tunnel.
 */
export function reloadKeys(live: Config, path = configPath()): void {
  const fresh = loadConfig(path);
  for (const id of CAPABILITY_IDS) {
    live.capabilities[id].key = fresh.capabilities[id].key;
    live.capabilities[id].clientKeys = fresh.capabilities[id].clientKeys;
  }
}

/**
 * Add a client key to a RAW config object (the file's JSON). Refuses a name
 * already in use rather than rotating it silently: a session holding the old
 * key would fail with no line anywhere saying why.
 */
export function addClientKey(
  raw: Record<string, unknown>,
  id: CapabilityId,
  client: string,
  key: string,
): void {
  const capabilities = (raw.capabilities ??= {}) as Record<
    string,
    { clientKeys?: Record<string, string> } | undefined
  >;
  const cap = (capabilities[id] ??= {});
  const keys = (cap.clientKeys ??= {});
  if (keys[client])
    throw new Error(`${id} already has a key for "${client}"; revoke it first`);
  // Validated on a copy: a name or key the schema refuses must not be left
  // in the file's object for the next write to carry.
  ConfigSchema.parse({
    ...raw,
    capabilities: {
      ...capabilities,
      [id]: { ...cap, clientKeys: { ...keys, [client]: key } },
    },
  });
  keys[client] = key;
}

export function revokeClientKey(
  raw: Record<string, unknown>,
  id: CapabilityId,
  client: string,
): boolean {
  const cap = (
    raw.capabilities as
      | Record<string, { clientKeys?: Record<string, string> } | undefined>
      | undefined
  )?.[id];
  if (!cap?.clientKeys?.[client]) return false;
  delete cap.clientKeys[client];
  return true;
}
