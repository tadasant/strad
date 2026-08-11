/**
 * The artifact store: a thin, opinionated face over ONE GCS bucket.
 *
 * "Opinionated" is the point. The tools never speak ACLs, signing versions or
 * object metadata — they speak `is_sensitive` and `expires_in_days`, and this
 * module is where those become storage decisions. Everything an agent can reach
 * goes through {@link ArtifactStore}, so a fake implementation is enough to test
 * the whole tool surface.
 */

import { randomBytes } from "node:crypto";
import { Storage, RETRYABLE_ERR_FN_DEFAULT } from "@google-cloud/storage";
import type { File } from "@google-cloud/storage";
import {
  DAY_MS,
  V4_MAX_EXPIRY_SECONDS,
  authenticatedBrowserUrl,
  domainReaderEntity,
  encodeObjectPath,
  signingVersionFor,
  type SigningVersion,
} from "./links.js";
import { MAX_LINK_DAYS, type StoreConfig } from "./config.js";
import { disableHttpKeepAlive, isTransientConnectionError, withRetry } from "./resilience.js";
import { logWarning } from "./logging.js";

/**
 * How an artifact is reached.
 *
 * - `link`       private object, opened with a signed URL. The default, and the
 *                only state with an expiry.
 * - `restricted` private object, opened by a signed-in member of the viewer
 *                domain. `is_sensitive: true` produces this.
 * - `public`     readable far beyond the viewer domain — `allUsers` (anyone) or
 *                `allAuthenticatedUsers` (any Google account) — and forever. This
 *                server never CREATES one; it reports the state so a pre-existing
 *                object is not mistaken for a private one.
 * - `unknown`    the ACL could not be read, so nothing can be said about who can
 *                reach it. No link is issued for one; see `accessOf`.
 */
export type Access = "link" | "restricted" | "public" | "unknown";

export interface Artifact {
  /** Path within the bucket, relative to the configured root (if any). */
  path: string;
  size_bytes: number;
  content_type: string;
  updated_at: string;
  access: Access;
}

export interface Link {
  url: string;
  /** ISO timestamp, or null when the link does not expire (`restricted`). */
  expires_at: string | null;
  /** Which GCS signing process minted it, or null when it carries no signature. */
  signing_version: SigningVersion | null;
  /** True when opening the link requires a Google sign-in. */
  requires_sign_in: boolean;
}

export interface PutOptions {
  /** Destination path. An existing artifact at this path is OVERWRITTEN. */
  path?: string;
  content_type?: string;
  metadata?: Record<string, string>;
  sensitive: boolean;
  /** Link life in days. Ignored when `sensitive` — a restricted link never expires. */
  expires_in_days: number;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
}

export interface ListPage {
  files: Artifact[];
  directories: string[];
}

export interface ArtifactStore {
  put(
    data: Buffer,
    options: PutOptions,
  ): Promise<{ artifact: Artifact; link: Link }>;
  link(path: string, expiresInDays: number): Promise<{ artifact: Artifact; link: Link }>;
  setSensitive(
    path: string,
    sensitive: boolean,
    expiresInDays: number,
  ): Promise<{ artifact: Artifact; link: Link }>;
  list(options?: ListOptions): Promise<ListPage>;
  read(path: string): Promise<{ buffer: Buffer; artifact: Artifact }>;
  remove(path: string): Promise<void>;
  /** The bucket every operation is scoped to. Used in messages, never for auth. */
  bucket(): string;
  /** The Workspace domain a restricted artifact is readable by, if configured. */
  viewerDomain(): string | undefined;
  /**
   * The account a restricted link names, if an operator chose one. A hint about
   * which signed-in account opens the link, never a grant — see `links.ts`.
   */
  viewerAccount(): string | undefined;
  /** Link life, in days, when the caller does not ask for one. */
  defaultLinkDays(): number;
}

/** A failure an agent can act on: the message says what to do next. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

type StorageOptions = ConstructorParameters<typeof Storage>[0];

export interface GcsStoreDeps {
  /** The auth/network boundary. Injected in tests. */
  createStorage?: (options: StorageOptions) => Storage;
}

export class GcsArtifactStore implements ArtifactStore {
  private readonly storage: Storage;
  private readonly config: StoreConfig;

