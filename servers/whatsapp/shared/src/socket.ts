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
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RawKey, RawMessage } from "./normalize.js";

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
  /**
   * Ask the phone to re-upload a media message whose CDN copy has expired.
   * Resolves with the same message, its `directPath` and `url` rewritten.
   */
  updateMediaMessage(message: RawMessage): Promise<RawMessage>;
  /** Ask the phone to resend one message; the answer arrives as `messages.upsert`. */
  requestPlaceholderResend(key: RawKey): Promise<string | undefined>;
  /**
   * Ask the phone for up to `count` messages OLDER than the given one; the
   * answer arrives as an ON_DEMAND `messaging-history.set`.
   */
  fetchMessageHistory(count: number, oldestMsgKey: RawKey, oldestMsgTimestampMs: number): Promise<string>;
  /**
   * Forget that a resend was asked for this message id. Baileys remembers
   * each ask for an hour and silently skips a repeat; the bridge forgets one
   * that went unanswered, so a retry once the phone is online asks again.
   */
  forgetPlaceholderResend(id: string): void;
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
 * (<os>)"`, a field only the code route sends — and the phone REFUSES a code
 * whose `os` it does not recognise, with nothing more specific than "Couldn't
 * link device". Baileys' own README allows a custom browser name for QR
 * pairing only. So the tuple is a real OS and a real browser, and the phone's
 * Linked devices list shows this device as Chrome on Mac OS.
 * `test/units.test.ts` pins it to the preset Baileys ships.
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
  const resends = new ExpiringCache(60 * 60_000);
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
    placeholderResendCache: resends as never,
  });
  return Object.assign(socket, {
    forgetPlaceholderResend: (id: string) => resends.del(id),
  }) as unknown as WaSocket;
};

/** Baileys' `CacheStore`, as a Map with a TTL, so an entry can be deleted from outside. */
class ExpiringCache {
  private readonly entries = new Map<string, { value: unknown; expires: number }>();

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T): void {
    for (const [k, v] of this.entries) if (v.expires <= Date.now()) this.entries.delete(k);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }
}

/**
 * Fetch and decrypt one media message from WhatsApp's CDN, refusing it once
 * it passes `maxBytes`. An HTTP failure rejects with the status on `status`
 * (404 and 410 mean the copy expired; see the bridge).
 */
export type MediaDownloader = (
  message: RawMessage,
  options: { signal: AbortSignal; maxBytes: number },
) => Promise<Buffer>;

export class MediaTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`media passed the cap at ${bytes} bytes`);
    this.name = "MediaTooLarge";
  }
}

/** AES-CBC pads to a 16-byte block, and WhatsApp appends a 10-byte MAC. */
const ENCRYPTION_OVERHEAD = 16 + 10;

/**
 * WHY NOT BAILEYS' `downloadMediaMessage`. In the pinned 7.0.0-rc14 it has
 * two defects this server cannot live with:
 *
 *   - its fetch takes no signal, and it decrypts with `fetched.pipe(output)`,
 *     which forwards no error from the SOURCE. A CDN connection that drops
 *     mid-file, or one abandoned on a timeout, emits an `error` nothing
 *     listens for — an uncaught exception in a process that hosts every other
 *     server in the bundle;
 *   - its `reuploadRequest` hook checks `error.status`, but its own Boom
 *     carries the code as `output.statusCode`, so an expired URL is never
 *     re-uploaded.
 *
 * So the transport is here, on Node's `fetch` with an AbortSignal, and every
 * failure is a rejection. What is Baileys' is the cryptography that defines
 * the format: `getMediaKeys` (the HKDF expansion per media type) and the
 * CDN host rule. This also checks what Baileys does not: the 10-byte MAC and
 * `fileEncSha256`, before a byte is decrypted. The bridge checks the
 * plaintext against `fileSha256`.
 */
export const cdnMediaDownloader: MediaDownloader = (message, options) =>
  createCdnMediaDownloader()(message, options);

/**
 * WhatsApp's media hosts, over TLS. The URL and host a media message names
 * were written by whoever SENT it, so without this a message could make this
 * container fetch any address it likes the moment someone reads its
 * "attachment".
 */
export function isWhatsAppCdn(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname === "whatsapp.net" || url.hostname.endsWith(".whatsapp.net"))
  );
}

/** The downloader, with the host rule injectable for a test's local CDN. */
export const createCdnMediaDownloader = (
  isAllowed: (url: URL) => boolean = isWhatsAppCdn,
): MediaDownloader => async (message, { signal, maxBytes }) => {
  const mod = await loadBaileys();
  const [kind, raw] = Object.entries(message.message ?? {})[0] ?? [];
  const body = (raw ?? {}) as {
    mediaKey?: Uint8Array;
    directPath?: string;
    url?: string;
    fileEncSha256?: Uint8Array;
  };
  if (!kind || !body.mediaKey) throw new Error("not a media message");
  const mediaType = kind.replace(/Message$/, "") as Parameters<BaileysModule["getMediaKeys"]>[1];
  const keys = await mod.getMediaKeys(body.mediaKey, mediaType);
  const iv = Buffer.from(keys.iv!);
  const cipherKey = Buffer.from(keys.cipherKey!);
  const macKey = Buffer.from(keys.macKey!);
  let host: string | undefined;
  try {
    host = body.url ? new URL(body.url).host : undefined;
  } catch {
    host = undefined;
  }
  const url = body.directPath ? mod.getUrlFromDirectPath(body.directPath, host) : body.url;
  if (!url) throw new Error("the message names no media URL");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the message names a media URL that does not parse");
  }
  if (!isAllowed(parsed)) {
    throw new Error("the message names a media host that is not WhatsApp's; not fetched");
  }

  // No redirects: a 3xx could leave WhatsApp's hosts after the check above.
  const response = await fetch(parsed, {
    headers: { Origin: mod.DEFAULT_ORIGIN },
    signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(`WhatsApp's media server answered ${response.status}`), {
      status: response.status,
    });
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes + ENCRYPTION_OVERHEAD) {
    await response.body.cancel().catch(() => {});
    throw new MediaTooLarge(declared);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes + ENCRYPTION_OVERHEAD) {
      await reader.cancel().catch(() => {});
      throw new MediaTooLarge(size);
    }
    chunks.push(Buffer.from(value));
  }
  const all = Buffer.concat(chunks);
  if (all.length < ENCRYPTION_OVERHEAD) throw new Error("the media file is truncated");
  if (body.fileEncSha256 && body.fileEncSha256.length) {
    const digest = createHash("sha256").update(all).digest();
    if (!digest.equals(Buffer.from(body.fileEncSha256))) {
      throw new Error("the encrypted file does not match its checksum");
    }
  }
  const enc = all.subarray(0, all.length - 10);
  const mac = all.subarray(all.length - 10);
  const expected = createHmac("sha256", macKey).update(Buffer.concat([iv, enc])).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, expected)) throw new Error("the media file failed its MAC check");
  const decipher = createDecipheriv("aes-256-cbc", cipherKey, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
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
