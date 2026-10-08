/**
 * The one place Baileys is imported, and the structural interface everything
 * above it drives.
 *
 * Baileys is loaded LAZILY (`import("baileys")`), because this tree is loaded
 * into every bundle container at boot and most of them never hold a WhatsApp
 * account: listing the tools must not cost them Baileys and its protobuf
 * tables. The tests implement `WaSocket` directly (test/fake-socket.ts), so the
 * bridge's lifecycle, pairing, buffering and sending are what the suite
 * exercises — not a mock of itself.
 *
 * WHY BAILEYS. WhatsApp's Cloud API is for business numbers and cannot join a
 * group a consumer created, so the only way to sit in an existing group chat is
 * as a LINKED DEVICE of a real account — the multi-device protocol WhatsApp Web
 * speaks. Baileys is that protocol in Node, which is the language of this repo.
 * It is unofficial, and so is everything built on it: see the README.
 */
import { installConsoleGuard } from "./logging.js";
import type { RawMessage } from "./normalize.js";

/** The subset of Baileys' auth state this server builds and persists. */
export interface AuthState {
  creds: Record<string, unknown> & {
    registered?: boolean;
    me?: { id?: string; lid?: string; name?: string } | null;
    account?: unknown;
  };
  keys: {
    get(type: string, ids: string[]): Promise<Record<string, unknown>>;
    set(data: Record<string, Record<string, unknown | null>>): Promise<void>;
  };
}

export interface ConnectionUpdate {
  connection?: "open" | "connecting" | "close";
  lastDisconnect?: { error?: unknown } | null;
  qr?: string;
  isNewLogin?: boolean;
}

export interface GroupInfo {
  id: string;
  subject?: string | null;
  size?: number | null;
  participants?: unknown[] | null;
}

type Handler = (payload: never) => void;

export interface WaSocket {
  ev: { on(event: string, handler: Handler): void };
  requestPairingCode(phoneNumber: string): Promise<string>;
  sendMessage(
    jid: string,
    content: { text: string },
    options?: { quoted?: RawMessage; messageId?: string },
  ): Promise<RawMessage | undefined>;
  sendPresenceUpdate(type: "composing" | "paused", jid: string): Promise<void>;
  groupFetchAllParticipating(): Promise<Record<string, GroupInfo>>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

export interface SocketOptions {
  auth: AuthState;
  /** [os, browser, os version]. Always `PAIRING_BROWSER`; see there. */
  browser: readonly [string, string, string];
  getMessage: (key: { id?: string | null }) => Promise<unknown>;
}

export type SocketFactory = (options: SocketOptions) => Promise<WaSocket>;

/**
 * Who this device says it is: Baileys' own `Browsers.macOS("Chrome")` preset,
 * restated so nothing above this file has to load Baileys to name it.
 *
 * It is NOT a place for a human-readable name. Baileys builds the pairing-code
 * request from this tuple — `companion_platform_display` is `"<browser>
 * (<os>)"` and the registration's `DeviceProps.os` is `os` — and the phone
 * REFUSES a code whose `os` it does not recognise, with nothing more specific
 * than "Couldn't link device". A QR scan does not check it, which is how a
 * custom name looked fine for so long. So the tuple is a real OS and a real
 * browser, and the phone's Linked devices list shows this device as Chrome on
 * Mac OS. `test/units.test.ts` pins it to the preset Baileys ships.
 */
export const PAIRING_BROWSER = ["Mac OS", "Chrome", "14.4.1"] as const;

/**
 * How long one QR ref lives before Baileys rotates to the next. The pairing
 * code is tied to the socket, not to a ref, so it outlives a rotation; a QR
 * does not, which is why `whatsapp_pair {"method":"qr"}` says how long is left.
 */
export const QR_REF_TTL_MS = 60_000;

/** Baileys' module, loaded once, on first need. */
type BaileysModule = typeof import("baileys");
let baileys: Promise<BaileysModule> | undefined;
export const loadBaileys = (): Promise<BaileysModule> => {
  // Before the import, so nothing libsignal prints can slip out first.
  installConsoleGuard();
  return (baileys ??= import("baileys"));
};

/** HTTP-ish status a Baileys disconnect carries (a Boom's `output.statusCode`). */
export function disconnectCode(error: unknown): number | undefined {
  const code = (error as { output?: { statusCode?: unknown } } | undefined)?.output
    ?.statusCode;
  return typeof code === "number" ? code : undefined;
}

/** Baileys' DisconnectReason, restated so nothing above this file imports it. */
export const DISCONNECT = {
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408,
  connectionClosed: 428,
  connectionReplaced: 440,
  badSession: 500,
  restartRequired: 515,
} as const;

/** A silent pino-shaped logger: Baileys at debug prints decrypted messages. */
const silent = {
  level: "silent",
  child: () => silent,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

export const createBaileysSocket: SocketFactory = async (options) => {
  const mod = await loadBaileys();
  const makeWASocket = mod.makeWASocket ?? mod.default;
  let version: [number, number, number] | undefined;
  try {
    // WhatsApp refuses a client version it considers too old (405). Asking
    // for the current web version on every connect is what keeps a pinned
    // Baileys connecting between releases; the bundled default is the fallback.
    const latest = await mod.fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5_000) });
    if (latest?.version) version = latest.version as [number, number, number];
  } catch {
    version = undefined;
  }
  const socket = makeWASocket({
    auth: options.auth as never,
    browser: [...options.browser],
    ...(version ? { version } : {}),
    logger: silent as never,
    // The phone keeps getting notifications: a linked device that marks the
    // account online suppresses them, which on a personal number means the
    // person stops being told about their own messages.
    markOnlineOnConnect: false,
    // Recent history, not the whole account. The buffer caps at 30 days anyway.
    syncFullHistory: false,
    // The pairing code lives as long as the socket waits for it; one minute
    // per ref instead of twenty seconds gives a human time to type it.
    qrTimeout: QR_REF_TTL_MS,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid: string) =>
      jid === "status@broadcast" ||
      jid.endsWith("@broadcast") ||
      jid.endsWith("@newsletter"),
    getMessage: options.getMessage as never,
  });
  return socket as unknown as WaSocket;
};

