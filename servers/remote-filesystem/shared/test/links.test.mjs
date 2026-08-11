import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LINK_DAYS,
  MAX_LINK_DAYS,
  V4_MAX_EXPIRY_SECONDS,
  authenticatedBrowserUrl,
  domainReaderEntity,
  encodeObjectPath,
  envName,
  generatePath,
  inferContentType,
  isTransientConnectionError,
  loadConfig,
  signingVersionFor,
  withRetry,
} from "../build/index.js";

/**
 * The seven-day problem, in one file.
 *
 * GCS's V4 signing process refuses an expiry beyond 604800 seconds, so a 14-day
 * default is only reachable through V2. These assertions pin the boundary: the
 * modern process is used wherever it reaches, and the legacy one only past it.
 */

test("V4 covers up to exactly seven days; longer needs V2", () => {
  assert.equal(V4_MAX_EXPIRY_SECONDS, 604800);
  assert.equal(signingVersionFor(1), "v4");
  assert.equal(signingVersionFor(7), "v4", "the seven-day cap is inclusive");
  assert.equal(signingVersionFor(7.0001), "v2");
  assert.equal(signingVersionFor(DEFAULT_LINK_DAYS), "v2");
  assert.equal(signingVersionFor(MAX_LINK_DAYS), "v2");
});

test("the default link life is fourteen days, which is what was asked for", () => {
  assert.equal(DEFAULT_LINK_DAYS, 14);
});

test("the restricted link is the cookie-authenticated host, not the API host", () => {
  const url = authenticatedBrowserUrl("bucket", "a/b c.png");
  assert.equal(url, "https://storage.cloud.google.com/bucket/a/b%20c.png");
  assert.ok(
    !url.includes("storage.googleapis.com"),
    "storage.googleapis.com 403s an unauthenticated browser instead of prompting for sign-in",
  );
});

/**
 * The 403 this parameter exists to stop.
 *
 * A restricted object's ACL grants `domain-<viewer>`, but the browser front door
 * authenticates the profile's DEFAULT signed-in account — usually a personal
 * one, which is not on that ACL. `?authuser=<address>` picks the account that
 * is. Google decodes the percent-encoded form, which is the one verified against
 * the live endpoint, so that is the one emitted.
 */
test("a restricted link names the viewer account so multi-account readers are not 403ed", () => {
  const url = authenticatedBrowserUrl("bucket", "a/b c.png", "dana@example.com");
  assert.equal(
    url,
    "https://storage.cloud.google.com/bucket/a/b%20c.png?authuser=dana%40example.com",
  );
});

test("no configured account means no authuser, rather than a guessed one", () => {
  // A wrong `authuser` bounces the reader to a sign-in page, which is worse than
  // the bare URL for anyone whose default account is already the right one.
  assert.ok(!authenticatedBrowserUrl("bucket", "a.png").includes("authuser"));
  assert.ok(!authenticatedBrowserUrl("bucket", "a.png", "").includes("authuser"));
});

