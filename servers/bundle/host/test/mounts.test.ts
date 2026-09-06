import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extraSlugs,
  missingCredentialsDegraded,
  remoteFilesystemDegraded,
  scrubCapabilityEnv,
} from "../src/mounts.js";

/**
 * The host logs on stderr through `console.error` (see src/log.ts). Several of
 * the decisions below are ONLY observable as a log line — a scrubbed variable
 * and a discovered slug both change what boots, and neither returns anything
 * that says so — so the spy is part of the assertion, not noise suppression.
 */
function captureLog(): { lines: () => string[] } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return { lines: () => spy.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrubCapabilityEnv", () => {
  it("removes every shape of container-side capability toggle", () => {
    const env = {
      GMAIL_ENABLED_TOOLGROUPS: "read",
      SLACK_ENABLED_TOOL_GROUPS: "read",
      DRIVE_TOOL_GROUPS: "read",
      GCS_ENABLED_TOOLS: "list",
      GCS_DISABLED_TOOLS: "delete",
      // Bare, with no server prefix at all: the `^` half of the alternation.
      ENABLED_TOOLGROUPS: "read",
    } as NodeJS.ProcessEnv;

    scrubCapabilityEnv(env);

    expect(Object.keys(env)).toEqual([]);
  });

  it("names each removed variable, and says capability moved to the gateway", () => {
    const log = captureLog();
    const env = { GMAIL_ENABLED_TOOLGROUPS: "read" } as NodeJS.ProcessEnv;

    scrubCapabilityEnv(env);

    expect(log.lines()).toHaveLength(1);
    expect(log.lines()[0]).toContain("WARN ignoring GMAIL_ENABLED_TOOLGROUPS");
    expect(log.lines()[0]).toContain("enforced by the strad gateway");
  });

  it("leaves everything else alone, including near-misses", () => {
    const env = {
      // The shape is anchored at the END. A variable that merely CONTAINS the
      // words is somebody else's, and deleting it would be the bug.
      ENABLED_TOOLGROUPS_LEGACY: "read",
      // `_` is required before the word: this is one identifier, not a suffix.
      XENABLED_TOOLS: "read",
      TELEGRAM_API_HASH: "hash",
      PORT: "8080",
    } as NodeJS.ProcessEnv;

    scrubCapabilityEnv(env);

    expect(Object.keys(env).sort()).toEqual([
      "ENABLED_TOOLGROUPS_LEGACY",
      "PORT",
      "TELEGRAM_API_HASH",
      "XENABLED_TOOLS",
    ]);
  });
});

/**
 * The per-slug instance discovery. The host never sees strad's config, so the
 * ONLY evidence that a deployment wants a second telegram is a complete set of
 * that tree's variables under a slug prefix.
 */