/**
 * A QR payload as a PNG, drawn in this process. The payload carries this
 * device's pairing keys, so it never goes to a QR-rendering service.
 */
export async function qrPng(payload: string): Promise<Buffer> {
  const { toBuffer } = await import("qrcode");
  return toBuffer(payload, { type: "png", errorCorrectionLevel: "M", margin: 4, scale: 8 });
}

/**
 * Baileys' auth state, in memory, with every change reported to `onChange` —
 * which is how it reaches GCS (the bridge debounces the writes).
 *
 * `serialize` / `deserialize` use Baileys' own BufferJSON, so the persisted
 * form is the one Baileys' file store writes, and a state can be moved between
 * the two by hand if ever needed.
 */
export interface MemoryAuth {
  state: AuthState;
  serialize(): string;
}

export async function createMemoryAuth(
  saved: string | null,
  onChange: () => void,
): Promise<MemoryAuth> {
  const mod = await loadBaileys();
  const parsed = saved
    ? (JSON.parse(saved, mod.BufferJSON.reviver) as {
        creds: AuthState["creds"];
        keys: Record<string, Record<string, unknown>>;
      })
    : null;
  const creds = parsed?.creds ?? (mod.initAuthCreds() as unknown as AuthState["creds"]);
  const keys: Record<string, Record<string, unknown>> = parsed?.keys ?? {};

  const state: AuthState = {
    creds,
    keys: {
      async get(type, ids) {
        const bucket = keys[type] ?? {};
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          let value = bucket[id];
          if (value === undefined) continue;
          if (type === "app-state-sync-key" && value) {
            value = mod.proto.Message.AppStateSyncKeyData.fromObject(
              value as Record<string, unknown>,
            );
          }
          out[id] = value;
        }
        return out;
      },
      async set(data) {
        for (const [type, entries] of Object.entries(data)) {
          const bucket = (keys[type] ??= {});
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value === null || value === undefined) delete bucket[id];
            else bucket[id] = value;
          }
        }
        onChange();
      },
    },
  };
  return {
    state,
    serialize: () => JSON.stringify({ creds, keys }, mod.BufferJSON.replacer),
  };
}