test("a viewer account is validated at boot, where it can still be fixed", () => {
  const base = { RF_GCS_BUCKET: "b", RF_SENSITIVE_VIEWER_DOMAIN: "example.com" };
  assert.equal(
    loadConfig("RF", { ...base, RF_SENSITIVE_VIEWER_ACCOUNT: "dana@example.com" }).viewerAccount,
    "dana@example.com",
  );
  assert.equal(loadConfig("RF", base).viewerAccount, undefined);

  // A bare username or domain is the shape Google's selector will not take.
  assert.throws(
    () => loadConfig("RF", { ...base, RF_SENSITIVE_VIEWER_ACCOUNT: "dana" }),
    /must be a full email address/,
  );
  assert.throws(
    () => loadConfig("RF", { ...base, RF_SENSITIVE_VIEWER_ACCOUNT: "example.com" }),
    /must be a full email address/,
  );
  // An account outside the granted domain would point every reader at an
  // account that is not on the ACL — the exact failure this feature fixes.
  assert.throws(
    () => loadConfig("RF", { ...base, RF_SENSITIVE_VIEWER_ACCOUNT: "dana@elsewhere.com" }),
    /is not in RF_SENSITIVE_VIEWER_DOMAIN/,
  );
  // The domain is what grants; an account without one has nothing to point at.
  assert.throws(
    () =>
      loadConfig("RF", { RF_GCS_BUCKET: "b", RF_SENSITIVE_VIEWER_ACCOUNT: "dana@example.com" }),
    /RF_SENSITIVE_VIEWER_ACCOUNT is set but RF_SENSITIVE_VIEWER_DOMAIN/,
  );
  // Surrounding whitespace is a paste artifact, not a different address — and an
  // untrimmed domain would reject a correct account with a baffling message.
  assert.equal(
    loadConfig("RF", {
      RF_GCS_BUCKET: "b",
      RF_SENSITIVE_VIEWER_DOMAIN: " example.com ",
      RF_SENSITIVE_VIEWER_ACCOUNT: " dana@example.com ",
    }).viewerAccount,
    "dana@example.com",
  );
  // Case is not a mismatch: email domains are case-insensitive.
  assert.equal(
    loadConfig("RF", {
      ...base,
      RF_SENSITIVE_VIEWER_ACCOUNT: "Dana@Example.COM",
    }).viewerAccount,
    "Dana@Example.COM",
  );
});

test("object paths encode per segment, so slashes survive", () => {
  assert.equal(encodeObjectPath("a/b/c d.png"), "a/b/c%20d.png");
  assert.equal(encodeObjectPath("a/b+c.png"), "a/b%2Bc.png");
});

test("the domain ACL entity is what GCS expects", () => {
  assert.equal(domainReaderEntity("tadasant.com"), "domain-tadasant.com");
});

test("generated paths are date-partitioned and collision-resistant", () => {
  const at = new Date("2026-08-02T08:15:00.000Z");
  assert.equal(generatePath("image/png", at, "a1b2c3"), "uploads/2026/08/02/081500-a1b2c3.png");
  assert.equal(generatePath(undefined, at, "a1b2c3"), "uploads/2026/08/02/081500-a1b2c3");
  assert.notEqual(generatePath("image/png", at), generatePath("image/png", at));
});

test("content types are inferred from the extension", () => {
  assert.equal(inferContentType("a/b.png"), "image/png");
  assert.equal(inferContentType("clip.webm"), "video/webm");
  assert.equal(inferContentType("mystery"), "application/octet-stream");
});

test("config reads slug-namespaced names and never the bare GCS ones", () => {
  const env = {
    REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET: "mine",
    REMOTE_FILESYSTEM_TMP_PUBLIC_SENSITIVE_VIEWER_DOMAIN: "tadasant.com",
    GCS_BUCKET: "someone-elses",
  };
  const config = loadConfig("REMOTE_FILESYSTEM_TMP_PUBLIC", env);
  assert.equal(config.bucket, "mine");
  assert.equal(config.viewerDomain, "tadasant.com");
  assert.equal(config.defaultLinkDays, DEFAULT_LINK_DAYS);
  assert.equal(envName("REMOTE_FILESYSTEM_TMP_PUBLIC", "bucket"), "REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET");
});

test("a missing bucket names the variable and says why it is not GCS_BUCKET", () => {
  assert.throws(
    () => loadConfig("REMOTE_FILESYSTEM_TMP_PUBLIC", { GCS_BUCKET: "someone-elses" }),
    /REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_BUCKET must be configured[\s\S]*gcs server/,
  );
});

test("an out-of-range default link life is a config error, not a silent clamp", () => {
  const base = { RF_GCS_BUCKET: "b" };
  assert.equal(loadConfig("RF", { ...base, RF_LINK_DEFAULT_DAYS: "30" }).defaultLinkDays, 30);
  assert.throws(() => loadConfig("RF", { ...base, RF_LINK_DEFAULT_DAYS: "0" }), /between 1 and 365/);
  assert.throws(() => loadConfig("RF", { ...base, RF_LINK_DEFAULT_DAYS: "999" }), /between 1 and 365/);
  assert.throws(() => loadConfig("RF", { ...base, RF_LINK_DEFAULT_DAYS: "soon" }), /between 1 and 365/);
});

