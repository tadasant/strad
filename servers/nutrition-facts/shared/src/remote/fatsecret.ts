/**
 * The FatSecret Platform API, Basic tier: the one source this server calls
 * live on every lookup.
 *
 * Two methods, both free on Basic:
 *   - foods.search v1  GET /rest/foods/search/v1  (v2–v4 are deprecated, v5 is Premier)
 *   - food.get v5      GET /rest/food/v5
 * OAuth 2.0 client credentials against https://oauth.fatsecret.com/connect/token,
 * scope `basic`. A token lives 24 hours and is reused until a minute before it
 * expires.
 *
 * THE QUOTA IS 5,000 CALLS A DAY, and three things keep this server inside it:
 *   1. Every response is cached for 23 hours (cache.ts; FatSecret allows 24).
 *   2. An estimate spends at most two calls per component — one search, one
 *      food.get for the best match. Runners-up come from the search page's own
 *      summary line, which costs nothing more.
 *   3. A daily budget, counted in this process, stops calling at 4,500 and
 *      reports FatSecret `unavailable` for the rest of the UTC day. The margin
 *      is for the other bundle instances and restarts this counter cannot see.
 *
 * FatSecret answers most API errors with HTTP 200 and an `{error:{code,
 * message}}` body, so the body is checked on every response.
 *
 * EVERY REQUEST GOES THROUGH THE PROXY — the OAuth token POST and every API
 * GET — as an ordinary HTTP forward proxy (CONNECT for https), via undici's
 * `ProxyAgent` as the fetch dispatcher. A FatSecret key answers only the IPs
 * allowlisted in its console, and the proxy's dedicated exit IPs are the ones
 * on that list; strad's own egress is not. There is no direct fallback: with no
 * proxy configured, FatSecret is unconfigured and nothing here touches the
 * network. A rotating-IP scraping API cannot stand in for it — the exit IP has
 * to be stable, and the token call is a POST.
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

import { SourceUnavailable } from "../candidate.js";
import type { FatSecretCredentials } from "../config.js";
import { TtlCache } from "./cache.js";

export const TOKEN_URL = "https://oauth.fatsecret.com/connect/token";
export const API_BASE = "https://platform.fatsecret.com/rest";
export const DAILY_CALL_BUDGET = 4_500;
export const REQUEST_TIMEOUT_MS = 10_000;

/** FatSecret's required attribution (https://platform.fatsecret.com/attribution). */
export const ATTRIBUTION = {
  text: "Powered by fatsecret Platform API",
  url: "https://platform.fatsecret.com",
  html: '<a href="https://platform.fatsecret.com">Powered by fatsecret Platform API</a>',
} as const;

export interface FsSearchFood {
  food_id: string;
  food_name: string;
  food_type: string;
  brand_name?: string;
  food_url?: string;
  food_description?: string;
}

export interface FsServing {
  serving_id?: string;
  serving_description?: string;
  metric_serving_amount?: string;
  metric_serving_unit?: string;
  number_of_units?: string;
  measurement_description?: string;
  calories?: string;
  protein?: string;
  carbohydrate?: string;
  fat?: string;
  fiber?: string;
  sugar?: string;
  saturated_fat?: string;
  sodium?: string;
}

export interface FsFood {
  food_id: string;
  food_name: string;
  food_type: string;
  brand_name?: string;
  food_url?: string;
  servings: FsServing[];
}

/** FatSecret returns an object, not a one-element array, for a single result. */
function list<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** What a FatSecret error code means for the caller. */
function describeFsError(code: number, message: string): string {
  switch (code) {
    case 11:
      return "FatSecret's daily request limit for this application is reached (error 11); it resets at the end of the day.";
    case 13:
      return "FatSecret rejected the access token (error 13).";
    case 14:
      return "FatSecret says the client lacks the `basic` scope (error 14).";
    case 21:
      return (
        "FatSecret refused the caller's IP address (error 21). Every call leaves " +
        "through FATSECRET_PROXY_URL, so the proxy's exit IP is not on the key's " +
        "allowlist in the FatSecret Platform console — add it there."
      );
    case 20:
    case 24:
      return `FatSecret is temporarily unavailable (error ${code}).`;
    default:
      return `FatSecret error ${code}: ${message.slice(0, 200)}`;
  }
}

