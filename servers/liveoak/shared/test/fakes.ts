/**
 * Local stand-ins for the three services this server talks to: Cognito, the
 * Apiture API, and a pre-signed document host on a second origin.
 *
 * THE COGNITO FAKE DOES THE REAL MATH. It implements the server side of
 * USER_SRP_AUTH, the PASSWORD_VERIFIER signature check and DEVICE_SRP_AUTH,
 * from the user's password verifier and the device verifier the client
 * registers — so a test that logs in has driven `amazon-cognito-identity-js`
 * through the same exchange LiveOak's pool would put it through, and a client
 * that sent a wrong proof would be refused here exactly as there. It never
 * sees the password: like Cognito, it holds only a verifier.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// --- SRP, the server half ------------------------------------------------------

const N = BigInt(
  "0x" +
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
    "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
    "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
    "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
    "83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
    "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
    "DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
    "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64" +
    "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
    "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B" +
    "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
    "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31" +
    "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const g = 2n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** The client's padHex, for positive values: even length, and a leading 00 if the top bit is set. */
function padHex(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return /^[89a-f]/i.test(hex) ? `00${hex}` : hex;
}

const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const hexHash = (hex: string): string => sha256Hex(Buffer.from(hex, "hex"));
const big = (hex: string): bigint => BigInt(`0x${hex}`);

const k = big(hexHash(padHex(N) + padHex(g)));

function verifierFor(poolName: string, userId: string, password: string, salt: bigint): bigint {
  const x = big(hexHash(padHex(salt) + sha256Hex(`${poolName}${userId}:${password}`)));
  return modPow(g, x, N);
}

function hkdf(S: bigint, u: bigint): Buffer {
  const prk = createHmac("sha256", Buffer.from(padHex(u), "hex")).update(Buffer.from(padHex(S), "hex")).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from("Caldera Derived Key", "utf8"), Buffer.from([1])]))
    .digest()
    .subarray(0, 16);
}

interface SrpRound {
  A: bigint;
  b: bigint;
  B: bigint;
  v: bigint;
  secretBlock: string;
}

function startRound(Ahex: string, v: bigint): SrpRound {
  const A = big(Ahex);
  if (A % N === 0n) throw new Error("A mod N is 0");
  const b = big(randomBytes(128).toString("hex"));
  const B = (k * v + modPow(g, b, N)) % N;
  return { A, b, B, v, secretBlock: randomBytes(64).toString("base64") };
}

function expectedSignature(round: SrpRound, name1: string, name2: string, timestamp: string): string {
  const u = big(hexHash(padHex(round.A) + padHex(round.B)));
  const S = modPow((round.A * modPow(round.v, u, N)) % N, round.b, N);
  const key = hkdf(S, u);
  return createHmac("sha256", key)
    .update(
      Buffer.concat([
        Buffer.from(name1, "utf8"),
        Buffer.from(name2, "utf8"),
        Buffer.from(round.secretBlock, "base64"),
        Buffer.from(timestamp, "utf8"),
      ]),
    )
    .digest("base64");
}

// --- HTTP plumbing ---------------------------------------------------------------

export interface Listening {
  url: string;
  close: () => Promise<void>;
}

