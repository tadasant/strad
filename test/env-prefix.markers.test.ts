import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The renderer names a variable; the bundle host is the only thing that reads it
 * back. Nothing else in the system sees both halves.
 *
 * That the RULE is byte-identical in both trees is one entry in the vendoring
 * manifest and is checked in `test/vendored.sync.test.ts`. This file owns the
 * other half, which no manifest can see: that the NAMES the rule is applied to
 * are still the names the two trees really use.
 *
 * The host discovers a second instance of a tree by looking for that tree's
 * variables under a slug prefix. Rename a variable in the tree and say nothing
 * here, and discovery stops finding anything — silently, because "no per-slug
 * values" and "the names moved" look identical from the host.
 *
 * These trees are outside the core TS program, so this reads them as text rather
 * than importing them. A grep is a weak assertion and it is the right strength
 * for the thing being asserted: that two files still spell one name the same way.
 */
describe("the marker names the bundle host looks for", () => {
  const host = readFileSync("servers/bundle/host/src/index.ts", "utf8");

  it("are telegram's real credential variables", () => {
    const config = readFileSync(
      "servers/telegram/shared/src/config.ts",
      "utf8",
    );
    for (const name of [
      "TELEGRAM_API_ID",
      "TELEGRAM_API_HASH",
      "TELEGRAM_STRING_SESSION",
    ]) {
      expect(config).toContain(name);
      expect(host).toContain(name);
    }
  });

  it("include grafana's write opt-in, read under the slug's own name only", () => {
    // Not a marker — it creates no instance — but the same two-halves seam: the
    // tree owns the name and the rule, and the host is what restricts the view to
    // the slug's own `<SLUG>__GRAFANA_ALLOW_WRITE`. A host that stopped calling
    // `ownNameOnly` for it would let a bare `true` make every Grafana writable.
    const config = readFileSync("servers/grafana/shared/src/config.ts", "utf8");
    expect(config).toContain(
      'export const GRAFANA_ALLOW_WRITE = "GRAFANA_ALLOW_WRITE"',
    );
    expect(host).toContain("ownNameOnly(env, slug, mod.GRAFANA_ALLOW_WRITE)");
  });

  it("are google-sheets' OAuth app pair, and NOT its refresh token", () => {
    // This tree is the one whose credential is completed after the deploy, so
    // the marker set is deliberately a SUBSET of it: the two variables a human
    // seeds before consent. Discovery on all three would unmount every slug that
    // has not been connected yet — and a slug has to be mounted for its console
    // page to offer the Connect button that mints the third.
    const tree = readFileSync(
      "images/bundle-google/vendor/google-sheets-shared/src/server.ts",
      "utf8",
    );
    const markers = tree.match(
      /GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES = \[([^\]]*)\]/,
    );
    expect(markers).not.toBeNull();
    expect(markers![1]).toContain("GOOGLE_SHEETS_OAUTH_CLIENT_ID");
    expect(markers![1]).toContain("GOOGLE_SHEETS_OAUTH_CLIENT_SECRET");
    expect(markers![1]).not.toContain("GOOGLE_SHEETS_OAUTH_REFRESH_TOKEN");
    // The host names no google-sheets variable of its own: it discovers on the
    // list above, read off the built tree. So the rename this file exists to
    // catch is the CONSTANT moving, not the variables inside it.
    expect(host).toContain("google.sheets.GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES");
    expect(tree).toContain("export const GOOGLE_SHEETS_OAUTH_APP_ENV_NAMES");
  });

  it("are gmail's OAuth app pair, and its drop set spans BOTH auth modes", () => {
    // gmail's lists live in strad's OWN source rather than in the tree beside
    // them: `vendor/gmail-shared` is vendored verbatim from pulsemcp/mcp-servers
    // and reads `process.env`, which is right for one-server-per-process and
    // impossible here. `images/bundle-google/src/gmail.ts` is the layer that
    // injects an env.
    const tree = readFileSync("images/bundle-google/src/gmail.ts", "utf8");

    const markers = tree.match(/GMAIL_OAUTH_APP_ENV_NAMES = \[([^\]]*)\]/);
    expect(markers).not.toBeNull();
    expect(markers![1]).toContain("GMAIL_OAUTH_CLIENT_ID");
    expect(markers![1]).toContain("GMAIL_OAUTH_CLIENT_SECRET");
    expect(markers![1]).not.toContain("GMAIL_OAUTH_REFRESH_TOKEN");

    // THE OTHER HALF, and the one gmail has that sheets does not. The host
    // derives "what a discovered slug may not inherit" by subtracting the pair
    // above from GMAIL_ENV_NAMES, so that list has to name the SERVICE-ACCOUNT
    // variables as well. If it ever shrinks to the OAuth three, an unconnected
    // per-slug mount silently falls back to the conventional mount's Workspace
    // credential and serves the wrong mailbox.
    const service = tree.match(
      /GMAIL_SERVICE_ACCOUNT_ENV_NAMES = \[([^\]]*)\]/,
    );
    expect(service).not.toBeNull();
    for (const name of [
      "GMAIL_SERVICE_ACCOUNT_CLIENT_EMAIL",
      "GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY",
      "GMAIL_IMPERSONATE_EMAIL",
    ]) {
      expect(service![1]).toContain(name);
    }
    expect(tree).toContain("...GMAIL_SERVICE_ACCOUNT_ENV_NAMES");

    // The host names no gmail variable of its own: it discovers on the list
    // above, read off the built module. So the rename this catches is the
    // CONSTANT moving, not the variables inside it.
    expect(host).toContain("google.gmail.GMAIL_OAUTH_APP_ENV_NAMES");
    expect(host).toContain("gmail.GMAIL_ENV_NAMES");
    expect(tree).toContain("export const GMAIL_OAUTH_APP_ENV_NAMES");
    expect(tree).toContain("export const GMAIL_ENV_NAMES");
    // The sender's name is one mailbox's, so every gmail mount reads it under
    // its own slug only. Removing this call leaves `ownNameOnly`'s own tests
    // green and puts one account's name on every other mount's mail.
    expect(host).toContain(
      "ownNameOnly(view, slug, gmail.GMAIL_SENDER_NAME_ENV_NAME)",
    );
    expect(tree).toContain("export const GMAIL_SENDER_NAME_ENV_NAME");
  });

  it("are google-docs' OAuth app pair, and its drop set spans BOTH auth modes", () => {
    // gmail's shape and gmail's reason: `images/bundle-google/src/docs.ts` is
    // the layer that injects an env into a tree that reads `process.env`, and
    // the conventional /google-docs mount's service-account trio sits on the
    // same container under bare names.
    const tree = readFileSync("images/bundle-google/src/docs.ts", "utf8");

    const markers = tree.match(
      /GOOGLE_DOCS_OAUTH_APP_ENV_NAMES = \[([^\]]*)\]/,
    );
    expect(markers).not.toBeNull();
    expect(markers![1]).toContain("GOOGLE_DOCS_OAUTH_CLIENT_ID");
    expect(markers![1]).toContain("GOOGLE_DOCS_OAUTH_CLIENT_SECRET");
    expect(markers![1]).not.toContain("GOOGLE_DOCS_OAUTH_REFRESH_TOKEN");

    const service = tree.match(
      /GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES = \[([^\]]*)\]/,
    );
    expect(service).not.toBeNull();
    for (const name of [
      "GOOGLE_DOCS_SERVICE_ACCOUNT_CLIENT_EMAIL",
      "GOOGLE_DOCS_SERVICE_ACCOUNT_PRIVATE_KEY",
      "GOOGLE_DOCS_IMPERSONATE_EMAIL",
    ]) {
      expect(service![1]).toContain(name);
    }
    expect(tree).toContain("...GOOGLE_DOCS_SERVICE_ACCOUNT_ENV_NAMES");

    expect(host).toContain("google.docs.GOOGLE_DOCS_OAUTH_APP_ENV_NAMES");
    expect(host).toContain("docs.GOOGLE_DOCS_ENV_NAMES");
    expect(host).toContain('"dist/docs.js"');
    expect(tree).toContain("export const GOOGLE_DOCS_OAUTH_APP_ENV_NAMES");
    expect(tree).toContain("export const GOOGLE_DOCS_ENV_NAMES");
  });

  it("are google-calendar's OAuth app pair, and its drop set spans BOTH auth modes", () => {
    // google-docs' shape: `images/bundle-google/src/calendar.ts` injects an env
    // into the vendored tree, whose own variable names it re-exports. The
    // conventional /google-calendar mount's GCAL_* trio sits on the same
    // container under bare names, and so may a bare mode selector.
    const layer = readFileSync("images/bundle-google/src/calendar.ts", "utf8");
    const tree = readFileSync(
      "images/bundle-google/vendor/google-calendar-shared/src/server.ts",
      "utf8",
    );

    const markers = layer.match(
      /GOOGLE_CALENDAR_OAUTH_APP_ENV_NAMES = \[([^\]]*)\]/,
    );
    expect(markers).not.toBeNull();
    expect(markers![1]).toContain("GOOGLE_CALENDAR_OAUTH_CLIENT_ID");
    expect(markers![1]).toContain("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET");
    expect(markers![1]).not.toContain("GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN");
    // The pair has to be names the tree really reads.
    const oauth = tree.match(/GOOGLE_CALENDAR_OAUTH_ENV_NAMES = \[([^\]]*)\]/);
    expect(oauth).not.toBeNull();
    expect(oauth![1]).toContain("GOOGLE_CALENDAR_OAUTH_CLIENT_ID");
    expect(oauth![1]).toContain("GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET");
    expect(oauth![1]).toContain("GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN");

    expect(layer).toContain("...GOOGLE_CALENDAR_OAUTH_ENV_NAMES");
    expect(layer).toContain("...GOOGLE_CALENDAR_SERVICE_ACCOUNT_ENV_NAMES");
    expect(layer).toContain("GOOGLE_CALENDAR_AUTH_MODE_ENV,\n] as const");

    expect(host).toContain(
      "google.calendarLayer.GOOGLE_CALENDAR_OAUTH_APP_ENV_NAMES",
    );
    expect(host).toContain("calendar.GOOGLE_CALENDAR_ENV_NAMES");
    expect(host).toContain('"dist/calendar.js"');
  });

  it("are google-drive's OAuth app pair", () => {
    const tree = readFileSync(
      "images/bundle-google/vendor/google-drive-shared/src/server.ts",
      "utf8",
    );
    const markers = tree.match(
      /GOOGLE_DRIVE_OAUTH_APP_ENV_NAMES = \[([^\]]*)\]/,
    );
    expect(markers).not.toBeNull();
    expect(markers![1]).toContain("GOOGLE_DRIVE_OAUTH_CLIENT_ID");
    expect(markers![1]).toContain("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET");
    expect(markers![1]).not.toContain("GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN");
    expect(tree).toContain("'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN'");

    expect(host).toContain("google.drive.GOOGLE_DRIVE_OAUTH_APP_ENV_NAMES");
    expect(host).toContain("drive.GOOGLE_DRIVE_ENV_NAMES");
    expect(host).toContain('"vendor/google-drive-shared/build/index.js"');
  });

  it("are remote-filesystem's real prefix and bucket suffix", () => {
    const config = readFileSync(
      "servers/remote-filesystem/shared/src/config.ts",
      "utf8",
    );
    // The tree owns the SUFFIX and the host owns the prefix, so the marker name
    // only exists as the two of them composed. Assert each half where it is
    // actually declared — the tree's prefix appears in its config.ts only in a
    // comment, so grepping for that would survive the rename it exists to catch.
    expect(config).toContain('bucket: "GCS_BUCKET"');
    expect(host).toContain(
      'REMOTE_FS_ENV_PREFIX = "REMOTE_FILESYSTEM_TMP_PUBLIC"',
    );
    expect(host).toContain("REMOTE_FS_ENV_PREFIX}_GCS_BUCKET");
  });
});
