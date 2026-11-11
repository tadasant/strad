/**
 * The bridge: ONE long-lived WhatsApp linked device, and everything it knows.
 *
 * It is a process-lifetime object, not a per-request one. The bundle host
 * builds a fresh MCP Server per HTTP request, but a linked device is a socket
 * that must stay open to receive messages at all — WhatsApp has no history API
 * a companion can call later, so a message nobody was connected for is a
 * message this server never knows about beyond what the phone chooses to
 * replay. So the socket, the Signal state and the buffer live here, and the
 * tools are thin reads and writes against it.
 *
 * LIFECYCLE
 *   start()   claim the lease, read the sealed state, connect if paired.
 *   pair()    fresh credentials, a socket, a pairing code for the phone.
 *   pairQr()  the same socket setup, answered with the current QR instead.
 *   (the phone enters the code or scans the QR → WhatsApp restarts the
 *    stream (515) → reconnect → open, paired)
 *   close / reconnect with backoff; 401 (logged out) wipes the login;
 *   440 (replaced by another socket) waits long before trying again.
 *   logout()  unlink, and delete everything persisted.
 *
 * NOTHING here logs a message's text, a key, a pairing code or a QR payload,
 * and no pairing-step line names the number being paired (once paired, the
 * account's own JID is logged on connect, which an operator needs). What it DOES log is every connection state and
 * close reason, and each step a pairing attempt reaches — "the phone accepted
 * the code" and "WhatsApp confirmed the device" are different failures, and
 * without both lines they look the same from here.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  attachmentMeta,
  DOWNLOAD_TIMEOUT_MS,
  fileNameOf,
  isMediaType,
  MAX_ATTACHMENT_BYTES,
  tooBigReason,
  type AttachmentMeta,
} from "./attachment.js";
import type { BlobStore } from "./state-store.js";
import { MessageBuffer, type ChatMeta } from "./buffer.js";
import type { WhatsAppConfig } from "./config.js";
import { SealError } from "./crypto.js";
import {
  deriveDownloadKey,
  mintDownloadToken,
  NonceLedger,
  verifyDownloadToken,
} from "./download-link.js";
import { errMessage, logInfo, logWarning, redact } from "./logging.js";
import {
  classify,
  isGroupJid,
  isIgnoredJid,
  isLidJid,
  isPhoneJid,
  isSelf,
  mediaMessageOf,
  mutationOf,
  normalizeJid,
  normalizeMessage,
  refreshedLocation,
  toSeconds,
  unwrap,
  type RawContent,
  type RawKey,
  type MediaDescriptor,
  type RawMessage,
  type SelfIdentity,
  type StoredMessage,
} from "./normalize.js";
import { DEFAULT_PACING, Pacer, type PacingLimits } from "./pacing.js";
import {
  cdnMediaDownloader,
  createMemoryAuth,
  DISCONNECT,
  disconnectCode,
  type ConnectionUpdate,
  type GroupInfo,
  type MediaDownloader,
  MediaTooLarge,
  type MemoryAuth,
  PAIRING_BROWSER,
  QR_REF_TTL_MS,
  qrPng,
  type SocketFactory,
  type WaSocket,
} from "./socket.js";
import { LEASE_CHECK_MS, StateStore, SupersededError, type IndexDoc } from "./store.js";

// --- the tool contract's shapes ---------------------------------------------------

export interface Status {
  connected: boolean;
  paired: boolean;
  self_jid: string | null;
  self_name: string | null;
  last_event_at: number | null;
  pairing_in_progress: boolean;
  /** Why the socket last closed, when it is not open. Additive to the contract. */
  last_disconnect_reason: string | null;
}

export interface ChatSummary {
  id: string;
  name: string;
  is_group: boolean;
  last_message_at: number | null;
  participant_count: number | null;
}

export interface OutMessage {
  id: string;
  chat_id: string;
  timestamp: number;
  sender_jid: string;
  sender_name: string;
  from_me: boolean;
  sent_by_bridge: boolean;
  text: string | null;
  type: StoredMessage["type"];
  quoted_message_id: string | null;
  mentions_self: boolean;
  reply_to_self: boolean;
  /** On a media message only. Additive to the contract. */
  attachment?: AttachmentMeta;
}

/** A decrypted attachment, as `whatsapp_get_attachment` receives it. */
export interface FetchedAttachment {
  chat_id: string;
  message_id: string;
  type: StoredMessage["type"];
  file_name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  caption: string | null;
  /** The descriptor had to be asked of the phone again (a pre-descriptor message). */
  recovered_from_phone: boolean;
  /** WhatsApp's CDN copy had expired and the phone uploaded it again. */
  reuploaded: boolean;
  bytes: Buffer;
}

export type DownloadLink =
  | { download_url: string; expires_at: string; single_use: true; curl: string }
  | { download_url: null; download_unavailable_reason: string };

/** What the bundle host's `/whatsapp/download/:token` route serves. */
export type DownloadOutcome =
  | {
      ok: true;
      filename: string;
      contentType: string;
      contentLength: number;
      body: ReadableStream<Uint8Array>;
    }
  | { ok: false; status: number; error: string };

export interface MediaLimits {
  maxBytes: number;
  /** One download, the re-upload round trip included. */
  timeoutMs: number;
  /** How long to wait for the phone to resend a pre-descriptor message. */
  recoveryTimeoutMs: number;
}

export interface MessagesResult {
  chat_id: string;
  chat_name: string;
  self_jid: string | null;
  has_more: boolean;
  messages: OutMessage[];
}

export interface PairResult {
  pairing_code: string;
  expires_in_seconds: number;
  instructions: string;
}

export interface QrPairResult {
  method: "qr";
  /** The payload the QR encodes. It carries this device's pairing keys. */
  qr: string;
  /** How long this QR has left before WhatsApp rotates it. */
  expires_in_seconds: number;
  instructions: string;
  /** The same payload as a PNG, drawn in this process. Not in the JSON. */
  png: Buffer;
}

export type PairMethod = "code" | "qr";

/** A failure whose message tells the caller what to do next. */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeOptions {
  config: WhatsAppConfig;
  blobs: BlobStore;
  socketFactory: SocketFactory;
  /** Milliseconds. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pacing?: PacingLimits;
  flushDelayMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** How long to wait after being replaced (440) before trying once more. */
  replacedDelayMs?: number;
  /** How long `pair` waits for the socket to be ready to register. */
  pairingReadyTimeoutMs?: number;
  /** Injected in tests. Production is `cdnMediaDownloader` (socket.ts). */
  mediaDownloader?: MediaDownloader;
  media?: Partial<MediaLimits>;
}

/**
 * What the pairing code is honestly good for. It lives as long as the socket
 * waits for the phone — several pairing refs of a minute each — so two minutes
 * is the floor, not the ceiling. `whatsapp_status` says when it has lapsed.
 */
export const PAIRING_CODE_TTL_SECONDS = 120;

export const PAIRING_INSTRUCTIONS =
  "On the phone that holds this WhatsApp account: open WhatsApp › Settings › " +
  "Linked devices › Link a device, then tap \"Link with phone number instead\" " +
  "and enter this code. Do NOT wait for a notification to appear on the phone: " +
  "WhatsApp stopped reliably sending the automatic \"enter code\" prompt to " +
  "linked-device clients around August 2026 (whatsmeow#1271 and matching " +
  "Baileys reports), so the manual path is the one that works. When it " +
  "succeeds, whatsapp_status reports connected: true and paired: true. Only " +
  "the code from the MOST RECENT whatsapp_pair call works: each call starts " +
  "over, and the code before it is dead. If the code lapses or the phone says " +
  "\"Couldn't link device\", call whatsapp_pair again for a new one, or use " +
  "{\"method\":\"qr\"} and scan instead.";