  constructor(config: StoreConfig, deps: GcsStoreDeps = {}) {
    this.config = config;
    disableHttpKeepAlive();

    const options: StorageOptions = {
      // Broaden the SDK's own retry to cover connection-level failures on top of
      // its status-code handling, but keep the count low: the wrapper below is
      // the primary self-heal (it also covers the OAuth exchange, which
      // retryOptions does not govern), and two compounding layers turn a dead
      // endpoint into a multi-minute hang.
      retryOptions: {
        autoRetry: true,
        maxRetries: 2,
        retryableErrorFn: (err) =>
          isTransientConnectionError(err) || RETRYABLE_ERR_FN_DEFAULT(err),
      },
    };
    if (config.projectId) options.projectId = config.projectId;
    if (config.clientEmail && config.privateKey) {
      options.credentials = {
        client_email: config.clientEmail,
        // App Platform env vars carry the PEM with escaped newlines.
        private_key: config.privateKey.replace(/\\n/g, "\n"),
      };
    }

    const createStorage =
      deps.createStorage ?? ((o: StorageOptions) => new Storage(o));
    this.storage = createStorage(options);
  }

  bucket(): string {
    return this.config.bucket;
  }

  viewerDomain(): string | undefined {
    return this.config.viewerDomain;
  }

  viewerAccount(): string | undefined {
    return this.config.viewerAccount;
  }

  defaultLinkDays(): number {
    return this.config.defaultLinkDays;
  }

  async put(
    data: Buffer,
    options: PutOptions,
  ): Promise<{ artifact: Artifact; link: Link }> {
    if (options.sensitive && !this.config.viewerDomain) {
      throw new StoreError(
        "This deployment cannot store a sensitive artifact: no viewer domain is " +
          "configured, so nothing would be able to open it. Ask an operator to set " +
          "the server's SENSITIVE_VIEWER_DOMAIN (e.g. \"tadasant.com\"), or re-upload " +
          "with is_sensitive=false if the artifact is not actually sensitive.",
      );
    }

    const relative = options.path?.trim()
      ? options.path.trim()
      : generatePath(options.content_type);
    const full = this.fullPath(relative);
    this.assertInRoot(full);
    const contentType = options.content_type ?? inferContentType(relative);

    // Retryable as a whole: `save` is a full-object overwrite, so replaying it
    // re-uploads the same bytes rather than appending or duplicating.
    const access = await this.retry("upload", async () => {
      const file = this.file(full);
      await file.save(data, {
        metadata: { contentType, metadata: options.metadata },
        resumable: false,
      });
      return this.normalizeAcl(file, options.sensitive);
    });

    const artifact: Artifact = {
      path: relative,
      size_bytes: data.length,
      content_type: contentType,
      updated_at: new Date().toISOString(),
      access,
    };
    return { artifact, link: await this.linkFor(full, artifact, options.expires_in_days) };
  }

  /**
   * Bring an object's ACL in line with the sensitivity being asked for, and
   * return what it ACTUALLY is afterwards.
   *
   * DO NOT ASSUME A FRESH OBJECT. `save` overwrites an object's BYTES and leaves
   * its ACL alone, so writing over a path that already carried an `allUsers`
   * grant would store a "sensitive" artifact that is world-readable; writing a
   * non-sensitive one over a restricted path would leave the domain grant behind
   * while the response says `link`. And a bucket whose DEFAULT object ACL grants
   * `allUsers` makes even a genuinely new object public. All three end in the
   * response lying about access, which is the one thing this server must not do.
   *
   * So: one ACL read, then only the writes that read implies. A clean new object
   * costs one round trip and no writes; the expensive case is the one that
   * needed the work anyway. And the returned access is derived from what was
   * found and changed, never from what was requested.
   */
  private async normalizeAcl(file: File, sensitive: boolean): Promise<Access> {
    let entities: string[];
    try {
      const [acl] = await file.acl.get();
      entities = (Array.isArray(acl) ? acl : [acl]).map((e) => e.entity ?? "");
    } catch {
      // Cannot see the ACL, so cannot claim anything about it. `linkFor` refuses
      // to issue a link for `unknown` rather than signing an anonymous URL for
      // something that might be sign-in gated.
      return "unknown";
    }

    const broad = ["allUsers", "allAuthenticatedUsers"].filter((e) =>
      entities.includes(e),
    );
    const domains = entities.filter((e) => e.startsWith("domain-"));
    const wanted = sensitive
      ? domainReaderEntity(this.config.viewerDomain ?? "")
      : undefined;

    // Restricting REQUIRES dropping the broad grants — a world-readable object
    // cannot also be sign-in gated, and leaving one would make `restricted` a lie.
    if (sensitive) for (const entity of broad) await removeEntity(file, entity);

    // Every domain grant this deployment did not ask for goes, in both
    // directions. Otherwise an artifact can get stuck reporting `restricted` for
    // a domain no tool here knows how to clear.
    for (const domain of domains) {
      if (domain !== wanted) await removeEntity(file, domain);
    }
    if (sensitive && wanted && !domains.includes(wanted)) {
      await this.grantViewerDomain(file);
    }

    if (sensitive) return "restricted";
    // NOT sensitive and still world-readable. The broad grant is deliberately
    // left alone: it predates this server, and silently de-publishing an object
    // would break a URL someone may already be relying on. Report it truthfully
    // instead — the tool surfaces a warning and `delete_file` is the way out.
    return broad.length > 0 ? "public" : "link";
  }

