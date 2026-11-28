import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dropInheritedNames,
  dropUnpairedCredentials,
  extraSlugs,
  hatchboxEnvView,
  instanceEnv,
  missingCredentialsDegraded,
  onePasswordConfirmsWrites,
  ownNameOnly,
  remoteFilesystemDegraded,
  scrubCapabilityEnv,
} from "../src/mounts.js";
import { slugEnvView } from "../src/env-prefix.js";

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
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual(["google-sheets-personal-ro"]);
  });

  it("finds a connected google-sheets slug too — the token is not a marker", () => {
    const found = extraSlugs("google-sheets", SHEETS_MARKERS, {
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "token",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual(["google-sheets-personal-ro"]);
  });

  it("still requires EVERY marker: the id alone is not a google-sheets slug", () => {
    // The marker set is smaller, not optional. A slug seeded half way through
    // step 3 of the runbook is not a deployment asking for a mount, and neither
    // is a stray `..__GOOGLE_SHEETS_OAUTH_CLIENT_ID` belonging to nobody.
    expect(
      extraSlugs("google-sheets", SHEETS_MARKERS, {
        GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);

    // And the token on its own — the half a connector flow writes — conjures
    // nothing either, because it is not in the marker set at all.
    expect(
      extraSlugs("google-sheets", SHEETS_MARKERS, {
        GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "token",
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

  it("loses the per-slug mounts, not the container, when a tree exports no list", () => {
    // `google.sheets.GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES` is read off a module built
    // in another Docker stage. If it were ever absent, dereferencing it inside
    // `buildMounts()` would exit the process and take all thirty mounts down.
    const log = captureLog();

    expect(
      extraSlugs("google-sheets", undefined as unknown as string[], {
        GOOGLE_SHEETS_X__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
    expect(log.lines()).toHaveLength(1);
    expect(log.lines()[0]).toContain("no marker names");
  });

  /**
   * gmail's marker set, and it is the same two-of-a-larger-set shape as sheets'
   * for the same reason: the token is minted after the deploy, on the slug's own
   * console page.
   *
   * The names come from `images/bundle-google/src/gmail.ts`, and
   * `test/env-prefix.markers.test.ts` in the core suite is what holds this copy
   * to that one — a grep, because the two trees are on opposite sides of an npm
   * boundary and nothing else sees both.
   */
  const GMAIL_MARKERS = ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"];

  it("finds an UNCONNECTED gmail slug beside the conventional service-account mount", () => {
    // The state a prod `gmail-personal-ro` deploys in: the OAuth app pair
    // injected by the renderer, no token yet, and the conventional /gmail
    // mount's service-account credential sitting on the same container under
    // bare names. Discovery must see the slug; `dropInheritedNames` below is
    // what keeps it from seeing the wrong mailbox.
    const found = extraSlugs("gmail", GMAIL_MARKERS, {
      GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@tadasant.iam.gserviceaccount.com",
      GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      GMAIL_IMPERSONATE_EMAIL: "tadas@tadasant.com",
      GMAIL_PERSONAL_RO__GMAIL_OAUTH_CLIENT_ID: "id",
      GMAIL_PERSONAL_RO__GMAIL_OAUTH_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv);

    expect(found).toEqual(["gmail-personal-ro"]);
  });

  it("does not mistake the conventional gmail credential for a per-slug one", () => {
    // Three bare service-account variables and no prefixed OAuth pair is the
    // deployment every strad has today. It asks for no second mount.
    expect(
      extraSlugs("gmail", GMAIL_MARKERS, {
        GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@tadasant.iam.gserviceaccount.com",
        GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
        GMAIL_IMPERSONATE_EMAIL: "tadas@tadasant.com",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  /**
   * google-docs has gmail's two auth modes and so gmail's marker shape. The
   * names come from `images/bundle-google/src/docs.ts`;
   * `test/env-prefix.markers.test.ts` in the core suite holds this copy to it.
   */
  const DOCS_MARKERS = [
    "GOOGLE_DOCS_OAUTH_CLIENT_ID",
    "GOOGLE_DOCS_OAUTH_CLIENT_SECRET",
  ];

  it("finds an UNCONNECTED google-docs slug beside the conventional service-account mount", () => {
    // The state a prod `google-docs-personal-ro` deploys in, with the
    // conventional /google-docs slugs' variables baked under their own
    // prefixes too — those carry no OAuth pair, so they ask for no mount.
    const found = extraSlugs("google-docs", DOCS_MARKERS, {
      GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@tadasant.iam.gserviceaccount.com",
      GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      GOOGLE_DOCS_IMPERSONATE_EMAIL: "tadas@tadasant.com",
      GOOGLE_DOCS_RO__GOOGLE_DOCS_IMPERSONATE_EMAIL: "tadas@tadasant.com",
      GOOGLE_DOCS_PERSONAL_RO__GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
      GOOGLE_DOCS_PERSONAL_RO__GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_DOCS_PERSONAL_RW_EXTERNAL__GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
      GOOGLE_DOCS_PERSONAL_RW_EXTERNAL__GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv);

    expect(found.sort()).toEqual([
      "google-docs-personal-ro",
      "google-docs-personal-rw-external",
    ]);
  });

  it("does not hand a google-sheets OAuth pair to google-docs, or the reverse", () => {
    // Both trees are Google OAuth on one container. A docs slug left on the
    // google-sheets default variable names is discovered by SHEETS, which is
    // why a docs connector has to name GOOGLE_DOCS_OAUTH_* explicitly.
    const env = {
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv;
    expect(extraSlugs("google-docs", DOCS_MARKERS, env)).toEqual([]);
    expect(
      extraSlugs("google-sheets", SHEETS_MARKERS, {
        GOOGLE_DOCS_PERSONAL_RO__GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
        GOOGLE_DOCS_PERSONAL_RO__GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
      } as NodeJS.ProcessEnv),
    ).toEqual([]);
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
 * The bare-name fallback, closed for the one variable that is an identity.
 *
 * `slugEnvView` gives a slug the bare value for anything it has no name of its
 * own for. Discovery used to require a google-sheets slug's refresh token, so a
 * per-slug mount always had one and this could not bite; keying discovery on the
 * OAuth app pair is what makes it reachable.
 */
describe("dropInheritedNames", () => {
  const TOKEN = "GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN";

  it("keeps a name the slug holds under its OWN prefix", () => {
    const view = { [TOKEN]: "mine" };

    dropInheritedNames(view, "google-sheets-personal-ro", [TOKEN], {
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "mine",
      [TOKEN]: "somebody-elses",
    } as NodeJS.ProcessEnv);

    expect(view).toEqual({ [TOKEN]: "mine" });
  });

  it("drops a bare value the slug would otherwise inherit, and says whose it is", () => {
    // The failure: an unconnected slug reports itself healthy and serves ANOTHER
    // Google account's spreadsheets, because one OAuth app usually serves every
    // slug and the refresh would succeed.
    const log = captureLog();
    const view = { [TOKEN]: "somebody-elses" };

    dropInheritedNames(view, "google-sheets-personal-ro", [TOKEN], {
      [TOKEN]: "somebody-elses",
    } as NodeJS.ProcessEnv);

    expect(view).toEqual({});
    expect(log.lines()).toHaveLength(1);
    expect(log.lines()[0]).toContain(`not inheriting the bare ${TOKEN}`);
    expect(log.lines()[0]).toContain(
      "GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN",
    );
  });

  it("says nothing when there was nothing to inherit, which is the normal case", () => {
    // Every unconnected slug on a bundle with no bare token takes this path, and
    // a warning per boot per slug for the designed state would be noise.
    const log = captureLog();
    const view: Record<string, string | undefined> = {};

    dropInheritedNames(view, "google-sheets-personal-ro", [TOKEN], {
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_CLIENT_ID: "id",
    } as NodeJS.ProcessEnv);

    expect(view).toEqual({});
    expect(log.lines()).toEqual([]);
  });

  it("treats an empty per-slug value as no value: '' is not a credential", () => {
    const view = { [TOKEN]: "somebody-elses" };

    dropInheritedNames(view, "google-sheets-personal-ro", [TOKEN], {
      GOOGLE_SHEETS_PERSONAL_RO__GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN: "",
      [TOKEN]: "somebody-elses",
    } as NodeJS.ProcessEnv);

    expect(view).toEqual({});
  });

  /**
   * GMAIL IS THE CASE THAT MAKES THIS A LIST RATHER THAN A NAME.
   *
   * Sheets has one auth mode, so the worst a bare-name fallback can do there is
   * hand a mount another Google account's SPREADSHEETS token. Gmail has two, and
   * the bundle carries both at once — the conventional `/gmail` mount runs on a
   * service account impersonating a Workspace user, so all three of those
   * variables are on the container as bare names.
   *
   * Inherit them and an unconnected `gmail-personal-ro` is not degraded: it is
   * SOMEBODY ELSE. Tadas's work mailbox, served under a slug named for his
   * personal account, with every tool call succeeding and the console page still
   * saying "not connected". Nothing about that reads as a failure.
   */
  const GMAIL_PER_ACCOUNT = [
    "GMAIL_OAUTH_REFRESH_TOKEN",
    "GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL",
    "GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY",
    "GMAIL_IMPERSONATE_EMAIL",
  ];

  it("drops gmail's SERVICE-ACCOUNT names too, not just its refresh token", () => {
    const log = captureLog();
    const box = {
      GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@tadasant.iam.gserviceaccount.com",
      GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      GMAIL_IMPERSONATE_EMAIL: "tadas@tadasant.com",
      GMAIL_PERSONAL_RO__GMAIL_OAUTH_CLIENT_ID: "id",
      GMAIL_PERSONAL_RO__GMAIL_OAUTH_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv;
    // What `slugEnvView` hands the mount: its own two, plus the bare three.
    const view: Record<string, string | undefined> = {
      ...box,
      GMAIL_OAUTH_CLIENT_ID: "id",
      GMAIL_OAUTH_CLIENT_SECRET: "secret",
    };

    dropInheritedNames(view, "gmail-personal-ro", GMAIL_PER_ACCOUNT, box);

    // The marker pair survives — it is this slug's own, and it is what the
    // consent flow needs to mint the token.
    expect(view.GMAIL_OAUTH_CLIENT_ID).toBe("id");
    expect(view.GMAIL_OAUTH_CLIENT_SECRET).toBe("secret");
    // Every name that decides WHICH MAILBOX is gone.
    for (const name of GMAIL_PER_ACCOUNT) expect(name in view).toBe(false);

    // Three of the four were really on the box, and they are ONE line — the
    // steady state of every gmail connector slug on a bundle that also serves
    // the conventional /gmail mount, on every boot, forever.
    expect(log.lines()).toHaveLength(1);
    for (const name of [
      "GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL",
      "GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY",
      "GMAIL_IMPERSONATE_EMAIL",
      "GMAIL_PERSONAL_RO__GMAIL_IMPERSONATE_EMAIL",
    ]) {
      expect(log.lines()[0]).toContain(name);
    }
    // The token was never on the box, so it is dropped without being reported:
    // "there was nothing to inherit" is not news.
    expect(log.lines()[0]).not.toContain("GMAIL_OAUTH_REFRESH_TOKEN");
  });

  it("keeps a gmail slug's OWN impersonation name, if a deployment ever seeds one", () => {
    // The rule is "its own name or nothing", not "OAuth only". A slug seeded a
    // per-slug service account is a slug that named its own mailbox, and that is
    // exactly the case the bare-name fallback cannot distinguish on its own.
    const view: Record<string, string | undefined> = {
      GMAIL_IMPERSONATE_EMAIL: "mine@tadasant.com",
    };

    dropInheritedNames(view, "gmail-work-ro", GMAIL_PER_ACCOUNT, {
      GMAIL_WORK_RO__GMAIL_IMPERSONATE_EMAIL: "mine@tadasant.com",
      GMAIL_IMPERSONATE_EMAIL: "tadas@tadasant.com",
    } as NodeJS.ProcessEnv);

    expect(view).toEqual({ GMAIL_IMPERSONATE_EMAIL: "mine@tadasant.com" });
  });
});

describe("dropInheritedNames for google-docs", () => {
  it("drops the SERVICE-ACCOUNT names too, so an unconnected slug serves nobody's Drive", () => {
    captureLog();
    const PER_ACCOUNT = [
      "GOOGLE_DOCS_OAUTH_REFRESH_TOKEN",
      "GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL",
      "GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY",
      "GOOGLE_DOCS_IMPERSONATE_EMAIL",
    ];
    const box = {
      GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL: "dwd@tadasant.iam.gserviceaccount.com",
      GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
      GOOGLE_DOCS_IMPERSONATE_EMAIL: "tadas@tadasant.com",
      GOOGLE_DOCS_PERSONAL_RO__GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
      GOOGLE_DOCS_PERSONAL_RO__GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv;
    const view: Record<string, string | undefined> = {
      ...box,
      GOOGLE_DOCS_OAUTH_CLIENT_ID: "id",
      GOOGLE_DOCS_OAUTH_CLIENT_SECRET: "secret",
    };

    dropInheritedNames(view, "google-docs-personal-ro", PER_ACCOUNT, box);

    expect(view.GOOGLE_DOCS_OAUTH_CLIENT_ID).toBe("id");
    expect(view.GOOGLE_DOCS_OAUTH_CLIENT_SECRET).toBe("secret");
    for (const name of PER_ACCOUNT) expect(name in view).toBe(false);
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

  it("is not degraded without a viewer domain on a uniform-access bucket", () => {
    expect(
      remoteFilesystemDegraded(
        {
          [`${PREFIX}_GCS_BUCKET`]: "strad-artifacts",
          [`${PREFIX}_UNIFORM_ACCESS`]: "true",
        },
        PREFIX,
      ),
    ).toBeNull();
  });

  it("still degrades sensitive uploads when UNIFORM_ACCESS is anything but true", () => {
    expect(
      remoteFilesystemDegraded(
        {
          [`${PREFIX}_GCS_BUCKET`]: "strad-artifacts",
          [`${PREFIX}_UNIFORM_ACCESS`]: "false",
        },
        PREFIX,
      ),
    ).toContain("_SENSITIVE_VIEWER_DOMAIN is not set");
  });

  it("reports a viewer domain beside UNIFORM_ACCESS=true, which fails every call", () => {
    expect(
      remoteFilesystemDegraded(
        {
          [`${PREFIX}_GCS_BUCKET`]: "strad-artifacts",
          [`${PREFIX}_UNIFORM_ACCESS`]: "true",
          [`${PREFIX}_SENSITIVE_VIEWER_DOMAIN`]: "example.com",
        },
        PREFIX,
      ),
    ).toContain("is set alongside REMOTE_FILESYSTEM_TMP_PUBLIC_UNIFORM_ACCESS=true; every tool will fail");
  });

  it("reports a malformed UNIFORM_ACCESS rather than the viewer domain", () => {
    expect(
      remoteFilesystemDegraded(
        { [`${PREFIX}_GCS_BUCKET`]: "strad-artifacts", [`${PREFIX}_UNIFORM_ACCESS`]: "TRUE" },
        PREFIX,
      ),
    ).toBe(`${PREFIX}_UNIFORM_ACCESS="TRUE" is not "true" or "false"; every tool will fail`);
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
    // tree's full credential list here would put that cycle back. Asserted on the
    // ARGUMENT rather than on the file containing a string, so the host may go on
    // naming the whole credential elsewhere — as it does, to subtract the pair.
    const call = host.match(/extraSlugs\(\s*"google-sheets",\s*([\w.]+)/);
    expect(call?.[1]).toBe("google.sheets.GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES");
  });

  it("keeps a discovered google-sheets mount off the inherited names", () => {
    // The other half of that decision: discovery no longer requires the token, so
    // the bare fallback for it has to be closed by hand.
    expect(host).toContain("dropInheritedNames(");
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

describe("instanceEnv", () => {
  it("hands a store-served instance its served values and the process basics, and no credential from the box", () => {
    const box = {
      PATH: "/usr/bin",
      HOME: "/home/app",
      // Baked for the CONVENTIONAL telegram mount. A half-seeded instance must
      // not complete itself out of these.
      TELEGRAM_API_ID: "999",
      TELEGRAM_STRING_SESSION: "the-conventional-mounts-login",
      TELEGRAM_PERSONAL__TELEGRAM_API_HASH: "a-per-slug-alias",
    } as NodeJS.ProcessEnv;

    const env = instanceEnv({ TELEGRAM_API_ID: "2222" }, box);

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/app",
      TELEGRAM_API_ID: "2222",
    });
  });

  it("never lets a served name replace a process one", () => {
    // A parameter called PATH is not a credential, and letting it steer which
    // binary the grafana tree spawns would make seeding a namespace a way to
    // run code.
    const env = instanceEnv({ PATH: "/tmp/evil", GRAFANA_URL: "https://g" }, {
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GRAFANA_URL).toBe("https://g");
  });
  it("passes the host's tailnet proxy address through, and never a served one in its place", () => {
    const env = instanceEnv(
      { SSH_HOST: "staging.zimmer.tadasant.com", STRAD_TAILNET_SOCKS5: "203.0.113.9:1080" },
      { PATH: "/usr/bin", STRAD_TAILNET_SOCKS5: "127.0.0.1:1055", STRAD_TAILNET_AUTHKEY: "tskey-x" } as NodeJS.ProcessEnv,
    );
    expect(env.STRAD_TAILNET_SOCKS5).toBe("127.0.0.1:1055");
    expect(env).not.toHaveProperty("STRAD_TAILNET_AUTHKEY");
  });
});

/**
 * 1Password: one mount per service-account token, and a write posture that is
 * read per slug and never inherited.
 */
describe("1Password per slug", () => {
  const TOKEN = "OP_SERVICE_ACCOUNT_TOKEN";

  it("discovers a mount for every slug that carries its own token", () => {
    captureLog();
    const env = {
      // The conventional mount's, read by the slugs sharing /onepassword.
      [TOKEN]: "ops_tadas_rw",
      ONEPASSWORD_TADAS_ALL__OP_SERVICE_ACCOUNT_TOKEN: "ops_tadas_all",
      ONEPASSWORD_PULSEMCP_PROVISIONING__OP_SERVICE_ACCOUNT_TOKEN: "ops_pulsemcp",
      // A posture variable alone is not a 1Password account.
      ONEPASSWORD_STRAY__OP_ELICITATION_WRITE: "false",
    } as NodeJS.ProcessEnv;

    expect(extraSlugs("onepassword", [TOKEN], env)).toEqual([
      "onepassword-pulsemcp-provisioning",
      "onepassword-tadas-all",
    ]);
  });

  it("never lets a per-slug mount fall back to the bare token, which is another account", () => {
    const log = captureLog();
    const view: Record<string, string | undefined> = { [TOKEN]: "ops_tadas_rw" };

    dropInheritedNames(view, "onepassword-pulsemcp-ro", [TOKEN], {
      [TOKEN]: "ops_tadas_rw",
    } as NodeJS.ProcessEnv);

    expect(view[TOKEN]).toBeUndefined();
    expect(log.lines()[0]).toContain("ONEPASSWORD_PULSEMCP_RO__OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("treats an empty per-slug token as none, and still refuses the bare one", () => {
    // The state discovery CAN produce: the prefixed key is on the box, empty.
    const view: Record<string, string | undefined> = { [TOKEN]: "ops_tadas_rw" };
    dropInheritedNames(view, "onepassword-tadas-all", [TOKEN], {
      [TOKEN]: "ops_tadas_rw",
      ONEPASSWORD_TADAS_ALL__OP_SERVICE_ACCOUNT_TOKEN: "",
    } as NodeJS.ProcessEnv, true);
    expect(view[TOKEN]).toBeUndefined();
  });

  it("confirms writes unless the slug's OWN name says exactly false", () => {
    const slug = "onepassword-pulsemcp-provisioning";
    const own = "ONEPASSWORD_PULSEMCP_PROVISIONING__OP_ELICITATION_WRITE";
    expect(onePasswordConfirmsWrites(slug, true, {})).toBe(true);
    expect(onePasswordConfirmsWrites(slug, true, { [own]: "false" })).toBe(false);
    expect(onePasswordConfirmsWrites(slug, true, { [own]: " FALSE " })).toBe(false);
    // A typo leaves the prompt on rather than off.
    expect(onePasswordConfirmsWrites(slug, true, { [own]: "no" })).toBe(true);
    expect(onePasswordConfirmsWrites(slug, true, { [own]: "true" })).toBe(true);
  });

  it("ignores a BARE OP_ELICITATION_WRITE, which belongs to whichever sibling set it", () => {
    // The provisioning slug's `false` lands on the box under the bare name too.
    // It must not switch off the prompt for onepassword-pulsemcp-rw beside it.
    const env = {
      OP_ELICITATION_WRITE: "false",
      ONEPASSWORD_PULSEMCP_PROVISIONING__OP_ELICITATION_WRITE: "false",
    };
    expect(onePasswordConfirmsWrites("onepassword-pulsemcp-rw", true, env)).toBe(true);
    expect(onePasswordConfirmsWrites("onepassword-pulsemcp-provisioning", true, env)).toBe(
      false,
    );
  });

  it("always confirms writes on the conventional /onepassword mount", () => {
    expect(
      onePasswordConfirmsWrites("onepassword", false, {
        OP_ELICITATION_WRITE: "false",
        ONEPASSWORD__OP_ELICITATION_WRITE: "false",
      }),
    ).toBe(true);
  });

  it("is wired into the host: discovered on the token, kept off the bare one, behind the confirmation layer", () => {
    const host = readFileSync("src/index.ts", "utf8");
    expect(host).toMatch(/extraSlugs\("onepassword", ONEPASSWORD_MARKER_NAMES\)/);
    expect(host).toContain("dropInheritedNames(view, slug, ONEPASSWORD_MARKER_NAMES, process.env, quiet)");
    expect(host).toContain("op.confirm.withConfirmation(");
    expect(host).toContain("confirm.forceAskEverything(process.env)");
    // The old posture check is gone: the mount no longer needs a container-wide
    // elicitation URL or DANGEROUSLY_SKIP_ELICITATIONS to exist.
    expect(host).not.toContain("checkElicitationSafety");
  });
});

describe("ownNameOnly", () => {
  const NAME = "GMAIL_SENDER_DISPLAY_NAME";
  // What the renderer emits when gmail-zimmer-rw-external declares the name in
  // its env: the per-slug alias AND the bare name, on the same container as
  // Tadas's own mounts.
  const env = {
    GMAIL_SENDER_DISPLAY_NAME: "Zimmer (Tadas's Assistant)",
    GMAIL_ZIMMER_RW_EXTERNAL__GMAIL_SENDER_DISPLAY_NAME: "Zimmer (Tadas's Assistant)",
  } as NodeJS.ProcessEnv;

  it("gives a slug the value declared under its own name", () => {
    const view: Record<string, string | undefined> = { ...env };
    ownNameOnly(view, "gmail-zimmer-rw-external", NAME, env);
    expect(view[NAME]).toBe("Zimmer (Tadas's Assistant)");
  });

  it("never lets a sibling's bare value name another mailbox's mail", () => {
    for (const slug of ["gmail-tadas412-rw-external", "gmail"]) {
      const view: Record<string, string | undefined> = { ...env };
      ownNameOnly(view, slug, NAME, env);
      expect(view).not.toHaveProperty(NAME);
    }
  });

  it("reads the conventional mount's own name, GMAIL__…", () => {
    const own = { ...env, GMAIL__GMAIL_SENDER_DISPLAY_NAME: "Tadas" } as NodeJS.ProcessEnv;
    const view: Record<string, string | undefined> = { ...own };
    ownNameOnly(view, "gmail", NAME, own);
    expect(view[NAME]).toBe("Tadas");
  });
});

describe("ownNameOnly, for grafana's write opt-in", () => {
  // What loadGrafana does to every view before the tree reads it: the opt-in
  // is the slug's own `<SLUG>__GRAFANA_ALLOW_WRITE` or nothing. The renderer
  // emits a write-enabled slug's key under its bare name as well as its own, so
  // the bare value is on the box beside every read-only Grafana.
  const NAME = "GRAFANA_ALLOW_WRITE";
  const env = {
    GRAFANA_ALLOW_WRITE: "true",
    GRAFANA_PULSEMCP_PROD_RW__GRAFANA_ALLOW_WRITE: "true",
    GRAFANA_PULSEMCP_PROD_RW__GRAFANA_URL: "https://obs.example",
    GRAFANA_PULSEMCP_PROD__GRAFANA_URL: "https://obs.example",
    GRAFANA_PULSEMCP_PROD__GRAFANA_ALLOW_WRITE: "false",
  } as NodeJS.ProcessEnv;

  function viewFor(slug: string, source: NodeJS.ProcessEnv = env) {
    const view = slugEnvView(source, slug);
    ownNameOnly(view, slug, NAME, source);
    return view;
  }

  it("gives the opted-in slug its own value", () => {
    expect(viewFor("grafana-pulsemcp-prod-rw")[NAME]).toBe("true");
  });

  it("never lets the bare value or a sibling's widen another mount", () => {
    // `grafana-pulsemcp-prod` declares its own "false"; `grafana` and
    // `grafana-registry` declare nothing and would otherwise read the bare
    // "true" through slugEnvView's fallback.
    expect(viewFor("grafana-pulsemcp-prod")[NAME]).toBe("false");
    for (const slug of ["grafana", "grafana-registry"]) {
      expect(viewFor(slug)).not.toHaveProperty(NAME);
    }
  });

  it("does not take a store-served instance's opt-in from its namespace", () => {
    // A runtime parameter write can seed an instance's namespace, so a value
    // there must not turn writes on: the instance reads the container's own
    // name for its slug, which only a deploy puts there.
    const view = instanceEnv({ GRAFANA_URL: "https://g", GRAFANA_ALLOW_WRITE: "true" }, {});
    ownNameOnly(view, "grafana-elsewhere", NAME, {} as NodeJS.ProcessEnv);
    expect(view).not.toHaveProperty(NAME);

    const deployed = { GRAFANA_ELSEWHERE__GRAFANA_ALLOW_WRITE: "true" } as NodeJS.ProcessEnv;
    const optedIn = instanceEnv({ GRAFANA_URL: "https://g" }, deployed);
    ownNameOnly(optedIn, "grafana-elsewhere", NAME, deployed);
    expect(optedIn[NAME]).toBe("true");
  });
});

describe("glitchtip's write switch", () => {
  const NAME = "GLITCHTIP_ALLOW_WRITE";
  // What the renderer emits for a write slug beside a read-only sibling, plus a
  // bare switch some other server's env put on the same container.
  const env = {
    GLITCHTIP_BASE_URL: "https://glitchtip.example.com",
    GLITCHTIP_ALLOW_WRITE: "true",
    GLITCHTIP_PULSEMCP_PROD_RW__GLITCHTIP_API_TOKEN: "rw-token",
    GLITCHTIP_PULSEMCP_PROD_RW__GLITCHTIP_ALLOW_WRITE: "true",
    GLITCHTIP_PULSEMCP_PROD__GLITCHTIP_API_TOKEN: "ro-token",
  } as NodeJS.ProcessEnv;

  /** The view `loadGlitchTip` hands the tree, as far as the switch goes. */
  function viewFor(slug: string, from: NodeJS.ProcessEnv = env) {
    const view = slugEnvView(from, slug);
    ownNameOnly(view, slug, NAME, from);
    return view;
  }

  it("opens the slug that declares it under its own name", () => {
    expect(viewFor("glitchtip-pulsemcp-prod-rw")[NAME]).toBe("true");
  });

  it("opens neither a sibling nor the conventional mount on a bare or sibling's value", () => {
    expect(viewFor("glitchtip-pulsemcp-prod")).not.toHaveProperty(NAME);
    expect(viewFor("glitchtip")).not.toHaveProperty(NAME);
  });

  it("reads the conventional mount's own name, GLITCHTIP__…", () => {
    const own = { ...env, GLITCHTIP__GLITCHTIP_ALLOW_WRITE: "true" } as NodeJS.ProcessEnv;
    expect(viewFor("glitchtip", own)[NAME]).toBe("true");
  });

  it("is applied to every glitchtip mount, ahead of the per-slug branch", () => {
    const host = readFileSync("src/index.ts", "utf8");
    const loader = host.slice(host.indexOf("function loadGlitchTip("));
    const body = loader.slice(0, loader.indexOf("\n}\n"));
    const own = body.indexOf("ownNameOnly(env, slug, mod.ENV.allowWrite);");
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(body.indexOf("if (perSlug)"));
  });
});

describe("dropUnpairedCredentials", () => {
  // The conventional /victorialogs mount reads bare names, and the renderer
  // picks each bare name's owner separately: C declared only an entrypoint, B
  // an entrypoint and a token, so the bare entrypoint is C's and the bare token
  // B's. Sent together, B's token goes to C's host.
  const ENV = {
    VL_INSTANCE_ENTRYPOINT: "https://c.example",
    VL_INSTANCE_BEARER_TOKEN: "b-token",
    VL_DEFAULT_TENANT_ID: "7",
    VICTORIALOGS_B__VL_INSTANCE_ENTRYPOINT: "https://b.example",
    VICTORIALOGS_B__VL_INSTANCE_BEARER_TOKEN: "b-token",
    VICTORIALOGS_B__VL_DEFAULT_TENANT_ID: "7",
  };
  const NAMES = ["VL_INSTANCE_BEARER_TOKEN", "VL_INSTANCE_HEADERS", "VL_DEFAULT_TENANT_ID"];

  it("drops a bare credential that a sibling with a different origin owns", () => {
    const log = captureLog();
    const view: Record<string, string | undefined> = { ...ENV };
    const dropped = dropUnpairedCredentials(
      view,
      "VL_INSTANCE_ENTRYPOINT",
      NAMES,
      ["victorialogs-b"],
      ENV,
    );
    expect(dropped).toEqual(["VL_INSTANCE_BEARER_TOKEN", "VL_DEFAULT_TENANT_ID"]);
    expect(view.VL_INSTANCE_BEARER_TOKEN).toBeUndefined();
    expect(view.VL_INSTANCE_ENTRYPOINT).toBe("https://c.example");
    expect(log.lines().join("\n")).toContain("not using the bare");
  });

  it("keeps the bare credential when its owner's origin IS the bare origin", () => {
    const env = { ...ENV, VL_INSTANCE_ENTRYPOINT: "https://b.example" };
    const view: Record<string, string | undefined> = { ...env };
    expect(
      dropUnpairedCredentials(view, "VL_INSTANCE_ENTRYPOINT", NAMES, ["victorialogs-b"], env),
    ).toEqual([]);
    expect(view.VL_INSTANCE_BEARER_TOKEN).toBe("b-token");
  });

  it("keeps a bare credential no slug claims, and does nothing with no siblings", () => {
    const view: Record<string, string | undefined> = {
      VL_INSTANCE_ENTRYPOINT: "https://c.example",
      VL_INSTANCE_BEARER_TOKEN: "c-token",
    };
    expect(
      dropUnpairedCredentials(view, "VL_INSTANCE_ENTRYPOINT", NAMES, ["victorialogs-b"], ENV),
    ).toEqual([]);
    expect(dropUnpairedCredentials(view, "VL_INSTANCE_ENTRYPOINT", NAMES, [], ENV)).toEqual([]);
    expect(view.VL_INSTANCE_BEARER_TOKEN).toBe("c-token");
  });
});

describe("hatchboxEnvView", () => {
  // The tree's own list (servers/hatchbox/shared/src/config.ts,
  // HATCHBOX_ALL_ENV_NAMES), copied because the host cannot import across
  // the tree boundary in a unit test.
  const REFUSED = ["READONLY", "ALLOW_DEPLOYS", "WEB_SERVER_IP_ADDRESS", "SSH_KEY_PATH"];
  const NAMES = [
    "HATCHBOX_APP_ID",
    "HATCHBOX_ACCOUNT_ID",
    "HATCHBOX_API_KEY",
    "HATCHBOX_DEPLOY_KEY",
    "HATCHBOX_SSH_HOST",
    "HATCHBOX_SSH_PORT",
    "HATCHBOX_SSH_USERNAME",
    "HATCHBOX_SSH_PRIVATE_KEY",
    "HATCHBOX_SSH_PASSPHRASE",
    "HATCHBOX_SSH_HOST_KEY",
    "HATCHBOX_APP_NAME",
    ...REFUSED,
  ];
  // What the renderer bakes for `-ro` (SSH), `-deploy` (deploy key) and `-rw`
  // (everything) on one bundle: each slug's names under its own prefix, AND
  // the bare names, each owned by whichever slug the renderer picked.
  const box = {
    HATCHBOX_PULSE_RO__HATCHBOX_APP_ID: "8540",
    HATCHBOX_PULSE_RO__HATCHBOX_SSH_PRIVATE_KEY: "ro-ssh-key",
    HATCHBOX_PULSE_DEPLOY__HATCHBOX_APP_ID: "8540",
    HATCHBOX_PULSE_DEPLOY__HATCHBOX_DEPLOY_KEY: "deploy-key",
    HATCHBOX_PULSE_RW__HATCHBOX_APP_ID: "8540",
    HATCHBOX_PULSE_RW__HATCHBOX_API_KEY: "rw-api-key",
    HATCHBOX_PULSE_RW__HATCHBOX_DEPLOY_KEY: "deploy-key",
    HATCHBOX_PULSE_RW__HATCHBOX_SSH_PRIVATE_KEY: "rw-ssh-key",
    HATCHBOX_PULSE_RW__HATCHBOX_SSH_PASSPHRASE: "rw-pass",
    HATCHBOX_APP_ID: "8540",
    HATCHBOX_API_KEY: "rw-api-key",
    HATCHBOX_DEPLOY_KEY: "deploy-key",
    HATCHBOX_SSH_PRIVATE_KEY: "rw-ssh-key",
    HATCHBOX_SSH_PASSPHRASE: "rw-pass",
    // Some other server on the bundle declared this under its bare name.
    READONLY: "true",
  };
  const view = (slug: string, perSlug: boolean, siblings: string[] = [], from: NodeJS.ProcessEnv = box) => {
    const v: Record<string, string | undefined> = { ...from };
    hatchboxEnvView(v, slug, perSlug, siblings, NAMES, REFUSED, from);
    return v;
  };

  it("never lets -ro inherit a sibling's bare API key, deploy key or passphrase", () => {
    const v = view("hatchbox-pulse-ro", true);
    expect(v.HATCHBOX_APP_ID).toBe("8540");
    expect(v.HATCHBOX_SSH_PRIVATE_KEY).toBe("ro-ssh-key");
    expect(v.HATCHBOX_API_KEY).toBeUndefined();
    expect(v.HATCHBOX_DEPLOY_KEY).toBeUndefined();
    expect(v.HATCHBOX_SSH_PASSPHRASE).toBeUndefined();
    expect(v.READONLY).toBeUndefined();
  });

  it("never lets -deploy inherit the SSH key or the API key", () => {
    const v = view("hatchbox-pulse-deploy", true);
    expect(v.HATCHBOX_DEPLOY_KEY).toBe("deploy-key");
    expect(v.HATCHBOX_SSH_PRIVATE_KEY).toBeUndefined();
    expect(v.HATCHBOX_API_KEY).toBeUndefined();
  });

  it("gives -rw all of its own names", () => {
    const v = view("hatchbox-pulse-rw", true);
    expect(v.HATCHBOX_API_KEY).toBe("rw-api-key");
    expect(v.HATCHBOX_SSH_PASSPHRASE).toBe("rw-pass");
  });

  it("leaves the conventional mount only its own HATCHBOX__ names once a sibling exists", () => {
    const v = view("hatchbox", false, ["hatchbox-pulse-ro"]);
    for (const name of NAMES) expect(v[name], name).toBeUndefined();
    const own = view("hatchbox", false, ["hatchbox-pulse-ro"], { ...box, HATCHBOX__HATCHBOX_APP_ID: "1" });
    expect(own.HATCHBOX_APP_ID).toBe("1");
  });

  it("keeps the conventional mount's bare names when it is the only one, but never another server's READONLY", () => {
    const v = view("hatchbox", false, [], { HATCHBOX_APP_ID: "1", HATCHBOX_DEPLOY_KEY: "k", READONLY: "true" });
    expect(v).toEqual({ HATCHBOX_APP_ID: "1", HATCHBOX_DEPLOY_KEY: "k" });
  });
});
