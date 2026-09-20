import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { CAPABILITY_IDS, type CapabilityId } from "./capabilities.js";

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
    windowSeconds: z.number().int().min(3).max(60).default(5),
    /**
     * What an unanswered dialog means. `deny` — fail closed — is the default:
     * nobody saw the request, so nobody agreed to it. `allow` turns the dialog
     * into a veto window, which is what unattended use needs; it is the owner's
     * decision and it is made here, in a file only they can write.
     */
    onTimeout: z.enum(["deny", "allow"]).default("deny"),
    /** How long after a rejection the same capability refuses new requests. */
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
      .object({ shell: CapabilityConfig, browser: CapabilityConfig })
      .default({}),
    consent: ConsentConfig,
    shell: ShellConfig,
    browser: BrowserConfig,
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

export function enabledCapabilities(cfg: Config): CapabilityId[] {
  return CAPABILITY_IDS.filter((id) => cfg.capabilities[id].enabled);
}
