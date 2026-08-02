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

test("a bare filesystem path is refused rather than uploaded as garbage", async () => {
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

  // `Buffer.from(x, "base64")` silently discards anything outside the alphabet,
  // so without a shape check this would store four bytes and report success.
  const res = await upload.handler({ source: "/tmp/screenshots/page.png" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /file:\/\//);

  const text = await upload.handler({ source: "this is not base64!" });
  assert.equal(text.isError, true);

  // Well-formed base64 that carries nothing is a separate, quieter mistake.
  const empty = await upload.handler({ source: "==" });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /zero bytes/);
});