export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>,
): Promise<Listening> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.end(JSON.stringify(body));
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "fake" })}.${b64(payload)}.${randomBytes(32).toString("base64url")}`;
}

// --- Cognito -------------------------------------------------------------------

export const POOL_ID = "us-east-1_FakePool1";
export const CLIENT_ID = "fakeclientid0123456789";
const POOL_NAME = POOL_ID.split("_")[1]!;

export interface FakeCognitoOptions {
  /** The login the pool knows. The fake keeps only a verifier of the password. */
  username: string;
  password: string;
  /** Default true: a login with no remembered device is answered with SMS_MFA. */
  mfa?: boolean;
  /** Default true: an MFA-completed login is issued NewDeviceMetadata. */
  issuesDevices?: boolean;
  /**
   * Echo an unknown username back in the refusal — which real Cognito does
   * not do, and which is how a test proves the scrub would catch it if it did.
   */
  echoUnknownUsername?: boolean;
  /** Seconds an access token lives. Default 3600. */
  tokenSeconds?: number;
}

export interface CognitoCall {
  target: string;
  body: string;
}

interface Pending {
  kind: "PASSWORD_VERIFIER" | "SMS_MFA" | "DEVICE_SRP_AUTH" | "DEVICE_PASSWORD_VERIFIER";
  round?: SrpRound;
  deviceKey?: string;
}

interface Device {
  groupKey: string;
  salt?: bigint;
  verifier?: bigint;
  remembered: boolean;
}

export class FakeCognito {
  readonly calls: CognitoCall[] = [];
  /** Every SMS "sent", newest last. */
  readonly smsCodes: string[] = [];
  readonly devices = new Map<string, Device>();
  readonly accessTokens = new Set<string>();
  readonly userIdForSrp = randomUUID();
  private readonly salt = big(randomBytes(16).toString("hex"));
  private readonly verifier: bigint;
  private readonly sessions = new Map<string, Pending>();
  private readonly loginName: string;
  private listening?: Listening;

  constructor(readonly options: FakeCognitoOptions) {
    this.loginName = options.username.toLowerCase().trim();
    this.verifier = verifierFor(POOL_NAME, this.userIdForSrp, options.password, this.salt);
  }

  get endpoint(): string {
    return `${this.listening!.url}/`;
  }

  async start(): Promise<this> {
    this.listening = await listen((req, res, body) => this.handle(req, res, body));
    return this;
  }

  async close(): Promise<void> {
    await this.listening?.close();
  }

  /** Forget every device server-side, as an account holder "forgetting" it would. */
  forgetAllDevices(): void {
    this.devices.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
    const target = String(req.headers["x-amz-target"] ?? "").replace("AWSCognitoIdentityProviderService.", "");
    const body = raw.toString("utf8");
    this.calls.push({ target, body });
    const params = JSON.parse(body || "{}") as Record<string, any>;
    const fail = (type: string, message: string) => json(res, 400, { __type: type, message }, "application/x-amz-json-1.1");
    const ok = (data: unknown) => json(res, 200, data, "application/x-amz-json-1.1");

    if (params.ClientId !== undefined && params.ClientId !== CLIENT_ID) {
      return fail("ResourceNotFoundException", "User pool client does not exist.");
    }

    switch (target) {
      case "InitiateAuth": {
        if (params.AuthFlow !== "USER_SRP_AUTH") return fail("InvalidParameterException", "flow");
        const auth = params.AuthParameters ?? {};
        if (auth.USERNAME !== this.loginName) {
          // Cognito's user-existence-error prevention answers like this too.
          return fail(
            "NotAuthorizedException",
            this.options.echoUnknownUsername
              ? `Incorrect username or password for ${String(auth.USERNAME)}.`
              : "Incorrect username or password.",
          );
        }
        const round = startRound(auth.SRP_A, this.verifier);
        const session = this.newSession({ kind: "PASSWORD_VERIFIER", round });
        return ok({
          ChallengeName: "PASSWORD_VERIFIER",
          Session: session,
          ChallengeParameters: {
            SALT: this.salt.toString(16),
            SRP_B: round.B.toString(16),
            SECRET_BLOCK: round.secretBlock,
            USER_ID_FOR_SRP: this.userIdForSrp,
            USERNAME: this.userIdForSrp,
          },
        });
      }
      case "RespondToAuthChallenge":
        return this.respond(params, ok, fail);
      case "ConfirmDevice": {
        if (!this.accessTokens.has(params.AccessToken)) return fail("NotAuthorizedException", "Invalid Access Token");
        const device = this.devices.get(params.DeviceKey);
        if (!device) return fail("ResourceNotFoundException", "Device does not exist.");
        const cfg = params.DeviceSecretVerifierConfig ?? {};
        device.salt = big(Buffer.from(cfg.Salt, "base64").toString("hex"));
        device.verifier = big(Buffer.from(cfg.PasswordVerifier, "base64").toString("hex"));
        return ok({ UserConfirmationNecessary: true });
      }
      case "UpdateDeviceStatus": {
        if (!this.accessTokens.has(params.AccessToken)) return fail("NotAuthorizedException", "Invalid Access Token");
        const device = this.devices.get(params.DeviceKey);
        if (!device) return fail("ResourceNotFoundException", "Device does not exist.");
        device.remembered = params.DeviceRememberedStatus === "remembered";
        return ok({});
      }
      default:
        return fail("UnknownOperationException", target);
    }
  }

  private respond(
    params: Record<string, any>,
    ok: (data: unknown) => void,
    fail: (type: string, message: string) => void,
  ): void {
    const pending = this.sessions.get(params.Session);
    const r = params.ChallengeResponses ?? {};
    if (!pending || pending.kind !== params.ChallengeName) {
      return fail("NotAuthorizedException", "Invalid session for the user.");
    }

    switch (pending.kind) {
      case "PASSWORD_VERIFIER": {
        const deviceKey: string | undefined = r.DEVICE_KEY ?? undefined;
        if (deviceKey && !this.devices.has(deviceKey)) {
          return fail("ResourceNotFoundException", "Device does not exist.");
        }
        const expected = expectedSignature(pending.round!, POOL_NAME, this.userIdForSrp, r.TIMESTAMP);
        if (r.PASSWORD_CLAIM_SIGNATURE !== expected || r.PASSWORD_CLAIM_SECRET_BLOCK !== pending.round!.secretBlock) {
          this.sessions.delete(params.Session);
          return fail("NotAuthorizedException", "Incorrect username or password.");
        }
        this.sessions.delete(params.Session);
        const device = deviceKey ? this.devices.get(deviceKey) : undefined;
        if (device?.verifier && device.remembered) {
          return ok({
            ChallengeName: "DEVICE_SRP_AUTH",
            Session: this.newSession({ kind: "DEVICE_SRP_AUTH", deviceKey }),
            ChallengeParameters: {},
          });
        }
        if (this.options.mfa ?? true) {
          const code = String(100000 + Math.floor(Math.random() * 899999));
          this.smsCodes.push(code);
          return ok({
            ChallengeName: "SMS_MFA",
            Session: this.newSession({ kind: "SMS_MFA" }),
            ChallengeParameters: {
              CODE_DELIVERY_DELIVERY_MEDIUM: "SMS",
              CODE_DELIVERY_DESTINATION: "+*******1234",
            },
          });
        }
        return ok({ AuthenticationResult: this.tokens(true) });
      }
      case "SMS_MFA": {
        if (r.SMS_MFA_CODE !== this.smsCodes.at(-1)) {
          return fail("CodeMismatchException", "Invalid code received for user");
        }
        this.sessions.delete(params.Session);
        return ok({ AuthenticationResult: this.tokens(true) });
      }
      case "DEVICE_SRP_AUTH": {
        const device = this.devices.get(r.DEVICE_KEY);
        if (!device?.verifier || r.DEVICE_KEY !== pending.deviceKey) {
          return fail("ResourceNotFoundException", "Device does not exist.");
        }
        this.sessions.delete(params.Session);
        const round = startRound(r.SRP_A, device.verifier);
        return ok({
          ChallengeName: "DEVICE_PASSWORD_VERIFIER",
          Session: this.newSession({ kind: "DEVICE_PASSWORD_VERIFIER", round, deviceKey: r.DEVICE_KEY }),
          ChallengeParameters: {
            SALT: device.salt!.toString(16),
            SRP_B: round.B.toString(16),
            SECRET_BLOCK: round.secretBlock,
          },
        });
      }
      case "DEVICE_PASSWORD_VERIFIER": {
        const device = this.devices.get(pending.deviceKey!)!;
        const expected = expectedSignature(pending.round!, device.groupKey, pending.deviceKey!, r.TIMESTAMP);
        this.sessions.delete(params.Session);
        if (r.PASSWORD_CLAIM_SIGNATURE !== expected) {
          return fail("NotAuthorizedException", "Incorrect device password.");
        }
        return ok({ AuthenticationResult: this.tokens(false) });
      }
    }
  }

  private newSession(p: Pending): string {
    const id = randomBytes(24).toString("base64");
    this.sessions.set(id, p);
    return id;
  }

  private tokens(newDevice: boolean): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (this.options.tokenSeconds ?? 3600);
    const access = jwt({ sub: this.userIdForSrp, token_use: "access", iat: now, exp });
    this.accessTokens.add(access);
    const result: Record<string, unknown> = {
      AccessToken: access,
      IdToken: jwt({ sub: this.userIdForSrp, token_use: "id", iat: now, exp }),
      RefreshToken: randomBytes(32).toString("base64url"),
      ExpiresIn: exp - now,
      TokenType: "Bearer",
    };
    if (newDevice && (this.options.issuesDevices ?? true)) {
      const deviceKey = `us-east-1_${randomUUID()}`;
      const groupKey = `-${randomBytes(6).toString("hex")}`;
      this.devices.set(deviceKey, { groupKey, remembered: false });
      result.NewDeviceMetadata = { DeviceKey: deviceKey, DeviceGroupKey: groupKey };
    }
    return result;
  }
}

// --- Apiture, and a second origin for pre-signed document links ------------------

export const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(2048), Buffer.from("\n%%EOF\n")]);

export interface FakeApiOptions {
  cognito: FakeCognito;
  /** The documents the account has. */
  documents: Array<{ id: string; endOn: string; startOn?: string; masked?: string; name?: string }>;
  /** When true, `GET /documents/documents/{id}` is a 404, as an undeployed route would be. */
  noSingleDocumentRoute?: boolean;
  /** When true, documents carry no `apiture:document` link, forcing `/content`. */
  noLinks?: boolean;
  /** Override the bytes served for every document. */
  body?: { bytes: Buffer; type: string };
}

export interface ApiRequest {
  method: string;
  path: string;
  authorization?: string;
  host: "api" | "files";
}

export class FakeApiture {
  readonly requests: ApiRequest[] = [];
  private api?: Listening;
  private files?: Listening;

  constructor(readonly options: FakeApiOptions) {}

  get apiRoot(): string {
    return this.api!.url;
  }

  async start(): Promise<this> {
    this.files = await listen((req, res) => this.serveFile(req, res));
    this.api = await listen((req, res) => this.serveApi(req, res));
    return this;
  }

  async close(): Promise<void> {
    await this.api?.close();
    await this.files?.close();
  }

  private record(req: IncomingMessage, host: "api" | "files"): URL {
    const url = new URL(req.url ?? "/", "http://x");
    this.requests.push({
      method: req.method ?? "?",
      path: url.pathname + url.search,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      host,
    });
    return url;
  }

  private doc(d: FakeApiOptions["documents"][number]): Record<string, unknown> {
    return {
      _id: d.id,
      name: d.name ?? "Savings Statement",
      category: "accountStatements",
      startOn: d.startOn,
      endOn: d.endOn,
      createdAt: `${d.endOn}T09:00:00.000Z`,
      account: d.masked ? { name: "Business Savings", accountNumbers: { masked: d.masked } } : undefined,
      _links: this.options.noLinks
        ? { self: { href: `/documents/documents/${d.id}` } }
        : {
            self: { href: `/documents/documents/${d.id}` },
            "apiture:document": { href: `${this.files!.url}/signed/${d.id}?X-Sig=${randomBytes(8).toString("hex")}` },
          },
    };
  }

  private serveApi(req: IncomingMessage, res: ServerResponse): void {
    const url = this.record(req, "api");
    if (req.method !== "GET") return json(res, 405, { message: "method" });
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.options.cognito.accessTokens.has(token)) {
      return json(res, 401, { _error: { message: "Unauthorized" } });
    }
    if (url.pathname === "/documents/documents") {
      const cats = (url.searchParams.get("category") ?? "").split("|");
      if (!cats.includes("accountStatements")) return json(res, 200, { _embedded: { items: [] } });
      const startOn = url.searchParams.get("startOn") ?? "";
      const period = /^P(\d+)M$/.exec(url.searchParams.get("period") ?? "");
      if (!startOn || !period) return json(res, 400, { _error: { message: "startOn and period required" } });
      const start = new Date(startOn);
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + Number(period[1]), 1));
      const items = this.options.documents
        .filter((d) => new Date(`${d.endOn}T00:00:00Z`) >= start && new Date(`${d.endOn}T00:00:00Z`) < end)
        .map((d) => this.doc(d));
      // Two pages, to prove `next` is followed.
      const page = Number(url.searchParams.get("page") ?? "0");
      const pageItems = items.slice(page * 2, page * 2 + 2);
      const next = items.length > (page + 1) * 2 ? new URL(req.url ?? "/", "http://x") : undefined;
      if (next) next.searchParams.set("page", String(page + 1));
      return json(
        res,
        200,
        {
          _embedded: { items: pageItems },
          _links: next ? { next: { href: next.pathname + next.search } } : {},
        },
        "application/hal+json",
      );
    }
    const one = /^\/documents\/documents\/([^/]+)(\/content)?$/.exec(url.pathname);
    if (one) {
      const d = this.options.documents.find((x) => x.id === decodeURIComponent(one[1]!));
      if (!d) return json(res, 404, { _error: { message: "Not found" } });
      if (one[2]) return this.sendBytes(res);
      if (this.options.noSingleDocumentRoute) return json(res, 404, { _error: { message: "Not found" } });
      return json(res, 200, this.doc(d), "application/hal+json");
    }
    return json(res, 404, { _error: { message: "Not found" } });
  }

  private serveFile(req: IncomingMessage, res: ServerResponse): void {
    const url = this.record(req, "files");
    if (!url.searchParams.get("X-Sig")) return json(res, 403, { message: "unsigned" });
    if (!this.options.documents.some((d) => url.pathname === `/signed/${d.id}`)) return json(res, 404, {});
    this.sendBytes(res);
  }

  private sendBytes(res: ServerResponse): void {
    const body = this.options.body ?? { bytes: PDF, type: "application/pdf" };
    res.statusCode = 200;
    res.setHeader("content-type", body.type);
    res.setHeader("content-length", String(body.bytes.length));
    res.end(body.bytes);
  }
}
