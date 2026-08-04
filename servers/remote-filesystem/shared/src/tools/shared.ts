/**
 * The pieces every tool file needs: the tool shape, the JSON envelope, and the
 * two parameter descriptions that must read identically wherever they appear.
 */

import type { ArtifactStore, Artifact, Link } from "../store.js";
import { DEFAULT_LINK_DAYS, MAX_LINK_DAYS } from "../config.js";

export interface ToolResult {
  /** The SDK's `ServerResult` is open-ended; the index signature is what makes
   * this assignable to it without a cast at the registration site. */
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: Record<string, boolean>;
  handler: (args: unknown) => Promise<ToolResult>;
}

export type StoreFactory = () => ArtifactStore;

/**
 * The `is_sensitive` copy. It lives here because it appears in `upload_file` and
 * in `set_sensitivity`, and an agent that reads two different versions of this
 * guidance will follow the more permissive one.
 *
 * The steer is deliberate and one-directional: sensitive costs the reader a
 * login, so the default is the right answer almost every time.
 */
export const SENSITIVE_DESCRIPTION =
  "Whether this artifact contains genuinely sensitive information. Default: false. " +
  "LEAVE THIS FALSE unless you would be uncomfortable if the link leaked — true makes " +
  "the reader sign in to a Google account on the viewer domain before they can see " +
  "anything, which is real friction, and on a phone it is worse. " +
  "Use true for: security findings and vulnerability details, credentials or keys " +
  "visible on screen, net worth / account balances / financial statements, medical or " +
  "legal documents, anything covered by an NDA. " +
  "Use false (the default) for: UI screenshots, test output, logs, charts, diagrams, " +
  "PR evidence, error messages, and every other kind of routine artifact — even ones " +
  "from a private repo or an internal admin page. A non-sensitive artifact gets an " +
  "unguessable, time-limited link that opens instantly with no account.";

export const EXPIRES_DESCRIPTION =
  `How many days the returned link stays valid (1-${MAX_LINK_DAYS}). Default: ${DEFAULT_LINK_DAYS}. ` +
  "Links of 7 days or less are signed with GCS V4; longer ones use V2, which is the " +
  "only signing process without a 7-day ceiling. Ignored when is_sensitive is true — " +
  "a sensitive artifact's link does not expire, because access is decided by who is " +
  "signed in rather than by time. If a link does expire, call refresh_link to mint a " +
  "new one; the artifact itself is never deleted by expiry.";

export const PATH_DESCRIPTION =
  'Path of the artifact within the bucket, e.g. "uploads/2026/08/02/081500-a1b2c3.png" ' +
  'or "screenshots/pr-123/before.png". Case-sensitive, no leading slash. ' +
  "Get it from the `path` field of an upload_file result, or from list_files.";

/** The one response shape every tool that returns an artifact uses. */
export function artifactPayload(
  store: ArtifactStore,
  artifact: Artifact,
  link: Link,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    path: artifact.path,
    url: link.url,
    access: artifact.access,
    requires_sign_in: link.requires_sign_in,
    expires_at: link.expires_at,
    signing_version: link.signing_version,
    size_bytes: artifact.size_bytes,
    content_type: artifact.content_type,
    bucket: store.bucket(),
    ...(artifact.access === "restricted"
      ? { viewer_domain: store.viewerDomain() }
      : {}),
    ...extra,
  };
}

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Read a tool's `source` parameter into bytes.
 *
 * Two forms, because agents produce both: a `file://` URI when the artifact is
 * already on disk (a Playwright screenshot, a generated report), and raw base64
 * when it was produced in memory.
 */
export async function readSource(source: string): Promise<Buffer> {
  if (source.startsWith("file://")) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = fileURLToPath(source);

    // This server shares a container with fifteen others, so its process
    // environment holds their credentials — a Slack token, GCS private keys, the
    // secrets resolver key. `upload_file` takes an arbitrary local path and
    // returns a public link to whatever it read, which makes
    // "file:///proc/self/environ" a one-call credential exfiltration. Refuse the
    // directories that hold process state and the container's own code; an
    // artifact never lives there.
    if (/^\/(proc|sys|dev|app|root|etc)(\/|$)/.test(path)) {
      throw new Error(
        `Refusing to read ${path}: this server will not upload process state, ` +
          `container internals or system configuration. Artifacts come from a ` +
          `working directory (e.g. /tmp), not from /proc, /sys, /dev, /app, /root or /etc.`,
      );
    }

    try {
      return await readFile(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not read ${source}: ${message}. Check the file exists in THIS ` +
          `server's filesystem — a file:// path only works for files the server ` +
          `itself can see. Pass base64 contents instead if it cannot.`,
      );
    }
  }
  // `Buffer.from(x, "base64")` never throws — it discards anything outside the
  // alphabet and returns whatever is left. So a bare filesystem path, which is
  // the most likely mistake here, would upload a few bytes of garbage and report
  // success. Check the shape first and say what was probably meant.
  //
  // Whitespace is stripped BEFORE the check, not allowed within it: `base64
  // file.png` emits a trailing newline and wraps at 76 columns, and both are
  // exactly what an agent pastes.
  const compact = source.replace(/\s+/g, "");
  const wellFormed =
    /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0;
  if (!wellFormed || source.startsWith("/") || source.startsWith(".")) {
    throw new Error(
      "`source` is neither a file:// URI nor base64. It looks like a plain path or " +
        'raw text — prefix a local path with file:// (e.g. "file:///tmp/shot.png"), ' +
        "or base64-encode the contents first.",
    );
  }
  // Well-formed and non-empty by the check above, so the decode cannot come back
  // empty and there is nothing further to guard.
  return Buffer.from(compact, "base64");
}
