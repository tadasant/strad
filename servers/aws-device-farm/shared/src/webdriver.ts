/**
 * A W3C WebDriver client, spoken to the Appium endpoint a Device Farm remote
 * access session hands back.
 *
 * WHY THERE IS NO APPIUM CLIENT LIBRARY HERE. The endpoint is an ordinary
 * WebDriver server reachable over HTTPS — AWS's own documentation demonstrates
 * it with `curl <endpoint>/status` — and the dozen commands this server needs
 * are a dozen `fetch` calls. Pulling in WebdriverIO would add a large
 * dependency tree to an image that already carries twenty-one of them, to spell
 * the same requests.
 *
 * THE URL IS THE CREDENTIAL. `remoteDriverEndpoint` authorises by the opaque
 * segment in its PATH: no signature, no header, no expiry beyond the session's
 * own. It is therefore never returned to a caller and never logged — see
 * logging.ts — and it lives only in this module and the driver pool.
 *
 * COMMANDS ARE SEQUENTIAL, AND THE ENDPOINT SAYS SO. Device Farm executes
 * requests in arrival order on one physical phone and caps a single command at
 * four minutes; the payload ceiling is 20 MB each way, which a screenshot of a
 * modern iPhone is comfortably under and a full-resolution video would not be.
 */

import { DriverError } from "./errors.js";
import { deadline, type FetchLike, type FetchResponse } from "./http.js";

/** The W3C element-identifier key. Not an Appium invention — it is in the spec. */
export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export interface Point {
  x: number;
  y: number;
}

export interface WebDriverSession {
  readonly sessionId: string;
  source(): Promise<string>;
  screenshot(): Promise<string>;
  findElements(using: string, value: string): Promise<string[]>;
  click(elementId: string): Promise<void>;
  clear(elementId: string): Promise<void>;
  sendKeys(elementId: string, text: string): Promise<void>;
  tap(at: Point): Promise<void>;
  swipe(from: Point, to: Point, durationMs: number): Promise<void>;
  execute(script: string, args: unknown[]): Promise<unknown>;
  quit(): Promise<void>;
}

export interface CreateSessionOptions {
  endpoint: string;
  fetchImpl: FetchLike;
  capabilities: Record<string, unknown>;
  /** Carried on every DriverError so a caller knows which phone answered. */
  sessionArn?: string;
}

function joinUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, "")}${path}`;
}

/**
 * Just past Device Farm's own four-minute per-command ceiling, so the server's
 * answer — a WebDriver `timeout` with a reason — arrives before this fires, and
 * this only ever catches a connection that stopped answering at all.
 */
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * One WebDriver request, with its failure turned into a `DriverError`.
 *
 * A WebDriver failure is a JSON body whose `value.error` is a SPEC-DEFINED
 * CODE, and that code is the only part a caller can branch on: `no such
 * element` means the screen has not rendered or the locator is wrong, `invalid
 * session id` means the phone dropped the session, `timeout` is the endpoint's
 * own four-minute ceiling. Flattening those into the HTTP status would throw
 * away the distinction.
 */
async function request(
  options: CreateSessionOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let res: FetchResponse;
  try {
    res = await options.fetchImpl(joinUrl(options.endpoint, path), {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: deadline(COMMAND_TIMEOUT_MS),
    });
  } catch (err) {
    // A transport failure, not a WebDriver one. The endpoint is reachable only
    // while the session is alive, so this is most often a session that ended
    // between one command and the next.
    throw new DriverError(
      "transport error",
      `The device's Appium endpoint could not be reached: ${
        err instanceof Error ? err.message : String(err)
      }. A remote access session ends itself after five minutes of no ` +
        `activity, and the endpoint dies with it.`,
      options.sessionArn,
    );
  }

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new DriverError(
      "unknown error",
      `The device's Appium endpoint answered HTTP ${res.status} with ` +
        `something that is not JSON.`,
      options.sessionArn,
    );
  }

  const value = (payload as { value?: unknown }).value;
  const asError = value as { error?: string; message?: string } | undefined;
  if (!res.ok || (asError && typeof asError === "object" && asError.error)) {
    const code = asError?.error ?? `http ${res.status}`;
    throw new DriverError(
      code,
      // The CODE goes in the message when the endpoint sent no prose. A
      // failure reported only as "HTTP 404" says nothing about whether the
      // session died or the locator was wrong, which is the whole distinction.
      asError?.message ??
        `The device's Appium endpoint answered "${code}" (HTTP ${res.status}).`,
      options.sessionArn,
    );
  }
  return value;
}

export async function createWebDriverSession(
  options: CreateSessionOptions,
): Promise<WebDriverSession> {
  const created = (await request(options, "POST", "/session", {
    capabilities: { alwaysMatch: options.capabilities, firstMatch: [{}] },
  })) as { sessionId?: string } | undefined;

  const sessionId = created?.sessionId;
  if (!sessionId) {
    throw new DriverError(
      "session not created",
      "The Appium endpoint accepted the session request and returned no " +
        "sessionId.",
      options.sessionArn,
    );
  }

  const at = (path: string): string => `/session/${sessionId}${path}`;

  return {
    sessionId,

    async source() {
      return String(await request(options, "GET", at("/source")));
    },

    async screenshot() {
      return String(await request(options, "GET", at("/screenshot")));
    },

    async findElements(using, value) {
      const found = (await request(options, "POST", at("/elements"), {
        using,
        value,
      })) as Record<string, string>[] | undefined;
      return (found ?? [])
        .map((e) => e[ELEMENT_KEY])
        .filter((id): id is string => typeof id === "string");
    },

    async click(elementId) {
      await request(options, "POST", at(`/element/${elementId}/click`), {});
    },

    async clear(elementId) {
      await request(options, "POST", at(`/element/${elementId}/clear`), {});
    },

    async sendKeys(elementId, text) {
      // BOTH `text` and `value` are sent. The W3C spec says `text`; several
      // Appium versions read the older `value` array, and an element that
      // received neither reports success and types nothing.
      await request(options, "POST", at(`/element/${elementId}/value`), {
        text,
        value: [...text],
      });
    },

    async tap(point) {
      await request(options, "POST", at("/actions"), {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, x: point.x, y: point.y },
              { type: "pointerDown", button: 0 },
              { type: "pause", duration: 80 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
    },

    async swipe(from, to, durationMs) {
      await request(options, "POST", at("/actions"), {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, x: from.x, y: from.y },
              { type: "pointerDown", button: 0 },
              // A pointerDown followed immediately by a move is a FLICK on iOS.
              // The pause is what makes the gesture a drag the app can track.
              { type: "pause", duration: 100 },
              { type: "pointerMove", duration: durationMs, x: to.x, y: to.y },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
    },

    async execute(script, args) {
      return request(options, "POST", at("/execute/sync"), { script, args });
    },

    async quit() {
      await request(options, "DELETE", at(""));
    },
  };
}
