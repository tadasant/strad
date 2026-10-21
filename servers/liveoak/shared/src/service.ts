/**
 * Everything the tools do, in one place: log in (as the remembered device),
 * list and fetch statements, enrol a device, and serve a statement's link.
 *
 * ONE LOGIN AT A TIME. Every Cognito exchange runs through `serial`, so an
 * enrolment, a list and a download arriving together cannot race one another
 * into two SMS codes or two half-confirmed devices.
 *
 * A LOGIN IS REUSED FOR A FEW MINUTES, not for its whole life. The portal logs
 * a browser out after 59 idle seconds; that is a UI timer, and the Cognito
 * access token behind it is good for longer. A workflow that lists, fetches
 * and downloads in one breath makes one login rather than three, and nothing
 * here holds a token past {@link SESSION_REUSE_MS}.
 *
 * NO DEVICE, NO LOGIN. Every login with no remembered device is answered with
 * an SMS to the account's phone. So a read with no device enrolled is refused
 * BEFORE LiveOak is contacted, and the only tool that will start a login
 * without one is `enrol_device` — the one a human calls on purpose.
 */
import { createHash } from "node:crypto";
import { ApiError, ApitureClient, type ApitureOptions, type RawDocument } from "./apiture.js";
import {
  CognitoLogin,
  LIVEOAK_COGNITO,
  LoginError,
  type CognitoOptions,
  type MfaChallenge,
  type Session,
} from "./cognito.js";
import type { LiveOakConfig } from "./config.js";
import { DeviceStore, type DeviceState } from "./device-store.js";
import {
  deriveDownloadKey,
  mintDownloadToken,
  NonceLedger,
  verifyDownloadToken,
} from "./download-link.js";
import { GcsError, type BlobStore } from "./gcs.js";
import { SealError } from "./crypto.js";
import { logInfo, logWarning, redact } from "./logging.js";
import {
  byEndDateDesc,
  inRange,
  InputError,
  MAX_RANGE_MONTHS,
  normalizeStatement,
  resolveRange,
  statementFilename,
  type Statement,
} from "./statements.js";

/** How long a login's token is reused before the next call logs in again. */
export const SESSION_REUSE_MS = 10 * 60_000;
/** A token this close to its expiry is not reused. */
const EXPIRY_MARGIN_MS = 60_000;
/**
 * How long an MFA challenge is kept waiting for its code. Cognito decides
 * when the challenge really expires (three minutes unless the pool says
 * otherwise, fifteen at most); this only stops a dead one lingering.
 */
export const PENDING_TTL_MS = 15 * 60_000;
/** Cognito's default challenge lifetime, which is what a caller is told to beat. */
export const COGNITO_DEFAULT_CHALLENGE_SECONDS = 180;
/** Fetched statements held for their links, at most. */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** A refusal whose message is the whole answer, and safe to show. */
export class LiveOakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveOakError";
  }
}

export type DownloadOutcome =
  | {
      ok: true;
      filename: string;
      contentType: string;
      contentLength?: number;
      body: ReadableStream<Uint8Array>;
    }
  | { ok: false; status: number; error: string };

export interface ServiceOptions {
  config: LiveOakConfig;
  blobs: BlobStore;
  /** Default: secure.liveoak.bank's pool and client. Tests point it at a fake. */
  cognito?: CognitoOptions;
  apiture?: ApitureOptions;
  now?: () => number;
}

export interface StatusResult {
  configured: true;
  device_enrolled: boolean;
  enrolled_at?: string;
  device_state_unreadable?: string;
  /** Storage could not be read: the problem, in words safe to show. */
  device_store_error?: string;
  /**
   * A device LiveOak confirmed whose keys could not be stored. It is held in
   * this container's memory until enrol_device stores it.
   */
  device_unsaved?: true;
  enrolment_pending: boolean;
  download_links: boolean;
  download_links_unavailable?: string;
}

export interface StatementDetail extends Statement {
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  download_url?: string;
  expires_at?: string;
  download_unavailable?: string;
}

export type EnrolResult =
  | { status: "already_enrolled"; enrolled_at: string; message: string }
  | {
      status: "code_sent";
      delivery_medium?: string;
      destination?: string;
      expires_in_seconds: number;
      message: string;
    }
  | { status: "enrolled"; enrolled_at: string; message: string };

