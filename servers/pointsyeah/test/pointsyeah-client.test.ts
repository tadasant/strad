/**
 * The PointsYeah client's request-building and response-shaping.
 *
 * The client reaches PointsYeah two ways, and both are covered here without
 * leaving the process:
 *
 *   - plain HTTP to Cognito and `api2.pointsyeah.com` — `fetch` is stubbed, so a
 *     test asserts the exact URL, method, headers and body a call assembles and
 *     drives the response it gets back;
 *   - a real browser, for the one request PointsYeah encrypts client-side —
 *     `createSearchTask` takes its Playwright surface as an injected dependency
 *     (`PlaywrightSearchDeps`), so the suite hands it a fake context and page.
 *
 * Nothing in this file opens a socket, launches a browser, or reads a
 * credential. Every token below is a synthetic JWT built by `jwt()` with a
 * literal `signature` — none is a PointsYeah credential and none would verify.
 *
 * Tests live at the TREE root rather than in `shared/`, which is a verbatim
 * vendor copy of pulsemcp/mcp-servers (HACKS.md #15 and #19) — a test file added
 * there would be a merge conflict on every re-vendor. They import the vendored
 * TypeScript sources directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COGNITO_CLIENT_ID,
  COGNITO_ENDPOINT,
  API2_BASE,
} from "../shared/src/constants.js";
import type { FlightSearchParams } from "../shared/src/types.js";
import {
  refreshCognitoTokens,
  getUserSubFromIdToken,
} from "../shared/src/pointsyeah-client/lib/auth.js";
import {
  buildSearchUrl,
  createSearchTask,
} from "../shared/src/pointsyeah-client/lib/search.js";
import type {
  PlaywrightBrowserContext,
  PlaywrightPage,
  PlaywrightResponse,
  PlaywrightSearchDeps,
} from "../shared/src/pointsyeah-client/lib/search.js";
import { fetchSearchResults } from "../shared/src/pointsyeah-client/lib/fetch-results.js";
import { getSearchHistory } from "../shared/src/pointsyeah-client/lib/user-api.js";

// =============================================================================
// FIXTURES
// =============================================================================

/** A synthetic JWT. Three base64url parts; the signature is the word. */
function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.signature`;
}

const SUB = "11111111-2222-3333-4444-555555555555";
const ID_TOKEN = jwt({ sub: SUB, exp: 2_000_000_000 });
const ACCESS_TOKEN = jwt({ exp: 1_700_000_600 });
const REFRESH_TOKEN = "not-a-real-refresh-token";

/** The full-fat search params, so a test can narrow one field at a time. */
function params(overrides: Partial<FlightSearchParams> = {}): FlightSearchParams {
  return {
    departure: "SFO",
    arrival: "NYC",
    departDate: "2026-09-01",
    returnDate: "2026-09-08",
    tripType: "2",
    adults: 1,
    children: 0,
    cabins: ["Economy", "Business"],
    ...overrides,
  };
}

// =============================================================================
// THE FETCH STUB
// =============================================================================

type FetchCall = { url: string; init: RequestInit };

/** A queued HTTP reply. `json` is only read when `ok`. */
type Reply =
  | { ok: true; json: unknown }
  | { ok: false; status: number; statusText?: string; body?: string };

const calls: FetchCall[] = [];
const replies: Reply[] = [];

function reply(next: Reply): void {
  replies.push(next);
}

/** The one call the suite made. Fails loudly rather than returning undefined. */
function onlyCall(): FetchCall {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

function body(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headers(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

beforeEach(() => {
  calls.length = 0;
  replies.length = 0;
  // `logError` writes the upstream body to stderr on a failed refresh. Silenced
  // so a passing run stays readable; the message under test is the thrown one.
  vi.spyOn(console, "error").mockImplementation(() => {});

  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.shift();
    // An unqueued call throws rather than inventing a successful response: a
    // test that reaches the network in a shape nobody expected should fail.
    if (!next) {
      throw new Error(`unexpected fetch: ${String(url)}`);
    }
    if (next.ok) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(next.json),
        text: () => Promise.resolve(JSON.stringify(next.json)),
      });
    }
    return Promise.resolve({
      ok: false,
      status: next.status,
      statusText: next.statusText ?? "",
      json: () => Promise.resolve(undefined),
      text: () => Promise.resolve(next.body ?? ""),
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// =============================================================================
// AUTH
// =============================================================================

describe("refreshing Cognito tokens", () => {
  it("posts the InitiateAuth envelope Cognito expects", async () => {
    reply({
      ok: true,
      json: {
        AuthenticationResult: {
          AccessToken: ACCESS_TOKEN,
          IdToken: ID_TOKEN,
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      },
    });

    await refreshCognitoTokens(REFRESH_TOKEN);

    const call = onlyCall();
    expect(call.url).toBe(COGNITO_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(headers(call)).toEqual({
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    });
    expect(body(call)).toEqual({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN },
    });
  });

  it("carries the refresh token in the body, never in the URL", async () => {
    reply({
      ok: true,
      json: {
        AuthenticationResult: {
          AccessToken: ACCESS_TOKEN,
          IdToken: ID_TOKEN,
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      },
    });

    await refreshCognitoTokens(REFRESH_TOKEN);

    // A credential in a query string is a credential in every proxy log.
    expect(onlyCall().url).not.toContain(REFRESH_TOKEN);
  });

  it("bounds the call with an abort signal", async () => {
    reply({
      ok: true,
      json: {
        AuthenticationResult: {
          AccessToken: ACCESS_TOKEN,
          IdToken: ID_TOKEN,
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      },
    });

    await refreshCognitoTokens(REFRESH_TOKEN);

    expect(onlyCall().init.signal).toBeInstanceOf(AbortSignal);
  });

  it("takes the expiry from the access token's own exp claim", async () => {
    reply({
      ok: true,
      json: {
        AuthenticationResult: {
          AccessToken: jwt({ exp: 1_800_000_000 }),
          IdToken: ID_TOKEN,
          // Deliberately disagrees with the claim: the claim is what Cognito
          // will actually enforce, so it is what the client must believe.
          ExpiresIn: 60,
          TokenType: "Bearer",
        },
      },
    });

    const tokens = await refreshCognitoTokens(REFRESH_TOKEN);

    expect(tokens.expiresAt).toBe(1_800_000_000);
  });

  it("falls back to now + ExpiresIn when the access token carries no exp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); // 1767225600
    reply({
      ok: true,
      json: {
        AuthenticationResult: {
          AccessToken: jwt({ token_use: "access" }),
          IdToken: ID_TOKEN,
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      },
    });

    const tokens = await refreshCognitoTokens(REFRESH_TOKEN);

    expect(tokens.expiresAt).toBe(1_767_225_600 + 3600);
  });

  it("returns the access and id tokens under the client's own names", async () => {
    reply({
      ok: true,
      json: {
        AuthenticationResult: {
          AccessToken: ACCESS_TOKEN,
          IdToken: ID_TOKEN,
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      },
    });

    const tokens = await refreshCognitoTokens(REFRESH_TOKEN);

    expect(tokens).toEqual({
      accessToken: ACCESS_TOKEN,
      idToken: ID_TOKEN,
      expiresAt: 1_700_000_600,
    });
  });

  it("turns a revoked refresh token into the re-login instruction", async () => {
    reply({
      ok: false,
      status: 400,
      body: JSON.stringify({
        __type: "NotAuthorizedException",
        message: "Refresh Token has been revoked",
      }),
    });

    await expect(refreshCognitoTokens(REFRESH_TOKEN)).rejects.toThrow(
      /re-login to PointsYeah and update POINTSYEAH_REFRESH_TOKEN/,
    );
  });

  it("reports any other Cognito failure with its status and body", async () => {
    reply({ ok: false, status: 503, body: "upstream unavailable" });

    await expect(refreshCognitoTokens(REFRESH_TOKEN)).rejects.toThrow(
      "Cognito token refresh failed: 503 upstream unavailable",
    );
  });

  it("does not leak the refresh token into the error it throws", async () => {
    reply({ ok: false, status: 503, body: "upstream unavailable" });

    // The message is built from the STATUS and the upstream body, and an MCP
    // tool error is text a caller reads.
    const error = await refreshCognitoTokens(REFRESH_TOKEN).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(REFRESH_TOKEN);
  });
});

describe("reading the user out of an id token", () => {
  it("returns the sub claim", () => {
    expect(getUserSubFromIdToken(ID_TOKEN)).toBe(SUB);
  });

  it("survives a payload that encodes to the URL-safe alphabet", () => {
    // This payload's base64url form is `eyJzdWIiOiI-bzk_bHQyZCJ9` — it uses both
    // `-` and `_`, and carries no padding, which is the shape a real Cognito JWT
    // arrives in. The claim comes back byte for byte.
    const sub = ">o9?lt2d";
    expect(Buffer.from(JSON.stringify({ sub })).toString("base64url")).toContain(
      "-",
    );
    expect(getUserSubFromIdToken(jwt({ sub }))).toBe(sub);
  });

  it("rejects a token that is not three dot-separated parts", () => {
    expect(() => getUserSubFromIdToken("not.a-jwt")).toThrow(
      "Invalid JWT format",
    );
  });

  it("rejects a token whose payload has no string sub", () => {
    expect(() => getUserSubFromIdToken(jwt({ exp: 1 }))).toThrow(
      "Could not extract user sub from ID token",
    );
    expect(() => getUserSubFromIdToken(jwt({ sub: 42 }))).toThrow(
      "Could not extract user sub from ID token",
    );
  });
});

// =============================================================================
// SEARCH URL
// =============================================================================

describe("building the search URL", () => {
  it("points at the PointsYeah search page", () => {
    const url = new URL(buildSearchUrl(params()));
    expect(url.origin).toBe("https://www.pointsyeah.com");
    expect(url.pathname).toBe("/search");
  });

  it("carries the itinerary the caller asked for", () => {
    const q = new URL(
      buildSearchUrl(
        params({
          departure: "LAX",
          arrival: "LHR",
          departDate: "2026-11-02",
          returnDate: "2026-11-20",
          tripType: "2",
          adults: 3,
          children: 2,
        }),
      ),
    ).searchParams;

    expect(q.get("departure")).toBe("LAX");
    expect(q.get("arrival")).toBe("LHR");
    expect(q.get("departDate")).toBe("2026-11-02");
    expect(q.get("returnDate")).toBe("2026-11-20");
    expect(q.get("tripType")).toBe("2");
    expect(q.get("adults")).toBe("3");
    expect(q.get("children")).toBe("2");
  });

  it("mirrors each date into its `Sec` twin", () => {
    const q = new URL(
      buildSearchUrl(
        params({ departDate: "2026-09-01", returnDate: "2026-09-08" }),
      ),
    ).searchParams;

    expect(q.get("departDateSec")).toBe(q.get("departDate"));
    expect(q.get("returnDateSec")).toBe(q.get("returnDate"));
  });

  it("omits both return keys for a one-way search", () => {
    const q = new URL(
      buildSearchUrl(params({ tripType: "1", returnDate: undefined })),
    ).searchParams;

    expect(q.has("returnDate")).toBe(false);
    expect(q.has("returnDateSec")).toBe(false);
    expect(q.get("tripType")).toBe("1");
  });

  it("joins the cabins and leads with the first one", () => {
    const q = new URL(
      buildSearchUrl(params({ cabins: ["Premium Economy", "First"] })),
    ).searchParams;

    expect(q.get("cabins")).toBe("Premium Economy,First");
    expect(q.get("cabin")).toBe("Premium Economy");
  });

  it("falls back to Economy as the primary cabin when the list is empty", () => {
    const q = new URL(buildSearchUrl(params({ cabins: [] }))).searchParams;

    expect(q.get("cabins")).toBe("");
    expect(q.get("cabin")).toBe("Economy");
  });

  it("sends the default banks and airline programs, and never a search-time override", () => {
    const q = new URL(buildSearchUrl(params())).searchParams;

    // Not caller-controllable: `FlightSearchParams` has no bank or program
    // field, so every search is the full default sweep.
    expect(q.get("banks")).toBe("Amex,Bilt,Capital+One,Chase,Citi,WF");
    expect(q.get("airlineProgram")?.split(",")).toHaveLength(21);
    expect(q.get("airlineProgram")?.split(",")).toContain("UA");
  });

  it("sends multiday=false", () => {
    expect(
      new URL(buildSearchUrl(params())).searchParams.get("multiday"),
    ).toBe("false");
  });

  it("percent-encodes the query rather than emitting raw separators", () => {
    const raw = buildSearchUrl(params({ cabins: ["Economy", "Business"] }));

    expect(raw).toContain("cabins=Economy%2CBusiness");
    expect(raw).not.toContain("cabins=Economy,Business");
  });
});

// =============================================================================
// CREATE SEARCH TASK (the Playwright leg)
// =============================================================================

type FakeBrowser = {
  deps: PlaywrightSearchDeps;
  cookies: Array<{ name: string; value: string; domain: string; path: string }>;
  gotos: Array<{ url: string; options?: { waitUntil?: string; timeout?: number } }>;
  predicates: Array<(response: PlaywrightResponse) => boolean>;
  order: string[];
  closed: { page: number; context: number };
};

/**
 * A fake Playwright context/page pair.
 *
 * `respond` is what the intercepted `create_task` response resolves to. The fake
 * records the order of its calls, because the interception has to be armed
 * BEFORE the navigation — a `waitForResponse` registered after `goto` would race
 * the real site and fail in production, not here.
 */
function fakeBrowser(respond: () => Promise<unknown>): FakeBrowser {
  const state: FakeBrowser = {
    deps: { launchBrowser: async () => context },
    cookies: [],
    gotos: [],
    predicates: [],
    order: [],
    closed: { page: 0, context: 0 },
  };

  const page: PlaywrightPage = {
    goto: async (url, options) => {
      state.order.push("goto");
      state.gotos.push({ url, options });
    },
    waitForResponse: async (predicate) => {
      state.order.push("waitForResponse");
      state.predicates.push(predicate);
      return {
        url: () => "https://api2.pointsyeah.com/flight/search/create_task",
        json: respond,
      };
    },
    close: async () => {
      state.order.push("page.close");
      state.closed.page += 1;
    },
  };

  const context: PlaywrightBrowserContext = {
    addCookies: async (cookies) => {
      state.order.push("addCookies");
      state.cookies = cookies;
    },
    newPage: async () => page,
    close: async () => {
      state.order.push("context.close");
      state.closed.context += 1;
    },
  };

  state.deps = { launchBrowser: async () => context };
  return state;
}

const TASK = { task_id: "task-abc", total_sub_tasks: 4, status: "processing" };

function taskOk(): Promise<unknown> {
  return Promise.resolve({ code: 200, success: true, data: TASK });
}

describe("creating a search task through the browser", () => {
  it("returns the task the site's create_task response carried", async () => {
    const browser = fakeBrowser(taskOk);

    const task = await createSearchTask(
      params(),
      ACCESS_TOKEN,
      ID_TOKEN,
      REFRESH_TOKEN,
      browser.deps,
    );

    expect(task).toEqual(TASK);
  });

  it("navigates to exactly the URL buildSearchUrl produces", async () => {
    const browser = fakeBrowser(taskOk);
    const p = params({ departure: "SEA", arrival: "HND" });

    await createSearchTask(
      p,
      ACCESS_TOKEN,
      ID_TOKEN,
      REFRESH_TOKEN,
      browser.deps,
    );

    expect(browser.gotos).toHaveLength(1);
    expect(browser.gotos[0]!.url).toBe(buildSearchUrl(p));
    expect(browser.gotos[0]!.options).toEqual({
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  });

  it("arms the response interception before it navigates", async () => {
    const browser = fakeBrowser(taskOk);

    await createSearchTask(
      params(),
      ACCESS_TOKEN,
      ID_TOKEN,
      REFRESH_TOKEN,
      browser.deps,
    );

    expect(browser.order.indexOf("waitForResponse")).toBeLessThan(
      browser.order.indexOf("goto"),
    );
  });

  it("intercepts create_task and nothing else", async () => {
    const browser = fakeBrowser(taskOk);

    await createSearchTask(
      params(),
      ACCESS_TOKEN,
      ID_TOKEN,
      REFRESH_TOKEN,
      browser.deps,
    );

    const matches = (url: string) =>
      browser.predicates[0]!({ url: () => url, json: taskOk });

    expect(
      matches("https://api2.pointsyeah.com/flight/search/create_task"),
    ).toBe(true);
    expect(
      matches("https://api2.pointsyeah.com/flight/search/create_task?x=1"),
    ).toBe(true);
    expect(
      matches("https://api2.pointsyeah.com/flight/search/fetch_result"),
    ).toBe(false);
    expect(matches("https://www.pointsyeah.com/search?departure=SFO")).toBe(
      false,
    );
  });

  it("injects the six Cognito localStorage entries as cookies", async () => {
    const browser = fakeBrowser(taskOk);

    await createSearchTask(
      params(),
      ACCESS_TOKEN,
      ID_TOKEN,
      REFRESH_TOKEN,
      browser.deps,
    );

    const prefix = `CognitoIdentityServiceProvider.${COGNITO_CLIENT_ID}`;
    const byName = new Map(browser.cookies.map((c) => [c.name, c.value]));

    expect(browser.cookies).toHaveLength(6);
    expect(byName.get(`${prefix}.${SUB}.accessToken`)).toBe(ACCESS_TOKEN);
    expect(byName.get(`${prefix}.${SUB}.idToken`)).toBe(ID_TOKEN);
    expect(byName.get(`${prefix}.${SUB}.refreshToken`)).toBe(REFRESH_TOKEN);
    expect(byName.get(`${prefix}.${SUB}.clockDrift`)).toBe("0");
    expect(
      JSON.parse(byName.get(`${prefix}.${SUB}.signInDetails`)!) as unknown,
    ).toEqual({ loginId: "", authFlowType: "USER_SRP_AUTH" });
    // The unprefixed one: Amplify reads LastAuthUser to find the other five.
    expect(byName.get(`${prefix}.LastAuthUser`)).toBe(SUB);
  });

  it("scopes every cookie to the PointsYeah apex domain at the root path", async () => {
    const browser = fakeBrowser(taskOk);

    await createSearchTask(
      params(),
      ACCESS_TOKEN,
      ID_TOKEN,
      REFRESH_TOKEN,
      browser.deps,
    );

    for (const cookie of browser.cookies) {
      expect(cookie.domain).toBe(".pointsyeah.com");
      expect(cookie.path).toBe("/");
    }
  });

  it("keys the cookie names off the id token's sub, not the access token's", async () => {
    const browser = fakeBrowser(taskOk);
    const otherSub = "99999999-8888-7777-6666-555555555555";

    await createSearchTask(
      params(),
      ACCESS_TOKEN,
      jwt({ sub: otherSub }),
      REFRESH_TOKEN,
      browser.deps,
    );

    const prefix = `CognitoIdentityServiceProvider.${COGNITO_CLIENT_ID}`;
    const names = browser.cookies.map((c) => c.name);
    const byName = new Map(browser.cookies.map((c) => [c.name, c.value]));

    expect(names.filter((n) => n.includes(otherSub))).toHaveLength(5);
    expect(names.some((n) => n.includes(SUB))).toBe(false);
    expect(byName.get(`${prefix}.LastAuthUser`)).toBe(otherSub);
  });

  it("reports an unsuccessful create_task with its code", async () => {
    const browser = fakeBrowser(() =>
      Promise.resolve({ code: 401, success: false, data: null }),
    );

    await expect(
      createSearchTask(
        params(),
        ACCESS_TOKEN,
        ID_TOKEN,
        REFRESH_TOKEN,
        browser.deps,
      ),
    ).rejects.toThrow("Search task creation failed (code: 401)");
  });

  it("closes the page and the context even when create_task fails", async () => {
    const browser = fakeBrowser(() =>
      Promise.resolve({ code: 500, success: false, data: null }),
    );

    await expect(
      createSearchTask(
        params(),
        ACCESS_TOKEN,
        ID_TOKEN,
        REFRESH_TOKEN,
        browser.deps,
      ),
    ).rejects.toThrow();

    // A browser left open per failed search is how a long-lived container runs
    // out of memory.
    expect(browser.closed).toEqual({ page: 1, context: 1 });
    expect(browser.order.at(-2)).toBe("page.close");
    expect(browser.order.at(-1)).toBe("context.close");
  });

  it("closes the page and the context on a clean run too", async () => {
    const browser = fakeBrowser(taskOk);

    await createSearchTask(
      params(),
      ACCESS_TOKEN,
      ID_TOKEN,
      REFRESH_TOKEN,
      browser.deps,
    );

    expect(browser.closed).toEqual({ page: 1, context: 1 });
  });

  it("never launches a browser when the id token is unreadable", async () => {
    const launchBrowser = vi.fn();

    await expect(
      createSearchTask(params(), ACCESS_TOKEN, "not-a-jwt", REFRESH_TOKEN, {
        launchBrowser,
      } as unknown as PlaywrightSearchDeps),
    ).rejects.toThrow("Invalid JWT format");

    expect(launchBrowser).not.toHaveBeenCalled();
  });
});

// =============================================================================
// FETCH RESULTS
// =============================================================================

describe("polling for search results", () => {
  const results = {
    code: 200,
    success: true,
    data: { result: [], status: "processing" },
  };

  it("posts the task id to the fetch_result endpoint", async () => {
    reply({ ok: true, json: results });

    await fetchSearchResults("task-abc", ID_TOKEN);

    const call = onlyCall();
    expect(call.url).toBe(`${API2_BASE}/flight/search/fetch_result`);
    expect(call.init.method).toBe("POST");
    expect(body(call)).toEqual({ task_id: "task-abc" });
  });

  it("sends the raw id token as Authorization, with no Bearer prefix", async () => {
    reply({ ok: true, json: results });

    await fetchSearchResults("task-abc", ID_TOKEN);

    // This is the whole point of the comment in the source: PointsYeah's API
    // rejects `Bearer <token>`.
    expect(headers(onlyCall()).Authorization).toBe(ID_TOKEN);
  });

  it("presents itself as the PointsYeah web app", async () => {
    reply({ ok: true, json: results });

    await fetchSearchResults("task-abc", ID_TOKEN);

    expect(headers(onlyCall())).toEqual({
      Authorization: ID_TOKEN,
      "Content-Type": "application/json",
      Origin: "https://www.pointsyeah.com",
      Referer: "https://www.pointsyeah.com/",
    });
  });

  it("bounds the call with an abort signal", async () => {
    reply({ ok: true, json: results });

    await fetchSearchResults("task-abc", ID_TOKEN);

    expect(onlyCall().init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the envelope verbatim, including a null data payload", async () => {
    const done = {
      code: 200,
      success: true,
      data: {
        result: [
          {
            program: "United MileagePlus",
            code: "UA",
            date: "2026-09-01",
            departure: "SFO",
            arrival: "JFK",
            routes: null,
          },
        ],
        status: "done",
      },
    };
    reply({ ok: true, json: done });
    reply({ ok: true, json: { code: 200, success: true, data: null } });

    expect(await fetchSearchResults("task-abc", ID_TOKEN)).toEqual(done);
    expect(await fetchSearchResults("task-abc", ID_TOKEN)).toEqual({
      code: 200,
      success: true,
      data: null,
    });
  });

  it("reports an HTTP failure with its status and status text", async () => {
    reply({ ok: false, status: 503, statusText: "Service Unavailable" });

    await expect(fetchSearchResults("task-abc", ID_TOKEN)).rejects.toThrow(
      "Failed to fetch search results: 503 Service Unavailable",
    );
  });

  it("puts the status code in the message, which is what the 401 retry reads", async () => {
    reply({ ok: false, status: 401, statusText: "Unauthorized" });

    // `PointsYeahClient.withAuth` retries on `error.message.includes("401")`.
    // If this message ever stops carrying the code, an expired token stops
    // being retried and starts being an error the caller sees.
    await expect(fetchSearchResults("task-abc", ID_TOKEN)).rejects.toThrow(
      /401/,
    );
  });
});

// =============================================================================
// USER API
// =============================================================================

describe("reading the search history", () => {
  it("GETs the history path with no body", async () => {
    reply({ ok: true, json: { history: [] } });

    await getSearchHistory(ID_TOKEN);

    const call = onlyCall();
    expect(call.url).toBe(`${API2_BASE}/flight/history`);
    expect(call.init.method).toBe("GET");
    expect(call.init.body).toBeUndefined();
    expect(headers(call)).toEqual({
      Authorization: ID_TOKEN,
      "Content-Type": "application/json",
      Origin: "https://www.pointsyeah.com",
      Referer: "https://www.pointsyeah.com/",
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the parsed payload verbatim", async () => {
    const history = { data: [{ departure: "SFO", arrival: "NYC" }] };
    reply({ ok: true, json: history });

    expect(await getSearchHistory(ID_TOKEN)).toEqual(history);
  });

  it("reports an HTTP failure with its status and status text", async () => {
    reply({ ok: false, status: 500, statusText: "Internal Server Error" });

    await expect(getSearchHistory(ID_TOKEN)).rejects.toThrow(
      "API request failed: 500 Internal Server Error",
    );
  });

  it("puts the status code in the message, which is what the 401 retry reads", async () => {
    reply({ ok: false, status: 401, statusText: "Unauthorized" });

    await expect(getSearchHistory(ID_TOKEN)).rejects.toThrow(/401/);
  });
});