/**
 * The transport: a fetch that honours `dispatcher`. Production is undici's own
 * `fetch`, so the `ProxyAgent` below is always the undici version it expects.
 */
export interface ProxiedInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  dispatcher: Dispatcher;
}

export type ProxiedFetch = (url: string, init: ProxiedInit) => Promise<Response>;

export interface FatSecretOptions {
  config: () => { ok: true; value: FatSecretCredentials } | { ok: false; reason: string };
  fetch?: ProxiedFetch;
  /** Injected in tests. Production builds a `ProxyAgent` for the proxy URL. */
  dispatcher?: (proxyUrl: string) => Dispatcher;
  now?: () => number;
  tokenUrl?: string;
  apiBase?: string;
  dailyBudget?: number;
}

export class FatSecretClient {
  private token?: { value: string; expiresAt: number; clientId: string };
  private readonly cache = new TtlCache<unknown>();
  private day = "";
  private calls = 0;
  private readonly fetchImpl: ProxiedFetch;
  private readonly now: () => number;
  private agent?: { proxyUrl: string; dispatcher: Dispatcher };

  constructor(private readonly options: FatSecretOptions) {
    this.fetchImpl =
      options.fetch ?? ((url, init) => undiciFetch(url, init as never) as unknown as Promise<Response>);
    this.now = options.now ?? Date.now;
  }

  /** Calls spent today (UTC) by this process. */
  get callsToday(): number {
    this.rollDay();
    return this.calls;
  }

  configured(): boolean {
    return this.options.config().ok;
  }

  /** Why FatSecret cannot be asked, or undefined when it can. */
  unconfiguredReason(): string | undefined {
    const c = this.options.config();
    return c.ok ? undefined : c.reason;
  }

  /** One dispatcher per proxy URL, reused so connections to the proxy pool. */
  private dispatcherFor(proxyUrl: string): Dispatcher {
    if (this.agent?.proxyUrl !== proxyUrl) {
      const make = this.options.dispatcher ?? ((url: string) => new ProxyAgent(url));
      this.agent = { proxyUrl, dispatcher: make(proxyUrl) };
    }
    return this.agent.dispatcher;
  }

  async search(expression: string, maxResults = 10): Promise<FsSearchFood[]> {
    const body = await this.call<{
      foods?: { food?: FsSearchFood | FsSearchFood[] };
    }>("/foods/search/v1", {
      search_expression: expression,
      max_results: String(Math.min(Math.max(maxResults, 1), 50)),
      page_number: "0",
    });
    return list(body.foods?.food);
  }

  async getFood(foodId: string): Promise<FsFood> {
    const body = await this.call<{
      food?: Omit<FsFood, "servings"> & {
        servings?: { serving?: FsServing | FsServing[] };
      };
    }>("/food/v5", { food_id: foodId });
    if (!body.food) {
      throw new SourceUnavailable(`FatSecret returned no food for id ${foodId}.`);
    }
    const { servings, ...rest } = body.food;
    return { ...rest, servings: list(servings?.serving) };
  }