/** The refusal a write could not land, with what to do in each case. */
function unsavedMessage(cause: string): string {
  return (
    `LiveOak confirmed this server as a remembered device, but its keys could not ` +
    `be stored: ${cause} The keys are held in this container's memory, and reads ` +
    `use them meanwhile. Fix the storage problem, then call enrol_device WITHOUT ` +
    `force to store them: no new code is sent. If this container restarts first ` +
    `they are lost, and enrol_device with force: true enrols again (one new code).`
  );
}

interface Cached {
  statementId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  expiresAtMs: number;
}

export class LiveOakService {
  private readonly login: CognitoLogin;
  private readonly api: ApitureClient;
  private readonly devices: DeviceStore;
  private readonly now: () => number;
  private readonly ledger = new NonceLedger();
  private readonly cache = new Map<string, Cached>();
  private chain: Promise<unknown> = Promise.resolve();
  private session: { value: Session; at: number } | undefined;
  private pending: { challenge: MfaChallenge; at: number } | undefined;
  /** A confirmed device whose save failed. See {@link unsavedMessage}. */
  private unsaved: DeviceState | undefined;

  constructor(private readonly options: ServiceOptions) {
    this.login = new CognitoLogin(options.cognito ?? LIVEOAK_COGNITO);
    this.api = new ApitureClient(options.apiture);
    this.devices = new DeviceStore(options.blobs, options.config.encryptionKey, options.config.prefix);
    this.now = options.now ?? Date.now;
  }

  // --- tools ---------------------------------------------------------------

  async status(): Promise<StatusResult> {
    let device: DeviceState | null = null;
    let unreadable: string | undefined;
    let storeError: string | undefined;
    try {
      device = await this.devices.load();
    } catch (err) {
      // A changed key or an altered object, or a store this server cannot
      // reach. Reported, not thrown: status is what an operator reads to find
      // out. enrol_device {force:true} is the way back from the first; the
      // second needs the GCS settings fixed.
      if (err instanceof SealError) unreadable = err.message;
      else if (err instanceof GcsError) storeError = err.message;
      else throw err;
    }
    const { downloadLink, downloadUnavailable } = this.options.config;
    return {
      configured: true,
      device_enrolled: device !== null,
      ...(device ? { enrolled_at: device.enrolledAt } : {}),
      ...(unreadable ? { device_state_unreadable: unreadable } : {}),
      ...(storeError ? { device_store_error: storeError } : {}),
      ...(this.unsaved ? { device_unsaved: true as const } : {}),
      enrolment_pending: this.livePending() !== undefined,
      download_links: downloadLink !== undefined,
      ...(downloadUnavailable ? { download_links_unavailable: downloadUnavailable } : {}),
    };
  }

  async listStatements(from?: string, to?: string): Promise<{
    from: string;
    to: string;
    count: number;
    statements: Statement[];
  }> {
    const range = resolveRange(from, to, new Date(this.now()));
    const raw = await this.withToken((token) => this.api.listStatements(token, range.startOn, range.period));
    const seen = new Set<string>();
    const statements: Statement[] = [];
    for (const item of raw) {
      const s = normalizeStatement(item);
      if (!s || seen.has(s.statement_id) || !inRange(s, range)) continue;
      seen.add(s.statement_id);
      statements.push(s);
    }
    statements.sort(byEndDateDesc);
    return { from: range.from, to: range.to, count: statements.length, statements };
  }

  async getStatement(statementId: string): Promise<StatementDetail> {
    const { statement, content } = await this.withToken(async (token) => {
      const doc = await this.findDocument(token, statementId);
      return {
        statement: normalizeStatement(doc) ?? { statement_id: statementId },
        content: await this.api.fetchContent(token, doc),
      };
    });
    const contentType = checkStatementBytes(content.bytes, content.contentType);
    const filename = statementFilename(statement, contentType);
    const detail: StatementDetail = {
      ...statement,
      filename,
      content_type: contentType,
      size_bytes: content.bytes.length,
      sha256: createHash("sha256").update(content.bytes).digest("hex"),
    };

    const link = this.options.config.downloadLink;
    if (!link) {
      detail.download_unavailable = this.options.config.downloadUnavailable;
      return detail;
    }
    const minted = mintDownloadToken(this.downloadKey()!, statementId, this.now());
    this.remember(minted.nonce, {
      statementId,
      filename,
      contentType,
      bytes: content.bytes,
      expiresAtMs: minted.expiresAtMs,
    });
    detail.download_url = `${link.publicBaseUrl}/mcp-download/${encodeURIComponent(link.publicSlug)}/${minted.token}`;
    detail.expires_at = minted.expiresAt;
    return detail;
  }

