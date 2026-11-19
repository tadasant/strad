/**
 * The Gmail API calls the ingest makes, and nothing else: the mailbox's
 * profile, `users.watch`, `users.history.list`, a message's METADATA, and
 * `users.messages.list` with a search query. Read-only apart from `watch`,
 * which changes no mail; all of it works on a `gmail.readonly` consent.
 *
 * Authentication is the mount's own client (`../gmail.ts`), handed in as a
 * function that returns request headers, so the token cache and the
 * reconnect hint on `invalid_grant` are the tools' own.
 *
 * Quota, in Gmail's units (per user, 6,000 a minute): history.list 2,
 * messages.get 20, messages.list 5, watch 100, getProfile 1.
 */
export type FetchLike = typeof fetch;

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Headers a received message is judged by. Never logged: every value is the sender's. */
export const METADATA_HEADERS = [
  "From",
  "To",
  "Subject",
  "Message-ID",
  "Auto-Submitted",
  "List-Id",
] as const;

const TIMEOUT_MS = 20_000;

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly what: string,
    detail: string,
  ) {
    super(`Gmail ${what}: HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "GmailApiError";
  }
}

export interface MessageMetadata {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Epoch ms, as a string, as Gmail sends it. */
  internalDate: string;
  snippet: string;
  headers: { name: string; value: string }[];
}

export interface HistoryPage {
  /** Ids of messages added in this page's records, with their labels at the time. */
  added: { id: string; labelIds: string[] }[];
  historyId: string;
  nextPageToken?: string;
}

export class GmailApi {
  constructor(
    private readonly headers: () => Promise<Record<string, string>>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base: string = GMAIL_API,
  ) {}

  private async call<T>(what: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers = await this.headers();
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...headers,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      // Google's own error message: a status and a reason, never mail content.
      let detail = "";
      try {
        const body = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof body.error?.message === "string") detail = body.error.message.slice(0, 300);
      } catch {
        detail = "";
      }
      throw new GmailApiError(res.status, what, detail);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.call("users.getProfile", "/profile");
  }

  async watch(topicName: string): Promise<{ historyId: string; expiration: string }> {
    return this.call("users.watch", "/watch", { method: "POST", body: { topicName } });
  }

  /** One page of `messageAdded` history after `startHistoryId`. A 404 means the id is too old. */
  async history(startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
    const q = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "500" });
    if (pageToken) q.set("pageToken", pageToken);
    const body = await this.call<{
      history?: { messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[] }[];
      historyId?: string;
      nextPageToken?: string;
    }>("users.history.list", `/history?${q}`);
    const added: HistoryPage["added"] = [];
    for (const h of body.history ?? []) {
      for (const a of h.messagesAdded ?? []) {
        if (a.message?.id) added.push({ id: a.message.id, labelIds: a.message.labelIds ?? [] });
      }
    }
    return { added, historyId: body.historyId ?? startHistoryId, nextPageToken: body.nextPageToken };
  }

  async metadata(id: string): Promise<MessageMetadata> {
    const q = new URLSearchParams({ format: "metadata" });
    for (const h of METADATA_HEADERS) q.append("metadataHeaders", h);
    const body = await this.call<{
      id?: string;
      threadId?: string;
      labelIds?: string[];
      internalDate?: string;
      snippet?: string;
      payload?: { headers?: { name?: string; value?: string }[] };
    }>("users.messages.get", `/messages/${encodeURIComponent(id)}?${q}`);
    return {
      id: body.id ?? id,
      threadId: body.threadId ?? "",
      labelIds: body.labelIds ?? [],
      internalDate: body.internalDate ?? "0",
      snippet: body.snippet ?? "",
      headers: (body.payload?.headers ?? [])
        .filter((h) => typeof h.name === "string" && typeof h.value === "string")
        .map((h) => ({ name: h.name!, value: h.value! })),
    };
  }

  /** Message ids matching a search, up to `max`. */
  async search(q: string, opts: { max: number; includeSpamTrash?: boolean }): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, maxResults: String(Math.min(500, opts.max - ids.length)) });
      if (opts.includeSpamTrash) params.set("includeSpamTrash", "true");
      if (pageToken) params.set("pageToken", pageToken);
      const body = await this.call<{ messages?: { id?: string }[]; nextPageToken?: string }>(
        "users.messages.list",
        `/messages?${params}`,
      );
      for (const m of body.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = body.nextPageToken;
    } while (pageToken && ids.length < opts.max);
    return ids;
  }
}
