/**
 * The last hop of Gmail push: a Pub/Sub PULL subscription, long-polled.
 *
 * Gmail publishes `{emailAddress, historyId}` to a topic whenever the watched
 * mailbox changes. A push subscription would POST that to a public URL, and in
 * strad that URL would have to be core's (a bundle has no public ingress), so
 * core would grow an unauthenticated route, verify Google's OIDC token on it,
 * and forward to the right bundle mount. A pull subscription needs none of
 * that: the mount asks Pub/Sub, outbound, with the state store's service
 * account, the way Slack's ingest opens Socket Mode. `subscriptions.pull`
 * waits for a message rather than answering empty at once, so a notification
 * is read within about a second of being published.
 *
 * The notification is only a NUDGE. The mount reads what changed from
 * `history.list`, from its own stored history id, so a notification that is
 * lost, duplicated or out of order changes nothing but latency. Each one is
 * acknowledged as soon as it is read.
 */
import { createSign } from "node:crypto";
import type { FetchLike } from "./gmail-api.js";

const PUBSUB_API = "https://pubsub.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/pubsub";
/** A pull with nothing to return is held by Pub/Sub for a while; give up on our side after this. */
export const PULL_TIMEOUT_MS = 60_000;

export class PubSubError extends Error {
  constructor(
    readonly status: number,
    what: string,
    detail: string,
  ) {
    super(`Pub/Sub ${what}: HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "PubSubError";
  }
}

export interface GmailNotification {
  emailAddress: string | null;
  historyId: string | null;
}

export interface PubSubOptions {
  clientEmail: string;
  privateKey: string;
  fetch?: FetchLike;
  /** Tests only. */
  apiBase?: string;
  tokenUrl?: string;
  clock?: () => number;
}

const b64url = (s: string): string => Buffer.from(s).toString("base64url");

export class PubSubPuller {
  private token?: { value: string; expiresAt: number };
  /** The last acknowledge failure, or null. */
  lastAckError: string | null = null;
  private pendingToken?: Promise<string>;
  private readonly fetchImpl: FetchLike;
  private readonly api: string;
  private readonly tokenUrl: string;
  private readonly clock: () => number;

  constructor(
    private readonly subscription: string,
    private readonly options: PubSubOptions,
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.api = options.apiBase ?? PUBSUB_API;
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL;
    this.clock = options.clock ?? Date.now;
  }

  private accessToken(): Promise<string> {
    if (this.token && this.clock() < this.token.expiresAt) return Promise.resolve(this.token.value);
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const now = Math.floor(this.clock() / 1000);
    const unsigned =
      b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
      "." +
      b64url(JSON.stringify({ iss: this.options.clientEmail, scope: SCOPE, aud: this.tokenUrl, iat: now, exp: now + 3600 }));
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(this.options.privateKey, "base64url");
    } catch {
      throw new Error("STRAD_STATE_GCS_PRIVATE_KEY is not a usable PEM private key.");
    }
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new PubSubError(res.status, "token", errorDetail(text));
    const body = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.token = {
      value: body.access_token,
      expiresAt: this.clock() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000,
    };
    return body.access_token;
  }

  /** Waits for notifications, acknowledges what it read, returns them. Empty on a quiet timeout. */
  async pull(signal?: AbortSignal): Promise<GmailNotification[]> {
    const token = await this.accessToken();
    const timeout = AbortSignal.timeout(PULL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.api}/${this.subscription}:pull`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ maxMessages: 100 }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      // Our own timeout on a quiet subscription is the ordinary empty answer.
      if (timeout.aborted && !signal?.aborted) return [];
      throw err;
    }
    const text = await res.text();
    if (!res.ok) throw new PubSubError(res.status, "pull", errorDetail(text));
    const body = (text ? JSON.parse(text) : {}) as {
      receivedMessages?: { ackId?: string; message?: { data?: string } }[];
    };
    const received = body.receivedMessages ?? [];
    const ackIds = received.map((m) => m.ackId).filter((id): id is string => typeof id === "string");
    if (ackIds.length > 0) {
      try {
        await this.acknowledge(token, ackIds);
        this.lastAckError = null;
      } catch (err) {
        // An unacknowledged nudge is redelivered after the ack deadline: one
        // more history.list, no harm. Kept for the status, never thrown, so the
        // notifications already read still count.
        this.lastAckError = err instanceof Error ? err.message : String(err);
      }
    }
    return received.map((m) => parseNotification(m.message?.data));
  }

  private async acknowledge(token: string, ackIds: string[]): Promise<void> {
    const res = await this.fetchImpl(`${this.api}/${this.subscription}:acknowledge`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ackIds }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new PubSubError(res.status, "acknowledge", errorDetail(await res.text()));
  }
}

/** Gmail's notification: base64 JSON `{"emailAddress": …, "historyId": …}`. Anything else reads as an anonymous nudge. */
export function parseNotification(data: string | undefined): GmailNotification {
  try {
    const body = JSON.parse(Buffer.from(data ?? "", "base64").toString("utf8")) as {
      emailAddress?: unknown;
      historyId?: unknown;
    };
    return {
      emailAddress: typeof body.emailAddress === "string" ? body.emailAddress : null,
      historyId:
        typeof body.historyId === "string" || typeof body.historyId === "number" ? String(body.historyId) : null,
    };
  } catch {
    return { emailAddress: null, historyId: null };
  }
}

function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; error_description?: unknown };
    if (typeof body.error === "object" && typeof body.error?.message === "string") return body.error.message.slice(0, 300);
    return [body.error, body.error_description].filter((x) => typeof x === "string").join(": ").slice(0, 300);
  } catch {
    return "";
  }
}
