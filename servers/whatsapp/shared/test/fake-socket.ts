/**
 * A fake WhatsApp socket: the `WaSocket` interface, driven by the test.
 *
 * It behaves like Baileys where the bridge depends on the behaviour:
 *   - `sendMessage` resolves with the WAMessage AND emits it through
 *     `messages.upsert` first (Baileys' `emitOwnEvents`), so the echo races
 *     the return value exactly as it does for real;
 *   - `requestPairingCode` writes `creds.me` with the `~` placeholder name,
 *     the way Baileys does, and emits `creds.update`;
 *   - `end()` emits a `close`, which the bridge must ignore for a socket it
 *     abandoned.
 *
 * Every identifier in these fixtures is invented.
 */
import { EventEmitter } from "node:events";
import type { AuthState, SocketFactory, SocketOptions, WaSocket } from "../src/socket.js";
import type { RawKey, RawMessage } from "../src/normalize.js";

export const SELF_PN = "15550000001@s.whatsapp.net";
export const SELF_LID = "900000000000001@lid";
export const GROUP = "120363000000000001@g.us";
export const GRACE_PN = "15550000002@s.whatsapp.net";
export const GRACE_LID = "900000000000002@lid";
export const ADA_PN = "15550000003@s.whatsapp.net";

export class FakeSocket implements WaSocket {
  readonly ev = new EventEmitter();
  readonly sent: { jid: string; text: string; quoted?: RawMessage }[] = [];
  readonly presence: string[] = [];
  pairingRequests: string[] = [];
  loggedOut = false;
  ended = false;
  failNextSendAfterDelivery = false;
  /** Media re-upload requests, and the URL the "phone" re-uploads to (none: it refuses). */
  readonly reuploads: RawMessage[] = [];
  reuploadTo: string | null = null;
  /** Resend asks, and what the "phone" answers each with (nothing: it is offline). */
  readonly resendRequests: RawKey[] = [];
  readonly historyRequests: { count: number; key: RawKey; timestampMs: number }[] = [];
  answerResend: ((key: RawKey) => RawMessage | null) | null = null;
  answerHistory: ((key: RawKey, count: number) => RawMessage[]) | null = null;
  /** A phone that never answers a re-upload request. */
  hangReupload = false;
  readonly forgottenResends: string[] = [];
  private counter = 0;

  constructor(
    readonly options: SocketOptions,
    private readonly now: () => number,
  ) {}

  get auth(): AuthState {
    return this.options.auth;
  }

  emit(event: string, payload: unknown): void {
    this.ev.emit(event, payload);
  }

  open(): void {
    this.emit("connection.update", { connection: "open" });
  }