export const QR_INSTRUCTIONS =
  "On the phone that holds this WhatsApp account: open WhatsApp › Settings › " +
  "Linked devices › Link a device, and point the camera at this QR. WhatsApp " +
  "rotates it about once a minute; call whatsapp_pair with " +
  "{\"method\":\"qr\"} again for the current one (it does not start over " +
  "while this attempt is alive). When it succeeds, whatsapp_status reports " +
  "connected: true and paired: true.";

const MAX_TEXT_LENGTH = 4096;
const BRIDGE_SENT_KEEP = 2000;
const RECENT_SENT_KEEP = 200;
const PENDING_KEEP = 5000;
/** How many messages an on-demand history request asks the phone for. */
const RECOVERY_HISTORY_COUNT = 50;
/**
 * Downloads at once. Each holds up to `maxBytes` twice (ciphertext and
 * plaintext) in a process every other bundle server shares.
 */
const MAX_CONCURRENT_DOWNLOADS = 2;

export class WhatsAppBridge {
  private readonly config: WhatsAppConfig;
  private readonly store: StateStore;
  private readonly socketFactory: SocketFactory;
  private readonly clock: () => number;
  private readonly pacer: Pacer;
  readonly buffer: MessageBuffer;

  private readonly flushDelayMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly replacedDelayMs: number;
  private readonly pairingReadyTimeoutMs: number;

  private startPromise: Promise<void> | undefined;
  private stateError: string | null = null;
  private auth: MemoryAuth | null = null;
  private authDirty = false;
  private ownerJid: string | null = null;
  private readonly bridgeSent = new Set<string>();
  private readonly recentSent = new Map<string, unknown>();