  private rollDay(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.calls = 0;
    }
  }

  private async call<T>(path: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams({ ...params, format: "json" }).toString();
    const key = `${path}?${query}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as T;

    const config = this.options.config();
    if (!config.ok) throw new SourceUnavailable(config.reason);
    const credentials = config.value;

    this.rollDay();
    const budget = this.options.dailyBudget ?? DAILY_CALL_BUDGET;
    if (this.calls >= budget) {
      throw new SourceUnavailable(
        `FatSecret's daily call budget in this server (${budget} of the Basic ` +
          `tier's 5,000) is spent; it resets at 00:00 UTC. Cached results are still served.`,
      );
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(credentials, attempt > 0);
      this.calls += 1;
      const res = await this.request(
        credentials,
        `${this.options.apiBase ?? API_BASE}${path}?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const body = (await this.json(res)) as T & {
        error?: { code?: number | string; message?: string };
      };
      if (body.error) {
        const code = Number(body.error.code);
        // An expired or revoked token: mint one more and retry once.
        if (code === 13 && attempt === 0) continue;
        throw new SourceUnavailable(describeFsError(code, String(body.error.message ?? "")));
      }
      if (!res.ok) {
        throw new SourceUnavailable(`FatSecret answered HTTP ${res.status}.`);
      }
      this.cache.set(key, body);
      return body;
    }
    throw new SourceUnavailable("FatSecret rejected two fresh access tokens.");
  }

  private async accessToken(
    credentials: FatSecretCredentials,
    force: boolean,
  ): Promise<string> {
    const t = this.token;
    if (
      !force &&
      t &&
      t.clientId === credentials.clientId &&
      t.expiresAt - 60_000 > this.now()
    ) {
      return t.value;
    }
    const basic = Buffer.from(
      `${credentials.clientId}:${credentials.clientSecret}`,
    ).toString("base64");
    const res = await this.request(credentials, this.options.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=basic",
    });
    const body = (await this.json(res)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new SourceUnavailable(
        body.error === "invalid_client"
          ? "FatSecret rejected the client id / secret (invalid_client)."
          : `FatSecret's token endpoint answered HTTP ${res.status}${body.error ? ` (${body.error})` : ""}.`,
      );
    }
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000,
      clientId: credentials.clientId,
    };
    return body.access_token;
  }

  /**
   * Send one request through the proxy. A failure to get a response at all is
   * reported as the PROXY's ("through the FatSecret proxy"), so it reads
   * differently from a FatSecret API error, which always arrives as a response
   * (an `{error}` body or an HTTP status). The proxy URL carries a password and
   * is scrubbed from anything this says.
   */
  private async request(
    credentials: FatSecretCredentials,
    url: string,
    init: Pick<ProxiedInit, "method" | "headers" | "body">,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        dispatcher: this.dispatcherFor(credentials.proxyUrl),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err instanceof Error && err.name === "TimeoutError";
      if (timeout) {
        throw new SourceUnavailable(
          `FatSecret did not answer through the FatSecret proxy within ${REQUEST_TIMEOUT_MS / 1000}s.`,
        );
      }
      throw new SourceUnavailable(
        `FatSecret could not be reached: the FatSecret proxy (FATSECRET_PROXY_URL) failed — ` +
          `${scrubProxy(describeNetworkError(err), credentials.proxyUrl)}. ` +
          `This is the proxy or the network, not a FatSecret API error.`,
      );
    }
  }

  private async json(res: Response): Promise<unknown> {
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object") return body;
    } catch {
      // fall through
    }
    throw new SourceUnavailable(
      `FatSecret answered HTTP ${res.status} with a body that is not JSON.`,
    );
  }
}

/** The innermost useful message of a network error (undici nests its cause). */
function describeNetworkError(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 4; depth++) {
    if (e instanceof Error) {
      const code = (e as { code?: unknown }).code;
      parts.push(typeof code === "string" ? `${e.message} (${code})` : e.message);
      e = (e as { cause?: unknown }).cause;
    } else {
      parts.push(String(e));
      break;
    }
  }
  return (parts.filter(Boolean).pop() ?? "network error").slice(0, 200);
}

/** Remove the proxy URL, its password and its username from text. */
export function scrubProxy(text: string, proxyUrl: string): string {
  let out = text.split(proxyUrl).join("[proxy]");
  try {
    const u = new URL(proxyUrl);
    for (const secret of [u.password, decodeURIComponent(u.password), u.username]) {
      if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
    }
  } catch {
    // An unparseable URL never reaches a request; nothing more to remove.
  }
  return out;
}
