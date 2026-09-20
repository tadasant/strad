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