  close(statusCode: number): void {
    this.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode } } },
    });
  }

  /** WhatsApp is ready for this device to register: Baileys emits a QR ref. */
  offerPairing(qr = "ref,noise,identity,adv"): void {
    this.emit("connection.update", { qr });
  }

  /** What Baileys does when the phone enters the code: it sends companion_finish. */
  phoneEnteredCode(): void {
    this.auth.creds.registered = true;
    this.emit("creds.update", { registered: true });
  }

  /** What Baileys does when the phone accepts the code (pair-success). */
  acceptPairing(): void {
    Object.assign(this.auth.creds, {
      me: { id: "15550000001:7@s.whatsapp.net", lid: "900000000000001:7@lid", name: "Bridge" },
      account: { details: "signed" },
      registered: true,
    });
    this.emit("creds.update", { me: this.auth.creds.me, account: this.auth.creds.account });
    this.emit("connection.update", { isNewLogin: true });
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    this.pairingRequests.push(phoneNumber);
    this.auth.creds.me = { id: `${phoneNumber}@s.whatsapp.net`, name: "~" };
    this.emit("creds.update", { me: this.auth.creds.me });
    return "ABCD2EFG";
  }

  async sendMessage(
    jid: string,
    content: { text: string },
    options?: { quoted?: RawMessage; messageId?: string },
  ): Promise<RawMessage | undefined> {
    if (this.failNextSendAfterDelivery) {
      // The stanza went out (the echo comes back) but the call fails.
      this.failNextSendAfterDelivery = false;
      this.emit("messages.upsert", {
        type: "append",
        messages: [
          {
            key: { remoteJid: jid, fromMe: true, id: options?.messageId ?? "LOST" },
            message: { conversation: content.text },
            messageTimestamp: Math.floor(this.now() / 1000),
          },
        ],
      });
      throw new Error("socket closed before the ack");
    }
    this.sent.push({ jid, text: content.text, ...(options?.quoted ? { quoted: options.quoted } : {}) });
    const message: RawMessage = {
      key: { remoteJid: jid, fromMe: true, id: options?.messageId ?? `3EB0SENT${++this.counter}` },
      message: options?.quoted
        ? { extendedTextMessage: { text: content.text, contextInfo: { stanzaId: options.quoted.key?.id } } }
        : { conversation: content.text },
      messageTimestamp: Math.floor(this.now() / 1000),
    };
    this.emit("messages.upsert", { type: "append", messages: [message] });
    return message;
  }

  async sendPresenceUpdate(type: "composing" | "paused", jid: string): Promise<void> {
    this.presence.push(`${type}:${jid}`);
  }

  async groupFetchAllParticipating() {
    return {
      [GROUP]: {
        id: GROUP,
        subject: "Wedding planning",
        participants: [{ id: SELF_LID }, { id: GRACE_LID }, { id: ADA_PN }],
      },
    };
  }

  /**
   * Baileys rewrites the content's `directPath` and `url` in place and
   * resolves with the same message; a phone that cannot answers with a Boom
   * whose `output.statusCode` is 404.
   */
  async updateMediaMessage(message: RawMessage): Promise<RawMessage> {
    this.reuploads.push(message);
    if (this.hangReupload) return new Promise<RawMessage>(() => {});
    if (!this.reuploadTo) {
      throw Object.assign(new Error("Media re-upload failed by device (NOT_FOUND)"), {
        output: { statusCode: 404 },
      });
    }
    const [kind] = Object.keys(message.message ?? {});
    const body = (message.message as Record<string, Record<string, unknown>>)[kind!]!;
    delete body.directPath;
    body.url = this.reuploadTo;
    return message;
  }

  /** The phone answers a resend as Baileys does: through `messages.upsert`. */
  async requestPlaceholderResend(key: RawKey): Promise<string | undefined> {
    this.resendRequests.push(key);
    const answer = this.answerResend?.(key);
    if (answer) {
      setTimeout(() => this.emit("messages.upsert", { type: "notify", messages: [answer] }), 5);
    }
    return "RESEND1";
  }

  /** And an on-demand history request through `messaging-history.set`. */
  async fetchMessageHistory(count: number, key: RawKey, timestampMs: number): Promise<string> {
    this.historyRequests.push({ count, key, timestampMs });
    const messages = this.answerHistory?.(key, count) ?? [];
    if (messages.length) {
      setTimeout(() => this.emit("messaging-history.set", { messages, chats: [], contacts: [] }), 5);
    }
    return "HISTORY1";
  }

  forgetPlaceholderResend(id: string): void {
    this.forgottenResends.push(id);
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.close(428);
  }
}

export interface FakeWhatsApp {
  factory: SocketFactory;
  sockets: FakeSocket[];
  latest(): FakeSocket;
  /** When set, every new socket opens itself (a restored, paired login). */
  autoOpen: boolean;
}

export function fakeWhatsApp(now: () => number = Date.now): FakeWhatsApp {
  const fake: FakeWhatsApp = {
    sockets: [],
    autoOpen: false,
    latest: () => fake.sockets[fake.sockets.length - 1]!,
    factory: async (options) => {
      const socket = new FakeSocket(options, now);
      fake.sockets.push(socket);
      if (fake.autoOpen) setTimeout(() => socket.open(), 0);
      return socket;
    },
  };
  return fake;
}

/** A group text message, as Baileys hands it over. */
export function groupText(
  id: string,
  timestamp: number,
  text: string,
  extra: { participant?: string; participantAlt?: string; contextInfo?: Record<string, unknown>; pushName?: string } = {},
): RawMessage {
  return {
    key: {
      remoteJid: GROUP,
      fromMe: false,
      id,
      participant: extra.participant ?? GRACE_LID,
      participantAlt: extra.participantAlt ?? GRACE_PN,
    },
    message: extra.contextInfo
      ? { extendedTextMessage: { text, contextInfo: extra.contextInfo } }
      : { conversation: text },
    messageTimestamp: timestamp,
    pushName: extra.pushName ?? "Grace",
  };
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}