  private socket: WaSocket | null = null;
  /** Bumped whenever a socket is abandoned, so its late events are ignored. */
  private generation = 0;
  private connected = false;
  private lastEventAt: number | null = null;
  private lastDisconnectReason: string | null = null;
  private pairing: {
    method: PairMethod;
    expiresAt: number;
    ready?: () => void;
    /** The phone answered the code (Baileys sent `companion_finish`). */
    phoneAccepted?: boolean;
  } | null = null;
  /** The QR ref the live pairing socket is offering, and when it arrived. */
  private currentQr: { payload: string; at: number } | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private ingesting: Promise<void> = Promise.resolve();
  private closed = false;
  private leaseTimer: NodeJS.Timeout | null = null;
  /** Set while logout or an owner change deletes the buffer: nothing may write. */
  private wiping = false;
  private readonly pendingIngest: StoredMessage[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly mediaDownloader: MediaDownloader;
  private readonly media: MediaLimits;
  private readonly downloadKey: Buffer | null;
  private readonly spentLinks = new NonceLedger();
  /** One phone round trip per message, however many callers ask at once. */
  private readonly recovering = new Map<string, Promise<void>>();
  private downloadsRunning = 0;
  private readonly downloadQueue: (() => void)[] = [];

  constructor(options: BridgeOptions) {
    this.config = options.config;
    this.clock = options.clock ?? Date.now;
    this.store = new StateStore(
      options.blobs,
      options.config.encryptionKey,
      options.config.prefix,
      this.clock,
    );
    this.socketFactory = options.socketFactory;
    this.pacer = new Pacer(options.pacing ?? DEFAULT_PACING, this.clock, options.sleep);
    this.buffer = new MessageBuffer(
      {
        maxMessages: options.config.bufferMaxMessages,
        maxAgeDays: options.config.bufferMaxAgeDays,
      },
      async (chatId) => {
        try {
          return await this.store.readChat(chatId);
        } catch (err) {
          // One chat object that does not open is that chat's history lost,
          // not a reason to refuse its new messages forever. It is rewritten
          // on the next flush. A transient read failure rethrows and the
          // message is held (upsertOrHold).
          if (!(err instanceof SealError)) throw err;
          logWarning(`a chat object does not open and is discarded: ${err.message}`);
          return null;
        }
      },
      () => Math.floor(this.clock() / 1000),
    );
    this.flushDelayMs = options.flushDelayMs ?? 2_000;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 2_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5 * 60_000;
    this.replacedDelayMs = options.replacedDelayMs ?? 10 * 60_000;
    this.pairingReadyTimeoutMs = options.pairingReadyTimeoutMs ?? 30_000;
    this.mediaDownloader = options.mediaDownloader ?? cdnMediaDownloader;
    this.media = {
      maxBytes: options.media?.maxBytes ?? MAX_ATTACHMENT_BYTES,
      timeoutMs: options.media?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
      recoveryTimeoutMs: options.media?.recoveryTimeoutMs ?? 30_000,
    };
    const link = options.config.downloadLink;
    this.downloadKey = link
      ? deriveDownloadKey(link.internalToken, link.publicSlug, options.config.encryptionKey)
      : null;
  }

  // --- identity ---------------------------------------------------------------------

  private nowSeconds(): number {
    return Math.floor(this.clock() / 1000);
  }

  /** Paired = WhatsApp accepted this device: an account signature is on file. */
  private paired(): boolean {
    const creds = this.auth?.state.creds;
    return Boolean(creds?.me?.id && creds.account);
  }

  private self(): SelfIdentity {
    const me = this.auth?.state.creds.me;
    return { jid: normalizeJid(me?.id), lid: normalizeJid(me?.lid) };
  }

  private selfName(): string | null {
    const name = this.auth?.state.creds.me?.name;
    return name && name !== "~" ? name : null;
  }

  // --- start / close ------------------------------------------------------------------

  /** Idempotent. A failure is not memoised, so the next call retries. */
  start(): Promise<void> {
    this.startPromise ??= this.doStart().catch((err: unknown) => {
      this.startPromise = undefined;
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    await this.store.claimLease();
    // Re-read the lease on a clock, not only when a write happens: a process
    // that has nothing to write would otherwise keep its socket open after a
    // newer deploy took the account.
    this.leaseTimer ??= setInterval(() => {
      void this.store
        .checkLease(true)
        .then((mine) => {
          if (!mine && !this.closed) this.onSuperseded();
        })
        .catch((err: unknown) => logWarning(`lease check failed: ${errMessage(err)}`));
    }, LEASE_CHECK_MS);
    this.leaseTimer.unref?.();
    let saved: string | null;
    try {
      saved = await this.store.readAuth();
      const index = await this.store.readIndex();
      if (index) this.loadIndex(index);
    } catch (err) {
      if (err instanceof SealError) {
        // Not memoised as a failure: the state is there, it just does not open.
        // Tools report it; whatsapp_logout clears it.
        this.stateError = err.message;
        logWarning(`stored state does not open: ${err.message}`);
        return;
      }
      throw err;
    }
    if (saved) {
      this.auth = await createMemoryAuth(saved, () => this.markAuthDirty());
      if (this.paired()) {
        logInfo(`restored a paired device (${this.self().jid ?? "unknown"}); connecting`);
        await this.connect();
      }
    }
  }

  private loadIndex(index: IndexDoc): void {
    this.ownerJid = index.owner_jid;
    for (const chat of index.chats) this.buffer.chats.set(chat.id, { ...chat });
    for (const id of index.stored) this.buffer.stored.add(id);
    for (const [jid, name] of index.names) this.buffer.names.set(jid, name);
    for (const [lid, pn] of index.lid_to_pn) this.buffer.lidToPn.set(lid, pn);
    for (const id of index.bridge_sent ?? []) this.bridgeSent.add(id);
    this.buffer.indexDirty = false;
  }

  private indexDoc(): IndexDoc {
    return {
      version: 1,
      owner_jid: this.ownerJid,
      chats: [...this.buffer.chats.values()],
      stored: [...this.buffer.stored],
      names: [...this.buffer.names],
      lid_to_pn: [...this.buffer.lidToPn],
      bridge_sent: [...this.bridgeSent],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.reconnectTimer = this.flushTimer = null;
    await this.ingesting;
    await this.flush().catch(() => {});
    this.dropSocket();
  }

  private dropSocket(): void {
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.currentQr = null;
    try {
      socket?.end();
    } catch {
      // Already closed.
    }
  }

  // --- the socket ---------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (!this.auth || this.closed || this.store.superseded) return;
    // Every (re)connect asks first. A socket WhatsApp replaced (440) is most
    // often an old container whose successor now holds the lease; opening a
    // socket here would kick the successor off.
    if (!(await this.store.checkLease(true))) {
      this.onSuperseded();
      return;
    }
    this.dropSocket();
    const gen = this.generation;
    const socket = await this.socketFactory({
      auth: this.auth.state,
      // A real OS and browser, never a custom name: see PAIRING_BROWSER.
      browser: PAIRING_BROWSER,
      getMessage: async (key) =>
        (key.id ? this.recentSent.get(key.id) : undefined) ?? undefined,
    });
    if (gen !== this.generation) {
      socket.end();
      return;
    }
    this.socket = socket;
    const on = <T>(event: string, handler: (payload: T) => void | Promise<void>) =>
      socket.ev.on(event, ((payload: T) => {
        if (gen !== this.generation) return;
        this.lastEventAt = this.nowSeconds();
        void Promise.resolve(handler(payload)).catch((err: unknown) =>
          logWarning(`${event} handler failed: ${errMessage(err)}`),
        );
      }) as never);

    on<ConnectionUpdate>("connection.update", (u) => this.onConnection(u, gen));
    on<unknown>("creds.update", () => {
      if (this.pairing && !this.pairing.phoneAccepted && this.auth?.state.creds.registered) {
        this.pairing.phoneAccepted = true;
        logInfo("pairing: the phone accepted the code; waiting for WhatsApp to confirm the device");
      }
      this.markAuthDirty();
    });
    on<{ messages?: RawMessage[] }>("messages.upsert", (e) =>
      this.enqueue(async () => {
        for (const m of e.messages ?? []) await this.ingest(m);
      }),
    );
    on<{
      chats?: Chat[];
      contacts?: Contact[];
      messages?: RawMessage[];
      lidPnMappings?: { lid: string; pn: string }[];
    }>("messaging-history.set", (e) =>
      this.enqueue(async () => {
        for (const m of e.lidPnMappings ?? []) this.learnLid(m.lid, m.pn);
        for (const c of e.contacts ?? []) this.learnContact(c);
        for (const c of e.chats ?? []) this.learnChat(c);
        for (const m of e.messages ?? []) await this.ingest(m, { historical: true });
      }),
    );
    on<Chat[]>("chats.upsert", (chats) => chats.forEach((c) => this.learnChat(c)));
    on<Chat[]>("chats.update", (chats) => chats.forEach((c) => this.learnChat(c)));
    on<Contact[]>("contacts.upsert", (cs) => cs.forEach((c) => this.learnContact(c)));
    on<Contact[]>("contacts.update", (cs) => cs.forEach((c) => this.learnContact(c)));
    on<GroupInfo[]>("groups.upsert", (gs) => gs.forEach((g) => this.learnGroup(g)));
    on<GroupInfo[]>("groups.update", (gs) => gs.forEach((g) => this.learnGroup(g)));
    on<{ lid: string; pn: string }>("lid-mapping.update", (m) => this.learnLid(m.lid, m.pn));
    on<{ key: RawKey; update: { message?: RawContent | null; messageStubType?: number | null } }[]>(
      "messages.update",
      (updates) => this.enqueue(async () => {
        for (const u of updates) await this.applyUpdate(u.key, u.update);
      }),
    );
  }

  private onConnection(update: ConnectionUpdate, gen: number): void {
    if (update.qr) {
      this.currentQr = { payload: update.qr, at: this.clock() };
      // A QR attempt is alive for as long as WhatsApp keeps offering refs.
      if (this.pairing?.method === "qr") {
        this.pairing.expiresAt = this.currentQr.at + QR_REF_TTL_MS;
      }
      if (this.pairing?.ready) {
        logInfo(`pairing (${this.pairing.method}): WhatsApp offered a pairing session`);
        this.pairing.ready();
        this.pairing.ready = undefined;
      }
    }
    if (update.isNewLogin) {
      this.currentQr = null;
      logInfo("pairing: WhatsApp confirmed the device (pair-success); expecting a restart (515)");
    }
    if (update.connection === "connecting") {
      logInfo("connection: connecting");
    }
    if (update.connection === "open") {
      this.currentQr = null;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastDisconnectReason = null;
      this.pairing = null;
      logInfo(`connected as ${this.self().jid ?? "unknown"}`);
      void this.enqueue(() => this.adoptOwner());
      void this.refreshGroups(gen);
      this.markAuthDirty();
      void this.flush().catch(() => {});
      return;
    }
    if (update.connection === "close") {
      const code = disconnectCode(update.lastDisconnect?.error);
      // Baileys' own wording ("QR refs attempts ended", "Stream Errored
      // (conflict)") says more than the number does. It is redacted on the way out.
      const message = (update.lastDisconnect?.error as { message?: unknown } | undefined)
        ?.message;
      const detail = typeof message === "string" && message !== "" ? `: ${message}` : "";
      logInfo(
        `connection: closed ${code ?? "without a status"} (${reasonName(code)})` +
          `${this.pairing ? `, during a ${this.pairing.method} pairing` : ""}${detail}`,
      );
      this.connected = false;
      this.socket = null;
      this.currentQr = null;
      this.onClose(code);
    }
  }

  private onClose(code: number | undefined): void {
    if (this.closed) return;
    if (this.store.superseded) {
      this.lastDisconnectReason = "replaced_by_another_instance";
      return;
    }
    if (code === DISCONNECT.loggedOut) {
      // Unlinked from the phone, or the phone was offline long enough (about
      // 14 days) that WhatsApp logged this device out. The login is dead; the
      // buffer is kept, because re-pairing the same account should find it.
      logWarning("WhatsApp logged this device out; pair again to reconnect");
      this.lastDisconnectReason = "logged_out";
      this.pairing = null;
      this.auth = null;
      this.authDirty = false;
      void this.store.deleteAuth().catch((err: unknown) =>
        logWarning(`could not delete the dead login: ${errMessage(err)}`),
      );
      return;
    }
    if (!this.paired()) {
      // A pairing attempt ended without the phone entering the code.
      this.lastDisconnectReason =
        code === DISCONNECT.timedOut ? "pairing_code_expired" : reasonName(code);
      if (this.pairing) {
        logWarning(
          `pairing (${this.pairing.method}): ended unpaired (${this.lastDisconnectReason}); ` +
            (this.pairing.phoneAccepted
              ? "the phone accepted the code but WhatsApp never confirmed the device"
              : "the phone never completed it"),
        );
      }
      this.pairing = null;
      this.auth = null;
      return;
    }
    if (code === DISCONNECT.forbidden) {
      // Typically the account is banned or restricted. Retrying every few
      // minutes would only make that worse; a human has to look.
      logWarning("WhatsApp refused this device (403); not reconnecting");
      this.lastDisconnectReason = "forbidden";
      return;
    }
    if (code === DISCONNECT.restartRequired) {
      // Expected right after pairing: WhatsApp asks for a fresh stream.
      this.lastDisconnectReason = "restart_required";
      this.scheduleReconnect(0);
      return;
    }
    if (code === DISCONNECT.connectionReplaced) {
      // Another socket opened on this same device — during a deploy, the new
      // container. Reconnecting now would kick it back and the two would
      // ping-pong. Wait long enough for a deploy to finish, then try once more.
      logWarning("replaced by another connection on this device; backing off");
      this.lastDisconnectReason = "connection_replaced";
      this.scheduleReconnect(this.replacedDelayMs);
      return;
    }
    this.lastDisconnectReason = reasonName(code);
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts++;
    // Jitter, so a WhatsApp-side blip does not make every retry land together.
    this.scheduleReconnect(delay + Math.floor(Math.random() * Math.min(1000, delay)));
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err: unknown) => {
        logWarning(`reconnect failed: ${errMessage(err)}`);
        this.onClose(undefined);
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async refreshGroups(gen: number): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try {
      const groups = await socket.groupFetchAllParticipating();
      if (gen !== this.generation) return;
      for (const g of Object.values(groups)) this.learnGroup(g);
      this.scheduleFlush();
    } catch (err) {
      logWarning(`could not list groups: ${errMessage(err)}`);
    }
  }

  /**
   * The buffer belongs to one account. Pairing a DIFFERENT account must not
   * serve it the previous account's chats.
   */
  private async adoptOwner(): Promise<void> {
    const jid = this.self().jid;
    if (!jid || jid === this.ownerJid) return;
    if (this.ownerJid !== null) {
      logWarning("a different account was paired; discarding the old buffer");
      await this.wipe(() => this.store.deleteBuffer());
    }
    this.ownerJid = jid;
    this.buffer.indexDirty = true;
  }

  /**
   * Delete persisted state with no flush able to write it back: new flushes
   * are refused while `wiping` is set, and one already in flight is waited
   * out before anything is deleted. Without both, a flush that had passed its
   * lease check would restore a chat object or the index right after logout.
   */
  private async wipe(remove: () => Promise<void>): Promise<void> {
    this.wiping = true;
    try {
      await this.flushing;
      await remove();
      this.buffer.clear();
      this.bridgeSent.clear();
      this.pendingIngest.length = 0;
    } finally {
      this.wiping = false;
    }
  }

  // --- ingestion ------------------------------------------------------------------------

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.ingesting.then(work).then(
      () => this.scheduleFlush(),
      (err: unknown) => logWarning(`could not buffer an event: ${errMessage(err)}`),
    );
    this.ingesting = next;
    return next;
  }

  private learnLid(lid: string | null | undefined, pn: string | null | undefined): void {
    const l = normalizeJid(lid);
    const p = normalizeJid(pn);
    if (l && p && isLidJid(l) && isPhoneJid(p)) this.buffer.mapLid(l, p);
  }

  private learnContact(c: Contact): void {
    const id = normalizeJid(c.id);
    if (!id) return;
    const name = c.name ?? c.notify ?? c.verifiedName ?? null;
    if (isLidJid(id)) this.learnLid(id, c.phoneNumber);
    else if (isPhoneJid(id)) this.learnLid(c.lid, id);
    if (name) {
      // Under both addresses: chats and senders are keyed by the phone JID
      // wherever it is known, and a contact-book name outranks a push name.
      this.buffer.setName(id, name);
      const pn = isLidJid(id) ? this.buffer.lidToPn.get(id) : undefined;
      if (pn) this.buffer.setName(pn, name);
    }
    this.scheduleFlush();
  }

  private learnChat(c: Chat): void {
    let id = normalizeJid(c.id);
    if (!id || isIgnoredJid(id)) return;
    if (isLidJid(id)) id = this.buffer.lidToPn.get(id) ?? id;
    this.buffer.touchChat(id, {
      name: c.name ?? undefined,
      last_message_at: toSeconds(c.conversationTimestamp) ?? undefined,
    });
    if (c.name) this.buffer.setName(id, c.name);
    this.scheduleFlush();
  }

  private learnGroup(g: GroupInfo): void {
    const id = normalizeJid(g.id);
    if (!id || !isGroupJid(id)) return;
    const count = Array.isArray(g.participants) ? g.participants.length : g.size;
    this.buffer.touchChat(id, {
      name: g.subject ?? undefined,
      participant_count: typeof count === "number" ? count : undefined,
    });
    if (g.subject) this.buffer.setName(id, g.subject);
    this.scheduleFlush();
  }

  /**
   * `historical`: a history sync, initial or on demand. A message it carries
   * that the buffer already holds contributes only a missing media
   * descriptor — the buffered copy has seen edits the history copy predates.
   */
  private async ingest(raw: RawMessage, { historical = false } = {}): Promise<void> {
    const key = raw.key;
    if (key) {
      this.learnLid(key.remoteJid, key.remoteJidAlt);
      this.learnLid(key.participant, key.participantAlt);
    }
    const n = normalizeMessage(raw, this.self(), this.buffer.lidToPn);
    if (n.kind === "message") {
      if (historical && n.message.media) {
        const existing = await this.buffer.get(n.message.chat_id, n.message.id).catch(() => undefined);
        if (existing) {
          if (!existing.media) await this.buffer.setMedia(n.message.chat_id, n.message.id, n.message.media);
          return;
        }
      }
      if (this.bridgeSent.has(n.message.id)) n.message.sent_by_bridge = true;
      await this.upsertOrHold(n.message);
    } else if (n.kind === "mutation") {
      const m = n.mutation;
      if (m.kind === "revoke") await this.buffer.revoke(m.chat_id, m.id);
      else await this.buffer.edit(m.chat_id, m.id, m.text);
    }
  }

  /**
   * WhatsApp does not deliver a message twice, so a message whose chat could
   * not be loaded from GCS (a transient read failure) is HELD and retried,
   * never dropped. Bounded, so a store that stays down cannot grow it without
   * limit; past the bound the oldest held message is the one given up.
   */
  private async upsertOrHold(message: StoredMessage): Promise<void> {
    try {
      await this.buffer.upsert(message);
    } catch (err) {
      logWarning(`holding a message: its chat could not be loaded (${errMessage(err)})`);
      this.pendingIngest.push(message);
      if (this.pendingIngest.length > PENDING_KEEP) this.pendingIngest.shift();
      this.scheduleRetryHeld();
    }
  }

  private scheduleRetryHeld(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const held = this.pendingIngest.splice(0);
      void this.enqueue(async () => {
        for (const m of held) await this.upsertOrHold(m);
      });
    }, this.flushDelayMs * 5);
    this.retryTimer.unref?.();
  }