  async enrol(force: boolean): Promise<EnrolResult> {
    return this.serial(async () => {
      const { username, password } = this.options.config;
      this.session = undefined;
      this.pending = undefined;
      // A device LiveOak already confirmed, whose save failed: store it now
      // rather than texting a code for a new one. Force discards it.
      const unsaved = this.unsaved;
      this.unsaved = undefined;
      if (unsaved && !force) return this.persistEnrolment(unsaved, "stored the device confirmed earlier");
      // STORAGE FIRST. Every login below may text a code, and a code whose
      // device cannot then be stored is a text to a person for nothing.
      await this.preflight();
      // FORCE DOES NOT READ, AND DOES NOT DELETE. Not reading is what lets it
      // recover from a changed LIVEOAK_STATE_ENCRYPTION_KEY, whose stored
      // state no longer opens. Not deleting means a forced enrolment that is
      // never confirmed leaves the working device in place:
      // `persistEnrolment` overwrites it only once a new one exists.
      const device = force ? null : await this.devices.load();
      if (force) logInfo("enrol_device: force — logging in without the stored device");
      const outcome = await this.login.authenticate(username, password, device);
      if (outcome.kind === "mfa") return this.hold(outcome.challenge);

      const session = outcome.session;
      this.session = { value: session, at: this.now() };
      if (session.device && session.device.deviceKey === device?.deviceKey) {
        return {
          status: "already_enrolled",
          enrolled_at: device.enrolledAt,
          message:
            "The enrolled device still logs in without a code. Nothing was changed. " +
            "Pass force: true to discard it and enrol again.",
        };
      }
      return this.persistEnrolment(session.device);
    });
  }

  async confirm(code: string): Promise<EnrolResult> {
    if (!/^\d{4,10}$/.test(code)) {
      throw new InputError("`code` is the numeric code LiveOak sent, e.g. \"123456\".");
    }
    return this.serial(async () => {
      const pending = this.livePending();
      if (!pending) {
        throw new LiveOakError(
          "No enrolment is waiting for a code. Call enrol_device first. A pending " +
            "enrolment lives in this container's memory, so a deploy or restart " +
            "between the two calls drops it — call enrol_device again.",
        );
      }
      let session: Session;
      try {
        session = await pending.respond(code);
      } catch (err) {
        // A wrong code can be retried against the same challenge; anything
        // else means the challenge is spent.
        if (!(err instanceof LoginError && err.code === "CodeMismatchException")) this.pending = undefined;
        throw err;
      }
      this.pending = undefined;
      this.session = { value: session, at: this.now() };
      return this.persistEnrolment(session.device);
    });
  }