describe("extraSlugs", () => {
  const TELEGRAM = [
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_STRING_SESSION",
  ];

  it("finds a slug the environment carries a COMPLETE set for", () => {
    const found = extraSlugs("telegram", TELEGRAM, {
      TELEGRAM_WORK__TELEGRAM_API_ID: "1",
      TELEGRAM_WORK__TELEGRAM_API_HASH: "h",
      TELEGRAM_WORK__TELEGRAM_STRING_SESSION: "s",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual(["telegram-work"]);
  });

  it("ignores a PARTIAL set, so one stray variable cannot conjure a mount", () => {
    // The whole point of requiring every name: `TELEGRAM_API_ID` belongs to
    // nobody, and a server that happens to declare one of them must not stand up
    // a live, credentialed instance at a path nobody asked for.
    const found = extraSlugs("telegram", TELEGRAM, {
      TELEGRAM_WORK__TELEGRAM_API_ID: "1",
      TELEGRAM_WORK__TELEGRAM_API_HASH: "h",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual([]);
  });

  it("never returns the default slug, which is mounted unconditionally", () => {
    // A deployment that DID bake per-slug names for the conventional slug is the
    // normal case once a config names `telegram` explicitly. Returning it here
    // would mount /telegram twice and the second would shadow the first.
    const found = extraSlugs("telegram", TELEGRAM, {
      TELEGRAM__TELEGRAM_API_ID: "1",
      TELEGRAM__TELEGRAM_API_HASH: "h",
      TELEGRAM__TELEGRAM_STRING_SESSION: "s",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual([]);
  });

  it("returns several, sorted, so the boot log's mount order is stable", () => {
    const found = extraSlugs("telegram", TELEGRAM, {
      ZED__TELEGRAM_API_ID: "1",
      ZED__TELEGRAM_API_HASH: "h",
      ZED__TELEGRAM_STRING_SESSION: "s",
      ALPHA__TELEGRAM_API_ID: "1",
      ALPHA__TELEGRAM_API_HASH: "h",
      ALPHA__TELEGRAM_STRING_SESSION: "s",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual(["alpha", "zed"]);
  });

  it("logs the discovery, counting the conventional mount in the total", () => {
    const log = captureLog();

    extraSlugs("telegram", TELEGRAM, {
      TELEGRAM_WORK__TELEGRAM_API_ID: "1",
      TELEGRAM_WORK__TELEGRAM_API_HASH: "h",
      TELEGRAM_WORK__TELEGRAM_STRING_SESSION: "s",
    } as NodeJS.ProcessEnv);

    expect(log.lines()).toHaveLength(1);
    expect(log.lines()[0]).toContain(
      "telegram: per-slug environment found for telegram-work — mounting 2 instance(s)",
    );
  });

  it("says nothing when there is nothing to discover", () => {
    const log = captureLog();

    expect(
      extraSlugs("telegram", TELEGRAM, { PORT: "8080" } as NodeJS.ProcessEnv),
    ).toEqual([]);
    expect(log.lines()).toEqual([]);
  });

  it("carries remote-filesystem's DOUBLE prefix", () => {
    // The inner prefix keeps this server off the bare `GCS_*` names the `gcs`
    // server owns in the same container; the outer one separates two instances
    // of THIS server. It reads badly and it is the correct name.
    const found = extraSlugs(
      "remote-filesystem-tmp-public",
      ["REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET"],
      {
        REMOTE_FS_ARCHIVE__REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "b",
      } as NodeJS.ProcessEnv,
    );

    expect(found).toEqual(["remote-fs-archive"]);
  });

  /**
   * google-sheets is discovered on a MARKER set that is deliberately smaller than
   * the tree's credential: the client id and secret, never the refresh token.
   *
   * The token is minted by a consent flow on the slug's own console page, which
   * only exists once the slug is deployed and mounted. Requiring it here would
   * unmount every slug that has not been connected yet, which is every slug on
   * its first deploy.
   */
  const SHEETS_MARKERS = [
    "GOOGLE_SHEETS_OAUTH_CLIENT_ID",
    "GOOGLE_SHEETS_OAUTH_CLIENT_SECRET",
  ];

  it("finds an UNCONNECTED google-sheets slug, which has no refresh token yet", () => {
    const found = extraSlugs("google-sheets", SHEETS_MARKERS, {
      GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual(["google-sheets-tadas412-ro"]);
  });

  it("finds a connected google-sheets slug too — the token is not a marker", () => {
    const found = extraSlugs("google-sheets", SHEETS_MARKERS, {
      GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "token",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual(["google-sheets-tadas412-ro"]);
  });

  it("still requires EVERY marker: the id alone is not a google-sheets slug", () => {
    // The marker set is smaller, not optional. A slug seeded half way through
    // step 3 of the runbook is not a deployment asking for a mount, and neither
    // is a stray `..__GOOGLE_SHEETS_OAUTH_CLIENT_ID` belonging to nobody.
    expect(
      extraSlugs("google-sheets", SHEETS_MARKERS, {
        GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);

    // And the token on its own — the half a connector flow writes — conjures
    // nothing either, because it is not in the marker set at all.
    expect(
      extraSlugs("google-sheets", SHEETS_MARKERS, {
        GOOGLE_SHEETS_TADAS412_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "token",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("discovers nothing when the tree names no required variables", () => {
    // A tree whose marker list is empty has declared no complete set to look
    // for, so ANY prefixed variable would otherwise stand up an instance of it.
    // Nothing here can distinguish that from a deployment asking for one.
    const log = captureLog();

    expect(
      extraSlugs("telegram", [], {
        TELEGRAM_WORK__TELEGRAM_API_ID: "1",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
    expect(log.lines()).toEqual([]);
  });

  it("does not invent a slug from a head that is not a mangled slug", () => {
    // `FOO__BAR__TELEGRAM_API_ID` would fold to a slug of `foo--bar`, which the
    // config schema forbids precisely because it destroys the name's injectivity.
    const found = extraSlugs("telegram", TELEGRAM, {
      FOO__BAR__TELEGRAM_API_ID: "1",
      FOO__BAR__TELEGRAM_API_HASH: "h",
      FOO__BAR__TELEGRAM_STRING_SESSION: "s",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual([]);
  });
});

/**
 * The degraded decisions. A credential-less mount still LISTS its tools — that
 * is the behaviour under test, and the reason `degraded` is a string rather than
 * an absent mount.
 */
describe("remoteFilesystemDegraded", () => {
  const PREFIX = "REMOTE_FILESYSTEM_TMP_PUBLIC";

  it("is not degraded when both names are set", () => {
    expect(
      remoteFilesystemDegraded(
        {
          [`${PREFIX}_GCS_BUCKET`]: "strad-artifacts",
          [`${PREFIX}_SENSITIVE_VIEWER_DOMAIN`]: "example.com",
        },
        PREFIX,
      ),
    ).toBeNull();
  });

  it("degrades everything on a missing bucket, and says so", () => {
    expect(
      remoteFilesystemDegraded(
        { [`${PREFIX}_SENSITIVE_VIEWER_DOMAIN`]: "example.com" },
        PREFIX,
      ),
    ).toBe(
      "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET is not set; every tool will fail",
    );
  });

  it("degrades only sensitive uploads on a missing viewer domain", () => {
    expect(
      remoteFilesystemDegraded(
        { [`${PREFIX}_GCS_BUCKET`]: "strad-artifacts" },
        PREFIX,
      ),
    ).toBe(
      "REMOTE_FILESYSTEM_TMP_PUBLIC_SENSITIVE_VIEWER_DOMAIN is not set; is_sensitive=true uploads will be refused",
    );
  });

  it("reports the bucket first when both are missing", () => {
    expect(remoteFilesystemDegraded({}, PREFIX)).toContain("_GCS_BUCKET");
  });

  it("treats an empty value as unset — an injected-but-empty bucket is no bucket", () => {
    expect(
      remoteFilesystemDegraded({ [`${PREFIX}_GCS_BUCKET`]: "" }, PREFIX),
    ).toContain("_GCS_BUCKET is not set");
  });

  it("reads the names off the prefix it is handed, per instance", () => {
    // A second instance's env view is built by `slugEnvView`, which folds
    // `SLUG__NAME` down to `NAME` — so the prefix here is always the INNER one.
    // Passing it rather than importing it is what keeps the message truthful if
    // the tree's prefix ever moves.
    expect(remoteFilesystemDegraded({}, "OTHER_PREFIX")).toBe(
      "OTHER_PREFIX_GCS_BUCKET is not set; every tool will fail",
    );
  });
});

describe("missingCredentialsDegraded", () => {
  it("is not degraded when the tree reports nothing missing", () => {
    expect(missingCredentialsDegraded([])).toBeNull();
  });

  it("names ALL three of telegram's variables in one sentence", () => {
    expect(
      missingCredentialsDegraded([
        "TELEGRAM_API_ID",
        "TELEGRAM_API_HASH",
        "TELEGRAM_STRING_SESSION",
      ]),
    ).toBe(
      "TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_STRING_SESSION are not set; every tool will fail",
    );
  });

  it("agrees its verb with a single missing variable", () => {
    expect(missingCredentialsDegraded(["TELEGRAM_API_HASH"])).toBe(
      "TELEGRAM_API_HASH is not set; every tool will fail",
    );
  });

  it("says the same sentence for google-sheets, which shares it", () => {
    // Two trees report their own missing credentials and both mounts phrase the
    // verdict here. One sentence, so the console reads the same either way.
    expect(
      missingCredentialsDegraded([
        "GOOGLE_SHEETS_CLIENT_ID",
        "GOOGLE_SHEETS_REFRESH_TOKEN",
      ]),
    ).toBe(
      "GOOGLE_SHEETS_CLIENT_ID, GOOGLE_SHEETS_REFRESH_TOKEN are not set; every tool will fail",
    );
  });
});

/**
 * The call sites, asserted as TEXT.
 *
 * `index.ts` calls `main()` at import time, so a test cannot import it and ask
 * which function a mount's `degraded` came from. A grep is a weak assertion and
 * it is the right strength for the thing being asserted — the same technique,
 * and the same reason, as `test/env-prefix.markers.test.ts` one tree up: that the
 * three mounts still get their verdict from the functions tested above, rather
 * than from a copy of the sentence that would drift out from under them.
 */
describe("the mounts that use these verdicts", () => {
  const host = readFileSync("src/index.ts", "utf8");

  it("gets telegram's and google-sheets' verdict from the shared helper", () => {
    const calls = host.match(/missingCredentialsDegraded\(/g) ?? [];
    // Two call sites: loadTelegram and loadGoogleSheets. Three, once a third
    // tree grows a `missingCredentials()` — this is a floor, not a count.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("discovers google-sheets slugs on the OAuth app pair, not the token", () => {
    // The design this pins: a connector slug must mount BEFORE it is connected,
    // because the console page that mints its token is the mount. Passing the
    // tree's full credential list here would put that cycle back.
    expect(host).toContain("google.sheets.GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES");
    expect(host).not.toContain("google.sheets.GOOGLE_SHEETS_ENV_NAMES");
  });

  it("gets remote-filesystem's verdict from the shared helper", () => {
    expect(host).toContain("remoteFilesystemDegraded(env, REMOTE_FS_ENV_PREFIX)");
  });

  it("keeps no copy of the sentence of its own", () => {
    // The failure this catches: someone adds a mount, writes the ternary inline
    // because it is two lines, and the wording drifts on one console row.
    expect(host).not.toContain("not set; every tool will fail");
  });
});