  private async applyUpdate(
    key: RawKey,
    update: { message?: RawContent | null; messageStubType?: number | null },
  ): Promise<void> {
    if (!key?.id || !key.remoteJid) return;
    const chat = this.canonicalChat(key.remoteJid, key.remoteJidAlt);
    if (!chat) return;
    // WAMessageStubType.REVOKE = 1: "this message was deleted".
    if (update.message === null && update.messageStubType === 1) {
      await this.buffer.revoke(chat, key.id);
      return;
    }
    if (!update.message) return;
    const content = unwrap(update.message);
    const mutation = mutationOf(chat, content);
    if (mutation) {
      if (mutation.kind === "revoke") await this.buffer.revoke(chat, mutation.id);
      else await this.buffer.edit(chat, mutation.id, mutation.text);
      return;
    }
    // An edit arrives as `{ editedMessage: { message: <new content> } }`.
    if (update.message.editedMessage) {
      await this.buffer.edit(chat, key.id, classify(content)?.text ?? null);
    }
  }

  private canonicalChat(jid: string | null | undefined, alt?: string | null): string | null {
    const n = normalizeJid(jid);
    if (!n) return null;
    if (isLidJid(n)) {
      const a = normalizeJid(alt);
      if (a && isPhoneJid(a)) return a;
      return this.buffer.lidToPn.get(n) ?? n;
    }
    return n;
  }