test("only transient connection failures are retried", async () => {
  assert.equal(isTransientConnectionError(new Error("Premature close")), true);
  assert.equal(isTransientConnectionError({ code: "ECONNRESET" }), true);
  assert.equal(
    isTransientConnectionError(new Error("wrapped", { cause: new Error("socket hang up") })),
    true,
  );
  // A configuration error must fail fast rather than burn the backoff budget.
  assert.equal(isTransientConnectionError({ code: "ENOTFOUND" }), false);
  assert.equal(isTransientConnectionError(new Error("invalid_grant: Invalid JWT Signature")), false);

  let attempts = 0;
  const value = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("Premature close");
      return "ok";
    },
    { sleep: async () => {} },
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        attempts++;
        throw new Error("invalid_grant: Invalid JWT Signature");
      },
      { sleep: async () => {} },
    ),
    /invalid_grant/,
  );
  assert.equal(attempts, 1, "a permanent error is not retried");
});

test("base64 is accepted the way tools actually emit it, and a path is not", async () => {
  const { toolDefinitions } = await import("../build/index.js");
  const stored = [];
  const store = {
    bucket: () => "b",
    viewerDomain: () => "example.com",
    defaultLinkDays: () => 14,
    put: async (data, options) => {
      stored.push(data);
      return {
        artifact: {
          path: options.path ?? "generated",
          size_bytes: data.length,
          content_type: "text/plain",
          updated_at: "",
          access: "link",
        },
        link: {
          url: "https://example.test/x",
          expires_at: null,
          signing_version: "v2",
          requires_sign_in: false,
        },
      };
    },
  };
  const upload = toolDefinitions(() => store).find((t) => t.name === "upload_file");

  // `base64 file.png` emits a trailing newline and wraps at 76 columns. Both are
  // what an agent pastes, and both must upload the same bytes.
  const raw = Buffer.from("hello strad, this is a reasonably long artifact body");
  const b64 = raw.toString("base64");
  for (const [label, source] of [
    ["plain", b64],
    ["trailing newline", `${b64}\n`],
    ["wrapped", b64.replace(/(.{20})/g, "$1\n")],
    ["surrounded by spaces", ` ${b64} `],
  ]) {
    const res = await upload.handler({ source, path: "a.txt" });
    assert.notEqual(res.isError, true, `${label} base64 must be accepted`);
    assert.deepEqual(stored.at(-1), raw, `${label} base64 must round-trip`);
  }

  // `Buffer.from(x, "base64")` silently discards anything outside the alphabet,
  // so without a shape check a bare path would store a few bytes and report success.
  for (const source of [
    "/tmp/screenshots/page.png",
    "./shot.png",
    "/tmp/shot",
    "this is not base64!",
  ]) {
    const res = await upload.handler({ source });
    assert.equal(res.isError, true, `${source} must be refused`);
    assert.match(res.content[0].text, /file:\/\//);
  }
  assert.equal(stored.length, 4, "no rejected source reached the store");
});

test("a file:// source cannot reach process state or container internals", async () => {
  const { toolDefinitions } = await import("../build/index.js");
  const store = {
    bucket: () => "b",
    viewerDomain: () => "example.com",
    defaultLinkDays: () => 14,
    put: async () => {
      throw new Error("must not reach the store");
    },
  };
  const upload = toolDefinitions(() => store).find((t) => t.name === "upload_file");

  // This server shares a container with fifteen others, so /proc/self/environ is
  // a one-call exfiltration of every credential in the bundle.
  for (const path of [
    "file:///proc/self/environ",
    "file:///sys/class/net/eth0/address",
    "file:///app/trees/secrets/shared/build/index.js",
    "file:///root/.config/gcloud/credentials.db",
    "file:///etc/passwd",
  ]) {
    const res = await upload.handler({ source: path });
    assert.equal(res.isError, true, `${path} must be refused`);
    assert.match(res.content[0].text, /Refusing to read/);
  }
});
