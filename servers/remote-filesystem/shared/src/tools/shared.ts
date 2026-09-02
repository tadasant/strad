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

/**
 * How to hand a signed URL onward. It lives here because upload_file,
 * get_upload_url and refresh_link all mint the same kind of URL, and the mistake
 * it prevents is made AFTER the tool returns — in whatever the agent writes next.
 *
 * From a real incident: a working URL was published to a human bolded in markdown
 * with everything after the `?` dropped. The human got a 403, and that 403 was
 * escalated as "the bucket is not public, every artifact tonight is unreachable"
 * — a false infrastructure incident caused by a formatting bug, with someone sent
 * to look at a bucket ACL. The last clause is the load-bearing one.
 *
 * SCOPED TO `access: "link"`, deliberately. A restricted artifact's URL carries no
 * signature at all — its query string is the `?authuser=` account selector, which
 * `signInHint()` tells the reader to REPLACE with their own address. Unscoped,
 * this text would forbid the one fix that hint prescribes, and would send someone
 * debugging a restricted 403 hunting for a truncation bug.
 *
 * The codes are observed against a production bucket, not inferred: `AccessDenied`,
 * `SignatureDoesNotMatch` and `MissingSecurityHeader` were each reproduced. The
 * framing is the CODE rather than the status because the statuses disagree — a
 * partly-kept query string is a 400, not a 403.
 *
 * Names no bucket. The bucket differs per deployment (production's happens to end
 * in `-public`, staging's does not), and a description asserting one deployment's
 * name is wrong everywhere else.
 */
export const LINK_HANDLING_DESCRIPTION = `**For a signed link (\`access: "link"\`), the query string IS the credential — pass the
URL through verbatim.** The signature after \`?\` is most of the URL's length, and dropping
it is loud for the reader and silent for you: the link still looks like a link. Do not
truncate at the \`?\`, do not wrap it across lines, and do not put markdown emphasis on a
bare URL (\`**<url>**\` glues the trailing asterisks onto the signature). A \`path\` cannot be
turned back into a URL — only a tool can mint the signature. Prefer \`[text](url)\`, which
nothing can attach itself to the end of; Slack renders that literally, so there post the
bare URL or \`<url|text>\`.

**Check it before you publish it:** \`curl -sS -o /dev/null -w '%{http_code}' "<url>"\` must
print \`200\`.

**Read the error code, not the status** — they disagree. \`AccessDenied\`: the request
carried no signature (dropped, or cut at the \`?\`). \`SignatureDoesNotMatch\`: characters
were added or removed. \`MissingSecurityHeader\`: the query string was only partly kept.
\`ExpiredToken\`: the link aged out, and refresh_link mints a fresh one. **None of them
means the bucket is misconfigured** — these objects are private by design, whatever the
bucket or the mount is called. A \`restricted\` artifact fails differently and carries no
signature; \`sign_in_hint\` diagnoses that one.`;

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
      ? restrictedFields(store)
      : {}),
    ...extra,
  };
}

function restrictedFields(store: ArtifactStore): Record<string, unknown> {
  const viewerDomain = store.viewerDomain();
  const viewerAccount = store.viewerAccount();
  return {
    viewer_domain: viewerDomain,
    ...(viewerAccount ? { viewer_account: viewerAccount } : {}),
    sign_in_hint: signInHint(viewerDomain, viewerAccount),
  };
}

/**
 * What to tell the human when a restricted link does not open.
 *
 * It rides on the response because the failure is invisible from here: the ACL
 * is correct, the URL is correct, and the reader still gets a 403 because their
 * browser authenticated the wrong one of their signed-in Google accounts. An
 * agent that has this text can answer "why is it broken" in the same breath as
 * it hands over the link, instead of the human filing a bug against the grant.
 */
export function signInHint(
  viewerDomain: string | undefined,
  viewerAccount: string | undefined,
): string {
  // `access` comes from the object's ACL, not from this deployment's config, so a
  // pre-existing object can read `restricted` on a server with no viewer domain
  // set. Never splice the domain into a placeholder — with none configured that
  // produced literal text telling the reader to paste "the viewer domain".
  const audience = viewerDomain
    ? `signed-in ${viewerDomain} account`
    : `signed-in account in the domain granted on the object`;
  if (viewerAccount) {
    return (
      `Opens only for a ${audience}. The link already names ${viewerAccount} via ` +
      `?authuser=, so it picks that account even when the reader is signed in to ` +
      `several. A 403 then usually means that browser profile is not signed in to ` +
      `${viewerAccount} at all — a DIFFERENT member of the domain opens it by ` +
      `replacing the ?authuser= value in the URL with their own address. The other ` +
      `cause is the object's domain grant having been dropped, which refresh_link ` +
      `reports as access: "link".`
    );
  }
  return (
    `Opens only for a ${audience}. storage.cloud.google.com uses the browser's ` +
    `DEFAULT Google account, so a reader signed in to several accounts gets a 403 ` +
    `even when one of them would work — the grant is fine, Google just asked the ` +
    `wrong account. Tell them to append ?authuser=<their-address-in-that-domain> to ` +
    `the URL. To stop having to say that, an operator can set this server's ` +
    `slug-prefixed _SENSITIVE_VIEWER_ACCOUNT and the link will carry it.`
  );
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

    // This server shares a container with nineteen others, so its process
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