  // --- persistence ----------------------------------------------------------------------

  private markAuthDirty(): void {
    this.authDirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => {});
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  /** Write whatever changed. Serialized: one flush at a time. */
  flush(): Promise<void> {
    const next = this.flushing.then(() => this.doFlush());
    this.flushing = next.catch(() => {});
    return next;
  }

  private async doFlush(): Promise<void> {
    if (this.store.superseded || this.wiping) return;
    let failure: unknown;
    try {
      // FORCED, every flush: the chat and index writes below are
      // unconditional, and a lease read that is up to 30 s stale is exactly
      // the window in which a replaced process would overwrite what its
      // successor just wrote. One small read per flush is the price.
      if (!(await this.store.checkLease(true))) throw new SupersededError();

      // Three independent sections. A failed auth write must not keep the
      // buffer (and the `bridge_sent` ids in the index) from being saved.
      if (this.authDirty && this.auth && this.paired()) {
        this.authDirty = false;
        try {
          await this.store.writeAuth(this.auth.serialize());
        } catch (err) {
          if (err instanceof SupersededError) throw err;
          this.authDirty = true;
          failure ??= err;
        }
      }
      const chats = [...this.buffer.dirtyChats];
      this.buffer.dirtyChats.clear();
      for (const chat of chats) {
        try {
          await this.store.writeChat(chat, await this.buffer.snapshot(chat));
        } catch (err) {
          if (err instanceof SupersededError) throw err;
          this.buffer.dirtyChats.add(chat);
          failure ??= err;
        }
      }
      if (this.buffer.indexDirty) {
        this.buffer.indexDirty = false;
        try {
          await this.store.writeIndex(this.indexDoc());
        } catch (err) {
          if (err instanceof SupersededError) throw err;
          this.buffer.indexDirty = true;
          failure ??= err;
        }
      }
    } catch (err) {
      if (err instanceof SupersededError) {
        this.onSuperseded();
        return;
      }
      failure ??= err;
    }
    if (failure !== undefined) {
      logWarning(`could not persist state (will retry): ${errMessage(failure)}`);
      this.scheduleFlush();
      throw failure;
    }
  }

  private onSuperseded(): void {
    logWarning(
      "another process owns this WhatsApp account now; closing this socket and " +
        "no longer writing state",
    );
    this.lastDisconnectReason = "replaced_by_another_instance";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.reconnectTimer = this.leaseTimer = null;
    this.pairing = null;
    this.dropSocket();
  }

  // --- the tools ------------------------------------------------------------------------

  private async ready(): Promise<void> {
    await this.start();
    if (this.store.superseded) throw new SupersededError();
  }

  private requireReadable(): void {
    if (this.stateError) throw new BridgeError(this.stateError);
  }

  private requireConnected(): WaSocket {
    this.requireReadable();
    if (!this.paired()) {
      throw new BridgeError(
        "No WhatsApp account is paired. A human pairs one with whatsapp_pair " +
          "(from strad's console playground or an agent session).",
      );
    }
    if (!this.connected || !this.socket) {
      throw new BridgeError(
        `The WhatsApp socket is not connected (last reason: ` +
          `${this.lastDisconnectReason ?? "still connecting"}). It reconnects on ` +
          `its own with backoff; check whatsapp_status and retry.`,
      );
    }
    return this.socket;
  }

  async status(): Promise<Status> {
    await this.start();
    const paired = this.paired();
    const self = this.self();
    return {
      connected: this.connected && paired && !this.store.superseded,
      paired,
      self_jid: paired ? self.jid : null,
      self_name: paired ? this.selfName() : null,
      last_event_at: this.lastEventAt,
      pairing_in_progress:
        this.pairing !== null && this.clock() < this.pairing.expiresAt && !paired,
      last_disconnect_reason: this.store.superseded
        ? "replaced_by_another_instance"
        : (this.stateError ? "state_unreadable" : this.lastDisconnectReason),
    };
  }

  private chatName(meta: ChatMeta | undefined, id: string): string {
    return meta?.name ?? this.buffer.names.get(id) ?? id.split("@")[0]!;
  }