  async link(
    path: string,
    expiresInDays: number,
  ): Promise<{ artifact: Artifact; link: Link }> {
    const full = this.fullPath(path);
    this.assertInRoot(full);
    const artifact = await this.stat(full, path);
    return { artifact, link: await this.linkFor(full, artifact, expiresInDays) };
  }

  async setSensitive(
    path: string,
    sensitive: boolean,
    expiresInDays: number,
  ): Promise<{ artifact: Artifact; link: Link }> {
    const full = this.fullPath(path);
    this.assertInRoot(full);
    if (sensitive && !this.config.viewerDomain) {
      throw new StoreError(
        "Cannot restrict this artifact: no viewer domain is configured for this " +
          "server, so the grant would have no one to grant to. Ask an operator to " +
          "set SENSITIVE_VIEWER_DOMAIN.",
      );
    }

    // The same normalisation the upload path uses, so "is this artifact
    // sensitive" has exactly one answer and one implementation. Clearing EVERY
    // domain grant rather than only this deployment's matters here: a leftover
    // grant for some other domain would keep the artifact reporting `restricted`
    // with no tool able to clear it.
    const access = await this.retry("set_sensitivity", async () => {
      const file = this.file(full);
      const [exists] = await file.exists();
      if (!exists) throw notFound(path);
      return this.normalizeAcl(file, sensitive);
    });

    const artifact = { ...(await this.stat(full, path)), access };
    return { artifact, link: await this.linkFor(full, artifact, expiresInDays) };
  }

  async list(options: ListOptions = {}): Promise<ListPage> {
    const prefix = options.prefix
      ? this.fullPath(options.prefix)
      : (this.config.rootPath ?? "");
    // Bounded like every other entry point. A listing cannot escape a bucket the
    // way a read can, but an entry point that skips the check reads as a hole and
    // invites the next one to skip it too.
    if (options.prefix) this.assertInRoot(prefix);
    const normalized = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;

    return this.retry("list", async () => {
      const [files, , apiResponse] = await this.storage
        .bucket(this.config.bucket)
        .getFiles({
          prefix: normalized || undefined,
          maxResults: options.limit,
          delimiter: "/",
          autoPaginate: false,
        });

      // Sensitivity is an ACL read PER OBJECT, so a listing deliberately does
      // not report it — one page would become fifty round trips. `refresh_link`
      // answers it for the one object the caller actually cares about.
      const artifacts: Artifact[] = files.map((file) => ({
        path: this.relativePath(file.name),
        size_bytes: Number(file.metadata.size) || 0,
        content_type: file.metadata.contentType || "application/octet-stream",
        updated_at: file.metadata.updated || "",
        access: "link" as const,
      }));

      // GCS returns prefixes with a trailing slash ("screenshots/8379/"). Strip
      // it: a caller passes one of these straight back as `prefix`, and the
      // examples in the tool descriptions have no trailing slash.
      const directories = (
        (apiResponse as { prefixes?: string[] })?.prefixes ?? []
      ).map((p) => this.relativePath(p).replace(/\/$/, ""));

      return { files: artifacts, directories };
    });
  }

  async read(path: string): Promise<{ buffer: Buffer; artifact: Artifact }> {
    const full = this.fullPath(path);
    this.assertInRoot(full);
    const buffer = await this.retry("download", async () => {
      const file = this.file(full);
      const [exists] = await file.exists();
      if (!exists) throw notFound(path);
      const [data] = await file.download();
      return data;
    });
    return { buffer, artifact: await this.stat(full, path) };
  }

  async remove(path: string): Promise<void> {
    const full = this.fullPath(path);
    this.assertInRoot(full);
    await this.retry("delete", async () => {
      const file = this.file(full);
      const [exists] = await file.exists();
      if (!exists) throw notFound(path);
      await file.delete();
    });
  }