  /** The bundle host's `/liveoak/download/:token`. */
  async handleDownload(token: string): Promise<DownloadOutcome> {
    const key = this.downloadKey();
    if (!key) return { ok: false, status: 404, error: "downloads_not_configured" };
    const verified = verifyDownloadToken(key, token, this.now());
    if (!verified.ok) return verified;
    const claim = this.ledger.claim(verified.nonce, verified.expiresAtMs, this.now());
    if (claim === "spent") return { ok: false, status: 410, error: "already_used" };
    if (claim === "full") return { ok: false, status: 503, error: "busy" };

    try {
      const cached = this.cache.get(verified.nonce);
      this.cache.delete(verified.nonce);
      let file: Omit<Cached, "expiresAtMs">;
      if (cached && cached.statementId === verified.statementId) {
        file = cached;
      } else {
        // Another instance minted it, or this one restarted: fetch it again.
        const fetched = await this.withToken(async (t) => {
          const doc = await this.findDocument(t, verified.statementId);
          return { doc, content: await this.api.fetchContent(t, doc) };
        });
        const contentType = checkStatementBytes(fetched.content.bytes, fetched.content.contentType);
        file = {
          statementId: verified.statementId,
          contentType,
          bytes: fetched.content.bytes,
          filename: statementFilename(
            normalizeStatement(fetched.doc) ?? { statement_id: verified.statementId },
            contentType,
          ),
        };
      }
      return {
        ok: true,
        filename: file.filename,
        contentType: file.contentType,
        contentLength: file.bytes.length,
        body: new Response(new Uint8Array(file.bytes)).body!,
      };
    } catch (err) {
      this.ledger.release(verified.nonce);
      // The error's NAME only: its message can quote a statement id or an
      // excerpt of the bank's response, and this line is not a place for either.
      logWarning(`download failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return { ok: false, status: 502, error: "statement_unavailable" };
    }
  }

  // --- internals -------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private livePending(): MfaChallenge | undefined {
    if (this.pending && this.now() - this.pending.at > PENDING_TTL_MS) this.pending = undefined;
    return this.pending?.challenge;
  }

  private hold(challenge: MfaChallenge): EnrolResult {
    this.pending = { challenge, at: this.now() };
    const where = challenge.destination ? ` to ${challenge.destination}` : "";
    const how =
      challenge.type === "SOFTWARE_TOKEN_MFA"
        ? "Read the current code from the account's authenticator app"
        : `LiveOak sent a code${where}${challenge.medium ? ` by ${challenge.medium}` : ""}`;
    logInfo(`enrolment: MFA challenge ${challenge.type}${where}`);
    return {
      status: "code_sent",
      ...(challenge.medium ? { delivery_medium: challenge.medium } : {}),
      ...(challenge.destination ? { destination: challenge.destination } : {}),
      expires_in_seconds: COGNITO_DEFAULT_CHALLENGE_SECONDS,
      message:
        `${how}. Ask the account holder for it and call confirm_device with it ` +
        `within about ${COGNITO_DEFAULT_CHALLENGE_SECONDS / 60} minutes (Cognito's default; ` +
        `LiveOak's pool decides). Calling enrol_device again sends a new code.`,
    };
  }

  /** The store takes a write and a delete, or enrolment stops here, before any login. */
  private async preflight(): Promise<void> {
    try {
      await this.devices.probe();
    } catch (err) {
      if (!(err instanceof GcsError)) throw err;
      throw new LiveOakError(
        `No code was sent: this server cannot write to its device storage, so a ` +
          `device enrolled now could not be kept. ${err.message} Fix that, then ` +
          `call enrol_device again.`,
      );
    }
  }

  private async persistEnrolment(device: DeviceState | null, how?: string): Promise<EnrolResult> {
    if (!device) {
      throw new LiveOakError(
        "The login succeeded, but LiveOak's Cognito pool issued no device to " +
          "remember, so every later login would ask for a code again. This " +
          "server cannot run unattended against this account; see " +
          "docs/servers/liveoak (Limitations).",
      );
    }
    try {
      await this.devices.save(device);
    } catch (err) {
      // Cognito has ALREADY confirmed and remembered this device. Keep it, so
      // fixing the store does not cost the account holder another code.
      this.unsaved = device;
      logWarning(`enrolment: device confirmed but not stored (${err instanceof Error ? err.name : "unknown error"})`);
      throw new LiveOakError(unsavedMessage(err instanceof GcsError ? err.message : "the write failed."));
    }
    logInfo("enrolment: device remembered and sealed to GCS");
    return {
      status: "enrolled",
      enrolled_at: device.enrolledAt,
      message:
        `${how ? `No code was sent: ${how}. ` : ""}` +
        "This server is now a remembered device on the LiveOak account. " +
        "list_statements and get_statement log in without a code from here on.",
    };
  }

  /**
   * Run `fn` with an access token, logging in first if none is held. A 401 or
   * 403 from the API drops the held token and retries once with a fresh login.
   */
  private async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const first = await this.token();
    try {
      return await fn(first);
    } catch (err) {
      // Only a refusal of a request that CARRIED the token says anything about
      // the token. A 403 from a pre-signed document host was sent none, and a
      // fresh login for it is one more chance of an SMS for nothing.
      if (err instanceof ApiError && err.tokenRefused) {
        await this.serial(async () => {
          if (this.session?.value.accessToken === first) this.session = undefined;
        });
        return fn(await this.token());
      }
      throw err;
    }
  }

  private token(): Promise<string> {
    return this.serial(async () => {
      const held = this.session;
      const now = this.now();
      if (held && now - held.at < SESSION_REUSE_MS && held.value.expiresAt - now > EXPIRY_MARGIN_MS) {
        return held.value.accessToken;
      }
      this.session = undefined;
      // A challenge is already waiting for a human's code. Logging in again
      // would text a NEW code and void the one they are about to type.
      if (this.livePending()) {
        throw new LiveOakError(
          "An enrolment is waiting for its MFA code, so this server will not log in " +
            "again (that would send a new code and void the pending one). Call " +
            "confirm_device with the code LiveOak sent, or wait for the challenge to " +
            "expire and call enrol_device.",
        );
      }
      const device = this.unsaved ?? (await this.devices.load());
      if (!device) {
        throw new LiveOakError(
          "No device is enrolled, and a login without one makes LiveOak text a " +
            "code to the account holder every time, so this server will not try. " +
            "Call enrol_device, then confirm_device with the code LiveOak sends.",
        );
      }
      const { username, password } = this.options.config;
      const outcome = await this.login.authenticate(username, password, device);
      if (outcome.kind === "mfa") {
        // The device was not honoured and Cognito has ALREADY sent a code.
        // Hold the challenge, so a human can finish it with confirm_device
        // rather than being texted a second code by enrol_device.
        this.hold(outcome.challenge);
        throw new LiveOakError(
          "LiveOak no longer accepts the enrolled device and asked for an MFA code " +
            `(it has already been sent${outcome.challenge.destination ? ` to ${outcome.challenge.destination}` : ""}). ` +
            "Ask the account holder for it and call confirm_device within about " +
            "3 minutes, or call enrol_device later for a fresh one.",
        );
      }
      const session = outcome.session;
      if (!session.device) {
        this.unsaved = undefined;
        await this.devices.clear();
        logWarning("login: Cognito dropped the enrolled device; the stored state was cleared");
      } else if (session.device.deviceKey !== device.deviceKey) {
        this.unsaved = undefined;
        await this.devices.save(session.device);
      }
      this.session = { value: session, at: now };
      return session.accessToken;
    });
  }

  /**
   * One document by id. The API's own `GET /documents/documents/{id}` first;
   * if LiveOak's deployment does not serve it (the portal never calls it),
   * the statement list over the longest range, which the portal does call.
   */
  private async findDocument(token: string, id: string): Promise<RawDocument> {
    try {
      const doc = await this.api.getDocument(token, id);
      if (doc && String(doc._id ?? id) === id) return doc;
    } catch (err) {
      if (!(err instanceof ApiError) || ![403, 404, 405, 501].includes(err.status)) throw err;
    }
    const now = new Date(this.now());
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MAX_RANGE_MONTHS - 1), 1))
      .toISOString()
      .slice(0, 10);
    const range = resolveRange(from, undefined, now);
    const all = await this.api.listStatements(token, range.startOn, range.period);
    const found = all.find((d) => String(d._id) === id);
    if (!found) {
      throw new LiveOakError(
        `No statement has statement_id "${redact(id)}". Take one from list_statements.`,
      );
    }
    return found;
  }

  private downloadKey(): Buffer | undefined {
    const link = this.options.config.downloadLink;
    return link ? deriveDownloadKey(link.internalToken, link.publicSlug, this.options.config.username) : undefined;
  }

  private remember(nonce: string, entry: Cached): void {
    const now = this.now();
    for (const [n, e] of this.cache) if (e.expiresAtMs <= now) this.cache.delete(n);
    this.cache.set(nonce, entry);
    let total = 0;
    for (const e of this.cache.values()) total += e.bytes.length;
    for (const [n, e] of this.cache) {
      if (total <= CACHE_MAX_BYTES) break;
      this.cache.delete(n);
      total -= e.bytes.length;
    }
  }
}

/**
 * A statement is a PDF. What else comes back is a login page or an error page
 * served with a 200, and handing that over as "the statement" is the failure
 * worth refusing loudly. Returns the content type to serve.
 */
function checkStatementBytes(bytes: Buffer, declared: string): string {
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes.length === 0) throw new LiveOakError("LiveOak returned an empty statement.");
  const head = bytes.subarray(0, 64).toString("latin1");
  if (/json/i.test(declared) || /^\s*[[{]/.test(head)) {
    throw new LiveOakError(
      "LiveOak returned a JSON document where the statement should be, not a PDF — " +
        "most likely an error served with a 200.",
    );
  }
  if (/html/i.test(declared) || /^\s*</.test(head)) {
    throw new LiveOakError(
      "LiveOak returned a web page where the statement should be, not a PDF. " +
        "The document link may need the portal itself; see docs/servers/liveoak.",
    );
  }
  return declared || "application/octet-stream";
}