  async listChats(query: { limit: number; query?: string }): Promise<{ chats: ChatSummary[] }> {
    await this.ready();
    this.requireReadable();
    const needle = query.query?.trim().toLowerCase();
    const chats = [...this.buffer.chats.values()]
      .map((meta) => ({
        id: meta.id,
        name: this.chatName(meta, meta.id),
        is_group: meta.is_group,
        last_message_at: meta.last_message_at,
        participant_count: meta.participant_count,
      }))
      .filter(
        (c) =>
          !needle ||
          c.name.toLowerCase().includes(needle) ||
          c.id.toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0));
    return { chats: chats.slice(0, query.limit) };
  }

  private resolveChat(chatId: string): string {
    const canonical = this.canonicalChat(chatId);
    if (!canonical || !canonical.includes("@") || !this.buffer.chats.has(canonical)) {
      throw new BridgeError(
        `No chat "${chatId}" is known to this bridge. Chat ids are WhatsApp JIDs ` +
          `("…@g.us" for a group, "…@s.whatsapp.net" for a person); call ` +
          `whatsapp_list_chats to find one. A chat appears there once the ` +
          `paired account has a message in it or is a member of the group.`,
      );
    }
    return canonical;
  }

  async getMessages(query: {
    chat_id: string;
    after?: number;
    limit: number;
  }): Promise<MessagesResult> {
    await this.ready();
    this.requireReadable();
    await this.ingesting;
    const chatId = this.resolveChat(query.chat_id);
    const self = this.self();
    const result = await this.buffer.query(chatId, query.limit, query.after);
    const messages: OutMessage[] = [];
    for (const m of result.messages) {
      let replyToSelf = isSelf(m.quoted_participant, self);
      if (!replyToSelf && m.quoted_message_id) {
        const quoted = await this.buffer.get(chatId, m.quoted_message_id);
        replyToSelf = quoted?.from_me === true;
      }
      messages.push({
        id: m.id,
        chat_id: m.chat_id,
        timestamp: m.timestamp,
        sender_jid: m.from_me && self.jid ? self.jid : m.sender_jid,
        sender_name: this.senderName(m, self),
        from_me: m.from_me,
        sent_by_bridge: m.sent_by_bridge || this.bridgeSent.has(m.id),
        text: m.text,
        type: m.type,
        quoted_message_id: m.quoted_message_id,
        mentions_self: m.mentioned.some((j) => isSelf(j, self)),
        reply_to_self: replyToSelf,
        ...(isMediaType(m.type) ? { attachment: attachmentMeta(m, this.media.maxBytes) } : {}),
      });
    }
    this.scheduleFlush();
    return {
      chat_id: chatId,
      chat_name: this.chatName(this.buffer.chats.get(chatId), chatId),
      self_jid: self.jid,
      has_more: result.has_more,
      messages,
    };
  }

  private senderName(m: StoredMessage, self: SelfIdentity): string {
    if (m.from_me) return this.selfName() ?? self.jid?.split("@")[0] ?? "me";
    return (
      this.buffer.names.get(m.sender_jid) ??
      (m.sender_alt_jid ? this.buffer.names.get(m.sender_alt_jid) : undefined) ??
      m.push_name ??
      m.sender_jid.split("@")[0]!
    );
  }

  // --- attachments ------------------------------------------------------------------------

  /**
   * Download and decrypt one buffered media message.
   *
   * The bytes are held in memory for this call only (bounded by
   * `media.maxBytes`) and never written anywhere. A message buffered before
   * descriptors were kept is first asked of the phone again.
   */
  async getAttachment(query: { chat_id: string; message_id: string }): Promise<FetchedAttachment> {
    await this.ready();
    this.requireReadable();
    await this.ingesting;
    const chatId = this.resolveChat(query.chat_id);
    let message = await this.buffer.get(chatId, query.message_id);
    if (!message) {
      throw new BridgeError(
        `Message "${query.message_id}" is not in this bridge's buffer for ${chatId}. ` +
          `Use an id from whatsapp_get_messages.`,
      );
    }
    if (!isMediaType(message.type)) {
      throw new BridgeError(
        `Message "${message.id}" is a ${message.type} message, not an attachment. ` +
          `whatsapp_get_messages marks media messages with an \`attachment\` object.`,
      );
    }
    let recovered = false;
    if (!message.media) {
      message = await this.recoverDescriptor(chatId, message);
      recovered = true;
    }
    const d = message.media!;
    if (d.file_length !== null && d.file_length > this.media.maxBytes) {
      throw new BridgeError(tooBigReason(d.file_length, this.media.maxBytes));
    }
    const { bytes, reuploaded, location } = await this.limited(() => this.fetchMedia(d));
    if (reuploaded) {
      await this.buffer.setMediaLocation(chatId, message.id, location);
      this.scheduleFlush();
    }
    return {
      chat_id: chatId,
      message_id: message.id,
      type: message.type,
      file_name: fileNameOf(d, message.id),
      mime_type: d.mimetype ?? "application/octet-stream",
      size_bytes: bytes.length,
      page_count: d.page_count,
      caption: message.text,
      recovered_from_phone: recovered,
      reuploaded,
      bytes,
    };
  }

  /** At most MAX_CONCURRENT_DOWNLOADS at once; the rest wait their turn. */
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.downloadsRunning >= MAX_CONCURRENT_DOWNLOADS) {
      await new Promise<void>((resolve) => this.downloadQueue.push(resolve));
    }
    this.downloadsRunning++;
    try {
      return await work();
    } finally {
      this.downloadsRunning--;
      this.downloadQueue.shift()?.();
    }
  }

  /**
   * Fetch, decrypt, bound, verify — and when WhatsApp's CDN answers 404 or
   * 410 (the copy expired), ask the phone to upload it again
   * (`updateMediaMessage`) and fetch once more. At most one re-upload.
   */
  private async fetchMedia(d: MediaDescriptor): Promise<{
    bytes: Buffer;
    reuploaded: boolean;
    location: Pick<MediaDescriptor, "direct_path" | "url">;
  }> {
    let message = mediaMessageOf(d);
    let reuploaded = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.media.timeoutMs);
    timer.unref?.();
    const download = () =>
      this.mediaDownloader(message, { signal: controller.signal, maxBytes: this.media.maxBytes });
    try {
      let bytes: Buffer;
      try {
        bytes = await download();
      } catch (err) {
        if (!isGone(err) || controller.signal.aborted) throw err;
        message = await this.reupload(message, controller.signal);
        reuploaded = true;
        bytes = await download();
      }
      if (bytes.length > this.media.maxBytes) throw new MediaTooLarge(bytes.length);
      if (d.file_sha256) {
        const digest = createHash("sha256").update(bytes).digest("base64");
        if (digest !== d.file_sha256) {
          throw new BridgeError(
            "The downloaded file does not match the checksum WhatsApp sent with " +
              "the message, so it is not returned. Retry; if it persists the file " +
              "is damaged on WhatsApp's side.",
          );
        }
      }
      return { bytes, reuploaded, location: refreshedLocation(d, message) };
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      if (err instanceof MediaTooLarge) {
        throw new BridgeError(tooBigReason(err.bytes, this.media.maxBytes));
      }
      if (controller.signal.aborted) {
        throw new BridgeError(
          `Downloading the attachment took longer than ${Math.round(this.media.timeoutMs / 1000)} s ` +
            "and was abandoned. Retry; a phone re-uploading a large file can take a while.",
        );
      }
      const code = statusOf(err);
      throw new BridgeError(
        `Could not download the attachment from WhatsApp` +
          `${code ? ` (HTTP ${code})` : ""}: ${errMessage(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Baileys waits for the phone's answer with no timeout of its own, so the
   * download's signal bounds it: a phone that never answers costs the call
   * its 60 s, not forever.
   */
  private async reupload(message: RawMessage, signal: AbortSignal): Promise<RawMessage> {
    const socket = this.connected && this.paired() ? this.socket : null;
    if (!socket) {
      throw new BridgeError(
        "This file's copy on WhatsApp's servers has expired, and asking the " +
          "phone to upload it again needs the socket, which is not connected " +
          `(last reason: ${this.lastDisconnectReason ?? "still connecting"}). ` +
          "Check whatsapp_status and retry.",
      );
    }
    try {
      return await new Promise<RawMessage>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        socket.updateMediaMessage(message).then(
          (m) => {
            signal.removeEventListener("abort", onAbort);
            resolve(m);
          },
          (err: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new BridgeError(
        "This file's copy on WhatsApp's servers has expired, and the phone did " +
          `not upload it again (${errMessage(err)}). The phone must be online and ` +
          "still have the file; it may have been deleted there.",
      );
    }
  }

  /**
   * A message buffered before descriptors were kept has nothing to download
   * with — the media key is not derivable. WhatsApp offers a linked device two
   * ways to have the PHONE send a message again, and both are tried: a
   * placeholder resend of exactly this key, and an on-demand history sync of
   * the messages before the next one buffered. Either answer arrives as an
   * ordinary event, is ingested (descriptor and all) and merged into the
   * record; this waits for that.
   */
  private async recoverDescriptor(chatId: string, message: StoredMessage): Promise<StoredMessage> {
    const socket = this.connected && this.paired() ? this.socket : null;
    if (!socket) {
      throw new BridgeError(
        "This message was buffered before the bridge kept what a download " +
          "needs, and recovering it means asking the phone, which needs the " +
          `socket; it is not connected (last reason: ${this.lastDisconnectReason ?? "still connecting"}). ` +
          "Check whatsapp_status and retry.",
      );
    }
    const id = `${chatId}\u0000${message.id}`;
    let pending = this.recovering.get(id);
    if (!pending) {
      pending = this.askPhone(socket, chatId, message).finally(() => this.recovering.delete(id));
      this.recovering.set(id, pending);
    }
    await pending;
    const after = await this.buffer.get(chatId, message.id);
    if (after?.media) {
      logInfo("attachment: the phone resent a message buffered without a media descriptor");
      return after;
    }
    logWarning("attachment: the phone did not resend a message buffered without a media descriptor");
    throw new BridgeError(
      "This message was buffered before the bridge kept what a download needs, " +
        `and the phone did not send it again within ${Math.round(this.media.recoveryTimeoutMs / 1000)} s. ` +
        "The phone must be online with WhatsApp able to run; retry once it is. " +
        "If it still fails, the phone no longer has the message (deleted, or " +
        "older than it keeps), and it has to be forwarded to the account again.",
    );
  }

  private async askPhone(socket: WaSocket, chatId: string, message: StoredMessage): Promise<void> {
    const keyOf = (m: StoredMessage): RawKey =>
      m.media
        ? {
            remoteJid: m.media.key.remote_jid,
            fromMe: m.media.key.from_me,
            id: m.media.key.id,
            ...(m.media.key.participant ? { participant: m.media.key.participant } : {}),
          }
        : {
            remoteJid: chatId,
            fromMe: m.from_me,
            id: m.id,
            ...(isGroupJid(chatId) && !m.from_me
              ? { participant: m.sender_alt_jid ?? m.sender_jid }
              : {}),
          };
    const failed = (err: unknown): "failed" => {
      logWarning(`attachment: a resend request failed: ${errMessage(err)}`);
      return "failed";
    };
    const asks: Promise<unknown>[] = [
      socket.requestPlaceholderResend(keyOf(message)).catch(failed),
    ];
    const anchor = await this.buffer.nextAfter(chatId, message).catch(() => undefined);
    if (anchor) {
      asks.push(
        socket
          .fetchMessageHistory(RECOVERY_HISTORY_COUNT, keyOf(anchor), anchor.timestamp * 1000)
          .catch(failed),
      );
    }
    let allFailed = false;
    void Promise.all(asks).then((outcomes) => {
      allFailed = outcomes.every((o) => o === "failed");
    });
    const deadline = Date.now() + this.media.recoveryTimeoutMs;
    while (Date.now() < deadline && !allFailed) {
      await this.ingesting;
      if ((await this.buffer.get(chatId, message.id))?.media) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Unanswered: let the next call ask again rather than be skipped by
    // Baileys' hour-long memory of this ask.
    socket.forgetPlaceholderResend(message.id);
  }

  /** A single-use link to the same file, or why there is none. */
  downloadLink(chatId: string, messageId: string, fileName: string): DownloadLink {
    const link = this.config.downloadLink;
    if (!link || !this.downloadKey) {
      return {
        download_url: null,
        download_unavailable_reason:
          this.config.downloadUnavailable ?? "no download link is configured for this mount",
      };
    }
    const { token, expiresAt } = mintDownloadToken(this.downloadKey, chatId, messageId, this.clock());
    const url = `${link.publicBaseUrl}/mcp-download/${encodeURIComponent(link.publicSlug)}/${token}`;
    // Pasted into a shell, so the name is untrusted input arriving at one:
    // everything outside a safe set becomes `_`, and a leading `-` or `.` goes.
    const safe =
      fileName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[-.]+/, "").slice(-200) || messageId;
    return {
      download_url: url,
      expires_at: expiresAt,
      single_use: true,
      curl: `curl -fSL -o '${safe}' '${url}'`,
    };
  }

  /**
   * The bundle host's `/whatsapp/download/:token`. The link is spent when it
   * is presented; a fetch that produced no bytes hands the claim back, so an
   * ordinary retry still works.
   */
  async handleDownload(token: string): Promise<DownloadOutcome> {
    if (!this.downloadKey) return { ok: false, status: 404, error: "downloads_not_configured" };
    const verified = verifyDownloadToken(this.downloadKey, token, this.clock());
    if (!verified.ok) return verified;
    const claim = this.spentLinks.claim(verified.nonce, verified.expiresAtMs, this.clock());
    if (claim === "spent") return { ok: false, status: 410, error: "already_used" };
    if (claim === "full") return { ok: false, status: 503, error: "busy" };
    try {
      const a = await this.getAttachment({
        chat_id: verified.chatId,
        message_id: verified.messageId,
      });
      return {
        ok: true,
        filename: a.file_name,
        contentType: a.mime_type,
        contentLength: a.bytes.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(a.bytes);
            controller.close();
          },
        }),
      };
    } catch {
      // The reason is not in the body: it can name the chat, and this answer
      // goes to whoever holds the link. whatsapp_get_attachment says why.
      this.spentLinks.release(verified.nonce);
      return { ok: false, status: 502, error: "download_failed" };
    }
  }

  async sendMessage(request: {
    chat_id: string;
    text: string;
    reply_to_message_id?: string;
  }): Promise<{ id: string; timestamp: number }> {
    await this.ready();
    const socket = this.requireConnected();
    const chatId = this.resolveChat(request.chat_id);
    if (request.text.length > MAX_TEXT_LENGTH) {
      throw new BridgeError(
        `\`text\` is ${request.text.length} characters; this bridge sends at most ` +
          `${MAX_TEXT_LENGTH} in one message. Send it as several messages, ` +
          `deliberately, rather than have one split silently.`,
      );
    }

    let quoted: RawMessage | undefined;
    if (request.reply_to_message_id) {
      const target = await this.buffer.get(chatId, request.reply_to_message_id);
      if (!target) {
        throw new BridgeError(
          `Message "${request.reply_to_message_id}" is not in this bridge's buffer ` +
            `for ${chatId}, so it cannot be quoted. Use an id from ` +
            `whatsapp_get_messages, or send without reply_to_message_id.`,
        );
      }
      quoted = {
        key: {
          remoteJid: chatId,
          id: target.id,
          fromMe: target.from_me,
          ...(isGroupJid(chatId) ? { participant: target.sender_alt_jid ?? target.sender_jid } : {}),
        },
        message: { conversation: target.text ?? "" },
      };
    }

    // The id is chosen HERE and persisted as the bridge's BEFORE anything is
    // sent. A send can reach WhatsApp and still fail on the way back (a
    // dropped socket, a timeout); if the id were only learned from the return
    // value, that message's echo would arrive unmarked and Zimmer — which drops
    // sent_by_bridge messages, and on a personal number cannot tell by
    // `from_me` — would answer its own post. Same shape as Baileys' own ids.
    const id = `3EB0${randomBytes(18).toString("hex").toUpperCase()}`;
    this.rememberSent(id);
    this.buffer.indexDirty = true;
    await this.flush().catch(() => {});

    const sent = await this.pacer.run(
      request.text,
      () => socket.sendPresenceUpdate("composing", chatId),
      () =>
        socket.sendMessage(
          chatId,
          { text: request.text },
          { messageId: id, ...(quoted ? { quoted } : {}) },
        ),
    );
    if (!sent?.key?.id) {
      throw new BridgeError(
        "WhatsApp returned no message for this send, so it may or may not have " +
          "been delivered. Check whatsapp_get_messages before sending again.",
      );
    }
    const timestamp = toSeconds(sent.messageTimestamp) ?? this.nowSeconds();
    this.recentSent.set(id, sent.message);
    if (this.recentSent.size > RECENT_SENT_KEEP) {
      this.recentSent.delete(this.recentSent.keys().next().value!);
    }
    await this.enqueue(async () => {
      await this.ingest({ ...sent, key: { ...sent.key, id }, messageTimestamp: timestamp });
      await this.buffer.markSentByBridge(chatId, id);
    });
    // The record, flushed before the call returns too, so a read after a crash
    // finds the message itself and not only its id.
    await this.flush().catch(() => {});
    return { id, timestamp };
  }

  private rememberSent(id: string): void {
    this.bridgeSent.add(id);
    if (this.bridgeSent.size > BRIDGE_SENT_KEEP) {
      this.bridgeSent.delete(this.bridgeSent.values().next().value!);
    }
  }

  async pair(phoneNumber: string): Promise<PairResult> {
    await this.ready();
    this.requireReadable();
    const digits = phoneNumber.replace(/[\s()+-]/g, "");
    if (!/^\d{8,15}$/.test(digits)) {
      throw new BridgeError(
        "`phone_number` must be the account's number in E.164 digits with the " +
          'country code and no "+", e.g. "15551234567".',
      );
    }
    const { socket, mine } = await this.openPairingSocket("code");

    const code = await socket.requestPairingCode(digits);
    if (mine !== this.generation) throw supersededPairing();
    if (this.pairing) {
      this.pairing.expiresAt = this.clock() + PAIRING_CODE_TTL_SECONDS * 1000;
    }
    logInfo("pairing (code): code issued; waiting for it to be entered on the phone");
    const clean = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return {
      pairing_code:
        clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean,
      expires_in_seconds: PAIRING_CODE_TTL_SECONDS,
      instructions: PAIRING_INSTRUCTIONS,
    };
  }

  /**
   * The QR route. Unlike a code, a QR is re-readable: while a QR attempt's
   * socket is alive, this returns the ref it is offering NOW rather than
   * starting over, so a human can call it again after a rotation and scan
   * what comes back.
   */
  async pairQr(): Promise<QrPairResult> {
    await this.ready();
    this.requireReadable();
    if (this.closed) throw new BridgeError("The bridge is shutting down.");
    const live =
      this.pairing?.method === "qr" && this.socket !== null && this.currentQr !== null;
    if (!live) {
      const { mine } = await this.openPairingSocket("qr");
      if (mine !== this.generation) throw supersededPairing();
    }
    const qr = this.currentQr;
    if (!qr) {
      throw new BridgeError(
        "The pairing session closed before it offered a QR. Call whatsapp_pair " +
          'with {"method":"qr"} again.',
      );
    }
    const left = Math.max(0, Math.ceil((qr.at + QR_REF_TTL_MS - this.clock()) / 1000));
    return {
      method: "qr",
      qr: qr.payload,
      expires_in_seconds: left,
      instructions: QR_INSTRUCTIONS,
      png: await qrPng(qr.payload),
    };
  }

  /**
   * Fresh credentials and a socket, and the wait for WhatsApp to offer it a
   * pairing session (its first QR ref). Both methods start here; a call
   * replaces any attempt already in flight, whose code or QR is then dead.
   */
  private async openPairingSocket(
    method: PairMethod,
  ): Promise<{ socket: WaSocket; mine: number }> {
    if (this.paired()) {
      throw new BridgeError(
        `Already paired as ${this.self().jid}. Pairing again would link a second ` +
          `device; call whatsapp_logout first if the intent is to replace it.`,
      );
    }
    if (this.closed) throw new BridgeError("The bridge is shutting down.");
    if (this.pairing) {
      logInfo(
        `pairing (${method}): replacing an earlier ${this.pairing.method} attempt; ` +
          "its code or QR no longer works",
      );
    }
    logInfo(`pairing (${method}): started as ${PAIRING_BROWSER[1]} on ${PAIRING_BROWSER[0]}`);

    // A fresh identity per attempt. Nothing is persisted until WhatsApp
    // accepts it (see doFlush: auth is written only once paired).
    this.auth = await createMemoryAuth(null, () => this.markAuthDirty());
    this.authDirty = false;
    const readyForCode = new Promise<void>((resolve) => {
      this.pairing = {
        method,
        expiresAt: this.clock() + PAIRING_CODE_TTL_SECONDS * 1000,
        ready: resolve,
      };
    });
    await this.connect();
    const socket = this.socket as WaSocket | null;
    if (!socket) throw new BridgeError("Could not open a WhatsApp socket to pair on.");
    // This attempt's socket. A later whatsapp_pair call replaces it, and this
    // call must then neither tear that one down nor hand out a code for it.
    const mine = this.generation;

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.pairingReadyTimeoutMs);
    });
    const outcome = await Promise.race([readyForCode, timedOut]);
    clearTimeout(timer);
    if (mine !== this.generation) throw supersededPairing();
    if (outcome === "timeout") {
      logWarning(`pairing (${method}): WhatsApp offered no pairing session in time`);
      this.pairing = null;
      this.dropSocket();
      this.auth = null;
      throw new BridgeError(
        "WhatsApp did not offer this device a pairing session in time. Retry " +
          "whatsapp_pair; if it keeps failing, WhatsApp may be refusing this " +
          "client version (see the README's ban-risk section).",
      );
    }
    return { socket, mine };
  }

  async logout(): Promise<{ ok: true; unlinked_on_phone: boolean }> {
    await this.ready().catch((err: unknown) => {
      // A superseded process must not wipe what the live one is using.
      if (err instanceof SupersededError) throw err;
    });
    let unlinked = false;
    if (this.socket && this.connected) {
      try {
        await this.socket.logout();
        unlinked = true;
      } catch (err) {
        logWarning(`logout request failed, wiping locally anyway: ${errMessage(err)}`);
      }
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropSocket();
    this.pairing = null;
    this.auth = null;
    this.authDirty = false;
    await this.ingesting;
    await this.wipe(async () => {
      await this.store.deleteAuth();
      await this.store.deleteBuffer();
    });
    this.buffer.indexDirty = false;
    this.recentSent.clear();
    this.ownerJid = null;
    this.stateError = null;
    this.lastDisconnectReason = "logged_out_by_tool";
    logInfo("logged out and wiped persisted state");
    return { ok: true, unlinked_on_phone: unlinked };
  }
}