  // -- internals ------------------------------------------------------------

  private file(fullPath: string): File {
    return this.storage.bucket(this.config.bucket).file(fullPath);
  }

  private retry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      onRetry: (err, attempt, delayMs) => {
        const message = err instanceof Error ? err.message : String(err);
        logWarning(
          `transient error on ${operation} (attempt ${attempt}), retrying in ${delayMs}ms: ${message}`,
        );
      },
    });
  }

  private async grantViewerDomain(file: File): Promise<void> {
    const domain = this.config.viewerDomain;
    if (!domain) return;
    try {
      await file.acl.add({ entity: domainReaderEntity(domain), role: "READER" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Two very different operator errors reach this catch, and naming the wrong
      // one sends whoever reads it to the wrong console. Google is explicit about
      // the first, so pass its own words through rather than guessing.
      const cause = /could not find domain/i.test(message)
        ? `"${domain}" is not a Google Workspace domain Google can resolve — check ` +
          `this server's SENSITIVE_VIEWER_DOMAIN for a typo.`
        : `The usual cause is uniform bucket-level access being enabled on ` +
          `${this.config.bucket}, which disables per-object ACLs — this server needs it off.`;
      throw new StoreError(
        `Stored the object but could not grant ${domain} read access to it (${message}). ` +
          `The artifact is private, so nothing has leaked, but only the service account ` +
          `can open it. ${cause}`,
      );
    }
  }

  private async stat(fullPath: string, relative: string): Promise<Artifact> {
    return this.retry("stat", async () => {
      const file = this.file(fullPath);
      const [exists] = await file.exists();
      if (!exists) throw notFound(relative);
      const [metadata] = await file.getMetadata();
      return {
        path: relative,
        size_bytes: Number(metadata.size) || 0,
        content_type: metadata.contentType || "application/octet-stream",
        updated_at: metadata.updated || "",
        access: await this.accessOf(file),
      };
    });
  }

  /**
   * Read the object's ACL and say how it can be reached.
   *
   * Order matters: a broad grant beats a domain grant, because `allUsers` makes
   * the domain grant irrelevant and reporting "restricted" for a world-readable
   * object would be the most dangerous thing this server could say.
   *
   * A FAILED ACL READ IS `unknown`, NOT `link`. Answering "link" would be the
   * fail-OPEN version: `linkFor` signs a `link`, so a deployment that switched on
   * uniform bucket-level access — or a credential that lost `storage.objects.get`
   * on ACLs — would turn every restricted artifact into an anonymous signed URL,
   * mintable by a read-only tool, with nothing reporting that the sign-in gate had
   * disappeared.
   */
  private async accessOf(file: File): Promise<Access> {
    let entries: Array<{ entity?: string; role?: string }>;
    try {
      const [acl] = await file.acl.get();
      entries = Array.isArray(acl) ? acl : [acl];
    } catch {
      return "unknown";
    }
    const has = (entity: string): boolean =>
      entries.some((e) => e.entity === entity);
    // `allAuthenticatedUsers` is any Google account anywhere, not this
    // deployment's viewer domain — as good as public for our purposes, and
    // certainly not the "private object" that `link` promises.
    if (has("allUsers") || has("allAuthenticatedUsers")) return "public";
    if (entries.some((e) => (e.entity ?? "").startsWith("domain-"))) {
      return "restricted";
    }
    return "link";
  }

  private async linkFor(
    fullPath: string,
    artifact: Artifact,
    expiresInDays: number,
  ): Promise<Link> {
    if (artifact.access === "restricted") {
      return {
        url: authenticatedBrowserUrl(
          this.config.bucket,
          fullPath,
          this.config.viewerAccount,
        ),
        expires_at: null,
        signing_version: null,
        requires_sign_in: true,
      };
    }
    if (artifact.access === "public") {
      return {
        url: `https://storage.googleapis.com/${this.config.bucket}/${encodeObjectPath(fullPath)}`,
        expires_at: null,
        signing_version: null,
        requires_sign_in: false,
      };
    }
    if (artifact.access === "unknown") {
      throw new StoreError(
        `Refusing to issue a link for ${fullPath}: this server cannot read the ` +
          `object's ACL, so it cannot tell whether the artifact is sensitive, and ` +
          `signing one would hand out an anonymous URL for something that may be ` +
          `sign-in gated. The usual cause is uniform bucket-level access being ` +
          `enabled on ${this.config.bucket} — this server needs it off — or a ` +
          `credential that has lost permission to read object ACLs.`,
      );
    }
    return this.sign(fullPath, expiresInDays);
  }

  private async sign(fullPath: string, days: number): Promise<Link> {
    const clamped = Math.min(Math.max(days, 1 / 24), MAX_LINK_DAYS);
    const version = signingVersionFor(clamped);
    // V4's seven-day ceiling is enforced on `expiry - now` computed INSIDE the
    // SDK, a few ms after ours. Back off a minute so a boundary request for
    // exactly seven days cannot round its way over the line.
    const requested = Date.now() + clamped * DAY_MS;
    const ceiling =
      version === "v4"
        ? Date.now() + V4_MAX_EXPIRY_SECONDS * 1000 - 60_000
        : Number.POSITIVE_INFINITY;
    const expires = Math.min(requested, ceiling);

    try {
      const [url] = await this.file(fullPath).getSignedUrl({
        version,
        action: "read",
        expires,
      });
      return {
        url,
        expires_at: new Date(expires).toISOString(),
        signing_version: version,
        requires_sign_in: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (version === "v2") {
        throw new StoreError(
          `Could not mint a ${clamped}-day link (${message}). Links longer than 7 days ` +
            `use GCS's V2 signing process; if it is unavailable, ask for ` +
            `expires_in_days: 7 or less, which uses V4.`,
        );
      }
      throw new StoreError(`Could not mint a link for ${fullPath}: ${message}`);
    }
  }

  private fullPath(relativePath: string): string {
    const clean = relativePath.startsWith("/")
      ? relativePath.slice(1)
      : relativePath;
    const root = this.config.rootPath;
    if (!root) return clean;
    return `${root.endsWith("/") ? root : `${root}/`}${clean}`;
  }

  private relativePath(fullPath: string): string {
    const root = this.config.rootPath;
    if (!root) return fullPath;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
  }

  private assertInRoot(fullPath: string): void {
    // A `..` SEGMENT is traversal. A `..` inside a name is not: "report..txt" and
    // "v1..2/shot.png" are legal object names and legal filenames, and refusing
    // them was refusing real artifacts.
    if (fullPath.split("/").includes("..")) {
      throw new StoreError("Path traversal is not allowed.");
    }
    const root = this.config.rootPath;
    if (!root) return;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!fullPath.startsWith(prefix) && fullPath !== root) {
      throw new StoreError(
        `Access denied: ${fullPath} is outside this server's root (${root}).`,
      );
    }
  }
}

/**
 * Drop an ACL entry, treating "it was not there" as success and NOTHING ELSE as
 * success.
 *
 * The distinction is the whole point. A 404 means the grant we wanted gone is
 * already gone. A 403 means it is still there and we could not remove it — and a
 * caller that swallows that goes on to report a world-readable object as
 * `restricted`, which is precisely the lie this server must not tell.
 */
async function removeEntity(file: File, entity: string): Promise<void> {
  if (!entity || entity === "domain-") return;
  try {
    await file.acl.delete({ entity });
  } catch (err) {
    if ((err as { code?: number }).code === 404) return;
    throw new StoreError(
      `Could not remove the "${entity}" grant from ${file.name}: ` +
        `${err instanceof Error ? err.message : String(err)}. The object may still ` +
        `be readable by that entity, so no link has been issued for it.`,
    );
  }
}

function notFound(path: string): StoreError {
  return new StoreError(
    `No artifact at "${path}". Use list_files to find the exact path — ` +
      `it is case-sensitive and includes any directory prefix.`,
  );
}

/**
 * The path an upload lands at when the caller does not choose one.
 *
 * Date-partitioned so a bucket with thousands of screenshots stays browsable,
 * and suffixed with randomness so two uploads in the same millisecond cannot
 * overwrite one another.
 */
export function generatePath(
  contentType: string | undefined,
  now: Date = new Date(),
  nonce: string = randomToken(),
): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `uploads/${yyyy}/${mm}/${dd}/${hhmmss}-${nonce}${extensionFor(contentType)}`;
}

function randomToken(): string {
  return randomBytes(4).toString("hex");
}

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "video/webm": ".webm",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/markdown": ".md",
  "application/json": ".json",
};

function extensionFor(contentType: string | undefined): string {
  return contentType ? (EXTENSIONS[contentType] ?? "") : "";
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  webm: "video/webm",
  mp4: "video/mp4",
  pdf: "application/pdf",
  txt: "text/plain",
  html: "text/html",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  css: "text/css",
  js: "application/javascript",
};

export function inferContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return CONTENT_TYPES[ext ?? ""] ?? "application/octet-stream";
}
