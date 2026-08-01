import { afterEach, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import {
  errorReporterOptions,
  redactErrorEvent,
  startErrorReporter,
} from "../src/telemetry/errors.ts";
import { credentialValues, scrubText } from "../src/telemetry/redact.ts";
import { identityFromEnv } from "../src/telemetry/resource.ts";

/**
 * The exception reporter, from both ends: the OFF state (which is the default
 * and must cost nothing) and the ON state (which must report a real exception,
 * with strad's identity on it, and with every credential struck out first).
 *
 * Nothing here opens a socket. The SDK is initialised with a recording
 * transport, which is the seam that lets us assert on the exact envelope that
 * WOULD have gone to GlitchTip.
 */

const DSN = "https://publickey@glitchtip.invalid/42";

/** Envelope items, as the transport would have sent them. */
interface Recorded {
  events: ErrorEvent[];
}

function recordingTransport(recorded: Recorded) {
  return () => ({
    send: async (envelope: unknown) => {
      // An envelope is [headers, [[itemHeader, itemPayload], …]].
      const items = (envelope as [unknown, [{ type: string }, unknown][]])[1];
      for (const [header, payload] of items) {
        if (header.type === "event")
          recorded.events.push(payload as ErrorEvent);
      }
      return {};
    },
    flush: async () => true,
  });
}

async function startRecording(env: NodeJS.ProcessEnv): Promise<Recorded> {
  const recorded: Recorded = { events: [] };
  const handle = await startErrorReporter({
    env,
    log: () => {},
    transport: recordingTransport(recorded),
  });
  expect(handle.enabled).toBe(true);
  return recorded;
}

afterEach(async () => {
  // The SDK client is process-global. Leaving one bound would let a later test
  // (or a later file) inherit a client with a recording transport pointed at a
  // dead array — and would leave the two process handlers installed.
  await Sentry.close(0).catch(() => false);
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
});

describe("off by default: no DSN, no reporter", () => {
  // The load-bearing property. staging and prod are live, and so is every
  // developer's laptop: the OSS repo bakes in no integrations, and an
  // unconfigured deployment must behave exactly as it did before this existed.

  it("returns a disabled handle when SENTRY_DSN is unset", async () => {
    const handle = await startErrorReporter({ env: {} });
    expect(handle.enabled).toBe(false);
  });

  it("initialises no SDK client at all", async () => {
    await startErrorReporter({ env: {} });
    expect(Sentry.isInitialized()).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
  });

  it("installs no process handlers", async () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    await startErrorReporter({ env: {} });
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
  });

  it("says nothing — an unconfigured crash reporter is not an event", async () => {
    const lines: Record<string, unknown>[] = [];
    await startErrorReporter({ env: {}, log: (e) => lines.push(e) });
    expect(lines).toEqual([]);
  });

  it("treats an empty or whitespace DSN as unset, not as a broken one", async () => {
    expect(
      (await startErrorReporter({ env: { SENTRY_DSN: "" } })).enabled,
    ).toBe(false);
    expect(
      (await startErrorReporter({ env: { SENTRY_DSN: "   " } })).enabled,
    ).toBe(false);
  });

  it("shuts down and captures without throwing when disabled", async () => {
    const handle = await startErrorReporter({ env: {} });
    await expect(handle.flush()).resolves.toBeUndefined();
    await expect(
      handle.captureFatal(new Error("boom"), "boot"),
    ).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe("the SDK options are the posture", () => {
  const identity = identityFromEnv({
    STRAD_MODE: "core",
    STRAD_ENV: "prod",
    STRAD_VERSION: "0.1.51",
  });

  const options = errorReporterOptions({ dsn: DSN, env: {}, identity });

  it("carries the SAME identity OTLP stamps", () => {
    // `environment` is what OTLP exports as deployment.environment and
    // `release` is service.version — the deployed image tag. A GlitchTip issue
    // that cannot be lined up with a log record by these two is a GlitchTip
    // issue nobody can act on.
    expect(options.environment).toBe("prod");
    expect(options.release).toBe("0.1.51");
    expect(options.serverName).toBe("strad-core");
    expect(options.initialScope).toMatchObject({
      tags: {
        "service.name": "strad-core",
        "strad.component": "core",
        "strad.mode": "core",
      },
    });
  });

  it("sends no PII and installs no default integrations", () => {
    // The defaults would attach request data (headers, cookies, query strings),
    // console output as breadcrumbs — which is every upstream error message
    // strad logs — and source-context lines off disk.
    expect(options.sendDefaultPii).toBe(false);
    expect(options.defaultIntegrations).toBe(false);
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.beforeBreadcrumb?.({}, undefined)).toBeNull();
  });

  it("sends no traces: those go to Tempo, over OTLP", () => {
    expect(options.tracesSampleRate).toBe(0);
    expect(options.skipOpenTelemetrySetup).toBe(true);
    expect(
      options.beforeSendTransaction?.(
        {} as Parameters<NonNullable<typeof options.beforeSendTransaction>>[0],
        {},
      ),
    ).toBeNull();
  });

  it("names the bundle component it is running in", () => {
    const bundle = identityFromEnv({
      STRAD_MODE: "bundle",
      STRAD_COMPONENT: "bundle-zimmer-secrets",
      STRAD_ENV: "staging",
    });
    const opts = errorReporterOptions({ dsn: DSN, env: {}, identity: bundle });
    expect(opts.serverName).toBe("strad-bundle-zimmer-secrets");
    expect(opts.initialScope).toMatchObject({
      tags: {
        "strad.component": "bundle-zimmer-secrets",
        "strad.mode": "bundle",
      },
    });
  });
});

describe("with a DSN: a real exception, really captured", () => {
  it("reports an exception with strad's environment, release and tags", async () => {
    const recorded = await startRecording({
      SENTRY_DSN: DSN,
      STRAD_ENV: "prod",
      STRAD_VERSION: "0.1.51",
      STRAD_MODE: "core",
    });

    Sentry.captureException(new TypeError("cannot read properties of null"));
    await Sentry.flush(2000);

    expect(recorded.events).toHaveLength(1);
    const event = recorded.events[0]!;
    expect(event.environment).toBe("prod");
    expect(event.release).toBe("0.1.51");
    expect(event.server_name).toBe("strad-core");
    expect(event.tags).toMatchObject({ "strad.component": "core" });
    const value = event.exception?.values?.[0];
    expect(value?.type).toBe("TypeError");
    expect(value?.value).toBe("cannot read properties of null");
    // The stack is the point of the exercise: a report with no frames says
    // "something happened", which is what we already had.
    expect(value?.stacktrace?.frames?.length).toBeGreaterThan(0);
  });

  it("installs the uncaught-exception and unhandled-rejection handlers", async () => {
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    await startRecording({ SENTRY_DSN: DSN });
    expect(process.listenerCount("uncaughtException")).toBe(1);
    expect(process.listenerCount("unhandledRejection")).toBe(1);
  });

  it("reports a boot failure, which exits by a path no handler sees", async () => {
    const recorded: Recorded = { events: [] };
    const handle = await startErrorReporter({
      env: { SENTRY_DSN: DSN, STRAD_ENV: "staging" },
      log: () => {},
      transport: recordingTransport(recorded),
    });

    await handle.captureFatal(new Error("bundle unreachable"), "boot");

    expect(recorded.events).toHaveLength(1);
    const event = recorded.events[0]!;
    expect(event.level).toBe("fatal");
    expect(event.tags).toMatchObject({ "strad.phase": "boot" });
    expect(event.exception?.values?.[0]?.value).toBe("bundle unreachable");
  });

  it("logs one line naming the ingest host, and never the DSN's key", async () => {
    const lines: Record<string, unknown>[] = [];
    await startErrorReporter({
      env: { SENTRY_DSN: DSN, STRAD_ENV: "staging", STRAD_VERSION: "0.1.51" },
      log: (e) => lines.push(e),
      transport: recordingTransport({ events: [] }),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      evt: "errors.started",
      environment: "staging",
      release: "0.1.51",
      ingest: "glitchtip.invalid",
    });
    expect(JSON.stringify(lines[0])).not.toContain("publickey");
  });

  it("survives a malformed DSN rather than failing the boot", async () => {
    const lines: Record<string, unknown>[] = [];
    const handle = await startErrorReporter({
      env: { SENTRY_DSN: "not a dsn at all" },
      log: (e) => lines.push(e),
      transport: recordingTransport({ events: [] }),
    });
    // Either the SDK rejects it and we report disabled, or it accepts it and
    // sends into the void. What must NOT happen is a throw: a typo in one
    // env var cannot be allowed to take the gateway down.
    expect(typeof handle.enabled).toBe("boolean");
    await handle.shutdown();
  });
});

describe("redaction: the main way this change could do harm", () => {
  // strad proxies 1Password items, Gmail threads and a secrets provider. This is
  // the one channel that ships free text, so a secret-bearing error must not
  // survive beforeSend intact.

  it("strikes out a credential this process is actually holding", async () => {
    const recorded = await startRecording({
      SENTRY_DSN: DSN,
      STRAD_INTERNAL_TOKEN: "s3cr3t-internal-token-value",
    });

    Sentry.captureException(
      new Error(
        "upstream rejected Authorization: Bearer s3cr3t-internal-token-value",
      ),
    );
    await Sentry.flush(2000);

    const serialized = JSON.stringify(recorded.events[0]);
    expect(serialized).not.toContain("s3cr3t-internal-token-value");
    expect(serialized).toContain("[redacted]");
  });

  it("strikes out one TOKEN out of a JSON credential document", async () => {
    // STRAD_TOKENS is an array of token records. A stack trace quotes ONE of
    // them, not the whole document, so the leaves have to be secrets too.
    const recorded = await startRecording({
      SENTRY_DSN: DSN,
      STRAD_TOKENS: JSON.stringify([
        { id: "agent", secret: "abcdefghijklmnop-token" },
      ]),
    });

    Sentry.captureException(new Error("token abcdefghijklmnop-token expired"));
    await Sentry.flush(2000);

    expect(JSON.stringify(recorded.events[0])).not.toContain(
      "abcdefghijklmnop-token",
    );
  });

  it("strikes out credential SHAPES it was never handed", async () => {
    const recorded = await startRecording({ SENTRY_DSN: DSN });

    Sentry.captureException(
      new Error(
        'upstream said {"api_key": "AIzaSyD-not-a-real-google-key", "jwt": "eyJhbGciOi.eyJzdWIiOiI.QQQQQQ"}',
      ),
    );
    await Sentry.flush(2000);

    const serialized = JSON.stringify(recorded.events[0]);
    expect(serialized).not.toContain("AIzaSyD-not-a-real-google-key");
    expect(serialized).not.toContain("eyJhbGciOi.eyJzdWIiOiI.QQQQQQ");
  });

  it("drops every field that is not on the allowlist", () => {
    // Deny-by-default, like EXPORTABLE in events.ts. `request` carries headers
    // and cookies, `user` carries an IP, `extra` carries whatever anyone put
    // there, `breadcrumbs` carry every console line strad wrote.
    const event = {
      event_id: "abc",
      environment: "prod",
      release: "0.1.51",
      request: {
        headers: { authorization: "Bearer nope" },
        cookies: "session=nope",
        query_string: "token=nope",
      },
      user: { ip_address: "10.0.0.1", email: "someone@example.com" },
      extra: { toolResult: "a decrypted parameter" },
      breadcrumbs: [{ message: "upstream said: Bearer nope" }],
      modules: { express: "4.21.2" },
      contexts: {
        runtime: { name: "node" },
        // Not on the context allowlist.
        response: { headers: { "set-cookie": "nope" } },
      },
    } as unknown as ErrorEvent;

    const out = redactErrorEvent(event, []);
    const serialized = JSON.stringify(out);

    expect(out).not.toHaveProperty("request");
    expect(out).not.toHaveProperty("user");
    expect(out).not.toHaveProperty("extra");
    expect(out).not.toHaveProperty("breadcrumbs");
    expect(out).not.toHaveProperty("modules");
    expect(out?.contexts).toEqual({ runtime: { name: "node" } });
    expect(serialized).not.toContain("nope");
    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).not.toContain("decrypted parameter");
    // What it is FOR still survives.
    expect(out?.environment).toBe("prod");
    expect(out?.release).toBe("0.1.51");
  });

  it("drops local variables and source context from stack frames", () => {
    // Neither integration is installed, so neither should ever appear. "Should
    // never appear" is not a boundary; this is.
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: {
              frames: [
                {
                  filename: "/app/src/gateway/router.ts",
                  function: "callTool",
                  lineno: 42,
                  in_app: true,
                  vars: { token: "Bearer leaked-value-here" },
                  pre_context: ["const secret = 'leaked-value-here';"],
                  context_line: "await upstream.callTool(args)",
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const serialized = JSON.stringify(redactErrorEvent(event, []));
    expect(serialized).not.toContain("leaked-value-here");
    expect(serialized).not.toContain("context_line");
    expect(serialized).toContain("/app/src/gateway/router.ts");
    expect(serialized).toContain("callTool");
  });

  it("drops the event entirely rather than shipping one it cannot rebuild", () => {
    const hostile = {
      get exception(): unknown {
        throw new Error("no");
      },
    } as unknown as ErrorEvent;
    expect(redactErrorEvent(hostile, [])).toBeNull();
  });
});

describe("scrubText / credentialValues", () => {
  it("collects credential-shaped env values, and their JSON leaves", () => {
    const values = credentialValues({
      STRAD_INTERNAL_TOKEN: "internal-token-value",
      CONSOLE_SESSION_SECRET: "session-secret-value",
      STRAD_TOKENS: '[{"id":"agent","secret":"leaf-secret-value"}]',
      // Neither a credential name nor long enough to be one.
      PORT: "8080",
      STRAD_ENV: "prod",
    });
    expect(values).toContain("internal-token-value");
    expect(values).toContain("session-secret-value");
    expect(values).toContain("leaf-secret-value");
    expect(values).not.toContain("8080");
    expect(values).not.toContain("prod");
  });

  it("orders longest-first, so a document is struck out before its leaves", () => {
    const values = credentialValues({
      STRAD_TOKENS: '["short-secret-aaa","a-much-longer-secret-value"]',
    });
    expect(values[0]!.length).toBeGreaterThanOrEqual(values[1]!.length);
  });

  it("never mistakes a short value for a secret", () => {
    // "true" appears in half the English language; striking it out everywhere
    // would make a crash report unreadable to buy nothing.
    expect(scrubText("ALLOW_DEV_AUTH was true", ["true"])).toBe(
      "ALLOW_DEV_AUTH was true",
    );
  });

  it("redacts a PEM block, which is what a GCP key looks like in a stack", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----";
    const out = scrubText(`resolver key rejected: ${pem}`);
    expect(out).not.toContain("MIIEvQIBADANBg");
    expect(out).toContain("[redacted]:pem");
  });

  it("redacts URL userinfo but keeps the host, which is the diagnosis", () => {
    const out = scrubText(
      "connect ECONNREFUSED https://admin:hunter2@db.internal:5432/x",
    );
    expect(out).not.toContain("hunter2");
    expect(out).toContain("db.internal");
  });

  it("keeps the shape of an Authorization header while losing its value", () => {
    // "the header was present and wrong" is a different bug from "there was no
    // header", and a blanket redaction erases the difference.
    const out = scrubText("401 with Authorization: Bearer abcdef1234567890");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain("Bearer [redacted]");
  });

  it("truncates a message long enough to be a payload", () => {
    const out = scrubText("x".repeat(10_000));
    expect(out.length).toBeLessThan(2200);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("returns text unchanged when there is nothing to strike out", () => {
    const message = "Cannot read properties of null (reading 'slug')";
    expect(scrubText(message, ["some-unrelated-secret"])).toBe(message);
  });
});