// --- event payload shapes (structural) ------------------------------------------------------

interface Chat {
  id?: string | null;
  name?: string | null;
  conversationTimestamp?: number | string | { toNumber(): number } | null;
}

interface Contact {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

/** The HTTP status a failed CDN fetch carries, in either shape Baileys uses. */
function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; output?: { statusCode?: unknown } } | undefined;
  const code = e?.output?.statusCode ?? e?.status;
  return typeof code === "number" ? code : undefined;
}

/** WhatsApp's CDN no longer has this copy: the phone has to upload it again. */
const isGone = (err: unknown): boolean => {
  const code = statusOf(err);
  return code === 404 || code === 410;
};

function supersededPairing(): BridgeError {
  return new BridgeError(
    "A newer whatsapp_pair call replaced this one; use the code or QR it returned.",
  );
}

function reasonName(code: number | undefined): string {
  switch (code) {
    case undefined:
      return "connection_failed";
    case DISCONNECT.forbidden:
      return "forbidden";
    case DISCONNECT.timedOut:
      return "timed_out";
    case DISCONNECT.connectionClosed:
      return "connection_closed";
    case DISCONNECT.loggedOut:
      return "logged_out";
    case DISCONNECT.badSession:
      return "bad_session";
    case DISCONNECT.connectionReplaced:
      return "connection_replaced";
    case DISCONNECT.restartRequired:
      return "restart_required";
    case 503:
      return "service_unavailable";
    default:
      return `closed_${code}`;
  }
}
