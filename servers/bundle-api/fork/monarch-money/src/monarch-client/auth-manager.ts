/**
 * Which credential a request goes out with, resolved PER REQUEST, and what
 * happens when Monarch refuses it.
 *
 * ## Precedence
 *
 *   1. `MONARCH_COOKIE` — the browser's `Cookie` header. What Monarch's web app
 *      authenticates with, and the only credential a human can still copy.
 *   2. `MONARCH_SESSION_TOKEN` — a pasted bearer token.
 *   3. A credential in the session store: one a headless login minted, or one
 *      `monarch_login_with_token` saved.
 *
 * Read from the LIVE environment on every request, never captured at boot. The
 * strad bundle host re-reads a `paramsRefresh:` variable into `process.env` while
 * the container runs, and `set_session_cookie` writes there too, so a refreshed
 * cookie is used on the next call with no restart.
 *
 * ## Headless re-login
 *
 * When `MONARCH_EMAIL` and `MONARCH_PASSWORD` are set, a refused request (or a
 * request with no credential at all) triggers one REST login, and the request
 * is retried once with what it minted. `MONARCH_TOTP_SECRET` answers 2FA, and
 * `MONARCH_DEVICE_UUID` pins the `device-uuid` Monarch trusts after one paired
 * login — on a container whose disk does not survive a deploy, a generated one
 * would be a new device every launch.
 *
 * It is BEST-EFFORT, and the evidence says so: some accounts log in headlessly
 * from a trusted device, others get `403 CAPTCHA_REQUIRED` or the edge's
 * "Shall Not Pass" bot block (FORK.md has the sources). A failed login is
 * reported in the error the caller sees, and not retried for
 * `loginCooldownMs` so a broken login cannot hammer Monarch into a lockout.
 */
import { generateDeviceUuid, login, type LoginTransportOptions } from './auth.js';
import {
  mergeSetCookies,
  normaliseCookieHeader,
  type MonarchCredential,
} from './credentials.js';
import {
  createGraphQLTransport,
  MonarchAuthError,
  type GraphQLTransport,
} from './graphql-transport.js';
import type { SessionStore } from './session-store.js';
import { totpCode } from './totp.js';
import { Q_ME } from './operations.js';
import { logWarning } from '../logging.js';
import type { SessionState } from '../types.js';

const DEFAULT_ENDPOINT = 'https://api.monarch.com/graphql';
const DEFAULT_LOGIN_COOLDOWN_MS = 15 * 60 * 1000;

export interface AuthManagerOptions {
  sessionStore: SessionStore;
  /** The LIVE environment. Defaults to `process.env`, read on every request. */
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  loginEndpoint?: string;
  /**
   * Make a cookie durable: write it where the NEXT process will read it. The
   * strad bundle host wires this to core's parameter write-back (a server's
   * `paramsWritable:`), so the value lands in the parameter store under this
   * server's own namespace and nowhere else. Absent, a cookie set at runtime
   * lives as long as this process.
   */
  persistCookie?: (cookie: string) => Promise<void>;
  /** Where `persistCookie` writes, for messages. A description, never a value. */
  persistTarget?: string;
  now?: () => number;
  loginCooldownMs?: number;
}

export type CredentialSource = 'MONARCH_COOKIE' | 'MONARCH_SESSION_TOKEN' | 'login' | 'stored';

export interface AuthStatus {
  method: 'cookie' | 'token' | 'none';
  source?: CredentialSource;
  /** `MONARCH_EMAIL` + `MONARCH_PASSWORD` are set, so a refusal triggers a login. */
  headlessLogin: boolean;
  /** `MONARCH_TOTP_SECRET` is set, so that login can answer 2FA unattended. */
  totpSecret: boolean;
  /** A runtime-set cookie survives a restart. */
  cookiePersistence: boolean;
  persistTarget?: string;
  /** The last headless login failure, when one is inside its cooldown. */
  lastLoginFailure?: string;
}

interface Resolved {
  credential: MonarchCredential;
  source: CredentialSource;
}

export interface SetCookieResult {
  persisted: boolean;
  /** Why it was not made durable, when it was not. */
  persistNote?: string;
}

export class MonarchAuthManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  /**
   * The environment credentials a successful login replaced. While the
   * environment still holds exactly these, the login's credential outranks
   * them — re-sending a cookie Monarch just refused would only buy a second
   * refusal and a second login. A NEW value in the environment (a human pasted
   * a fresh cookie) is tried first again.
   */
  private superseded: { cookie: string | null; token: string | null } | null = null;
  private loginInFlight: Promise<Resolved> | null = null;
  private lastLoginFailure: { at: number; message: string } | null = null;

  constructor(private readonly options: AuthManagerOptions) {
    this.env = options.env ?? process.env;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.loginCooldownMs ?? DEFAULT_LOGIN_COOLDOWN_MS;
  }

  private envCookie(): string | null {
    return normaliseCookieHeader(this.env.MONARCH_COOKIE);
  }

  private envToken(): string | null {
    return trimOrNull(this.env.MONARCH_SESSION_TOKEN);
  }

  /** Where a persisted cookie lands, for messages. */
  get persistTarget(): string | undefined {
    return this.options.persistTarget;
  }

  canLogin(): boolean {
    return !!trimOrNull(this.env.MONARCH_EMAIL) && !!this.env.MONARCH_PASSWORD;
  }

  private async loadStored(): Promise<SessionState | null> {
    try {
      return await this.options.sessionStore.load();
    } catch (err) {
      // A session file this process cannot decrypt is not a reason to refuse a
      // cookie in the environment. Say so, and carry on as if it were absent.
      logWarning('monarch-money', `ignoring the session store: ${errText(err)}`);
      return null;
    }
  }

  private async resolve(): Promise<Resolved | null> {
    const cookie = this.envCookie();
    const token = this.envToken();
    const stale =
      this.superseded !== null &&
      this.superseded.cookie === cookie &&
      this.superseded.token === token;
    if (!stale) {
      if (cookie) return { credential: { method: 'cookie', cookie }, source: 'MONARCH_COOKIE' };
      if (token)
        return {
          credential: { method: 'token', token, source: 'env' },
          source: 'MONARCH_SESSION_TOKEN',
        };
    }
    const stored = await this.loadStored();
    if (stored?.token) {
      const source = stored.via === 'login' ? 'login' : 'stored';
      return { credential: { method: 'token', token: stored.token, source }, source };
    }
    if (stored?.cookie) {
      return { credential: { method: 'cookie', cookie: stored.cookie }, source: 'login' };
    }
    if (stale) {
      if (cookie) return { credential: { method: 'cookie', cookie }, source: 'MONARCH_COOKIE' };
      if (token)
        return {
          credential: { method: 'token', token, source: 'env' },
          source: 'MONARCH_SESSION_TOKEN',
        };
    }
    return null;
  }

  private async deviceUuid(): Promise<string | undefined> {
    const pinned = trimOrNull(this.env.MONARCH_DEVICE_UUID);
    if (pinned) return pinned;
    const stored = await this.loadStored();
    return stored?.deviceUuid;
  }

  /**
   * Run `fn` with the current credential; on a refusal, log in (when
   * configured) and run it once more with what the login minted.
   */
  async withCredential<T>(
    fn: (credential: MonarchCredential, deviceUuid: string | undefined, source: CredentialSource) => Promise<T>
  ): Promise<T> {
    let resolved = await this.resolve();
    if (!resolved) {
      if (!this.canLogin()) {
        const err = new MonarchAuthError('No Monarch credential is configured.', 'missing');
        err.method = 'none';
        throw err;
      }
      try {
        resolved = await this.relogin(null);
      } catch (loginErr) {
        const err = new MonarchAuthError('No Monarch credential is configured.', 'missing');
        err.method = 'none';
        err.loginFailure = errText(loginErr);
        throw err;
      }
    }

    const deviceUuid = await this.deviceUuid();
    try {
      return await fn(resolved.credential, deviceUuid, resolved.source);
    } catch (err) {
      if (!(err instanceof MonarchAuthError)) throw err;
      err.method = resolved.credential.method;
      if (!this.canLogin()) throw err;
      let fresh: Resolved;
      try {
        fresh = await this.relogin(resolved);
      } catch (loginErr) {
        err.loginFailure = errText(loginErr);
        throw err;
      }
      try {
        return await fn(fresh.credential, await this.deviceUuid(), fresh.source);
      } catch (retryErr) {
        if (retryErr instanceof MonarchAuthError) retryErr.method = fresh.credential.method;
        throw retryErr;
      }
    }
  }

  /** The GraphQL transport every tool uses. */
  transport(): GraphQLTransport {
    return {
      request: <T>(op: { query: string; variables?: Record<string, unknown> }) =>
        this.withCredential((credential, deviceUuid, source) =>
          this.send<T>(credential, deviceUuid, source, op)
        ),
    };
  }

  private send<T>(
    credential: MonarchCredential,
    deviceUuid: string | undefined,
    source: CredentialSource,
    op: { query: string; variables?: Record<string, unknown> }
  ): Promise<T> {
    return createGraphQLTransport({
      endpoint: this.endpoint,
      credential,
      fetchImpl: this.fetchImpl,
      deviceUuid,
      onSetCookie:
        credential.method === 'cookie'
          ? (setCookies) => this.absorbSetCookies(credential.cookie, source, setCookies)
          : undefined,
    }).request<T>(op);
  }

  /**
   * Keep a session Monarch re-issued. Only an ENVIRONMENT cookie is written
   * back to the environment (and persisted), and only while the environment
   * still holds the cookie the request was sent with — a value that changed
   * underneath this request is newer than anything this response knows about.
   */
  private absorbSetCookies(used: string, source: CredentialSource, setCookies: string[]): void {
    const merged = mergeSetCookies(used, setCookies);
    if (!merged) return;
    if (source === 'login') {
      void this.updateStored({ cookie: merged });
      return;
    }
    if (source !== 'MONARCH_COOKIE' || this.envCookie() !== used) return;
    this.env.MONARCH_COOKIE = merged;
    if (this.options.persistCookie) {
      this.options.persistCookie(merged).catch((err: unknown) =>
        logWarning(
          'monarch-money',
          `Monarch re-issued the session cookie and it could not be persisted: ${errText(err)}. ` +
            `This process uses the new value; the next restart reads the old one.`
        )
      );
    }
  }

  private async updateStored(patch: Partial<SessionState>): Promise<void> {
    try {
      const existing = await this.loadStored();
      await this.options.sessionStore.save({
        token: existing?.token ?? '',
        obtainedAt: existing?.obtainedAt ?? new Date(this.now()).toISOString(),
        ...existing,
        ...patch,
      });
    } catch (err) {
      logWarning('monarch-money', `could not update the session store: ${errText(err)}`);
    }
  }

  /** Single-flight, rate-limited REST login. Throws with the reason it failed. */
  private relogin(replacing: Resolved | null): Promise<Resolved> {
    if (this.loginInFlight) return this.loginInFlight;
    const last = this.lastLoginFailure;
    if (last && this.now() - last.at < this.cooldownMs) {
      const minutes = Math.ceil((this.cooldownMs - (this.now() - last.at)) / 60000);
      return Promise.reject(
        new Error(`${last.message} (not retried for another ${minutes} min, to avoid a lockout)`)
      );
    }
    const envAtFailure = { cookie: this.envCookie(), token: this.envToken() };
    this.loginInFlight = this.doLogin()
      .then((fresh) => {
        this.lastLoginFailure = null;
        if (replacing && replacing.source !== 'stored') this.superseded = envAtFailure;
        return fresh;
      })
      .catch((err: unknown) => {
        this.lastLoginFailure = { at: this.now(), message: `headless login failed: ${errText(err)}` };
        throw new Error(this.lastLoginFailure.message, { cause: err });
      })
      .finally(() => {
        this.loginInFlight = null;
      });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<Resolved> {
    const email = trimOrNull(this.env.MONARCH_EMAIL)!;
    const password = this.env.MONARCH_PASSWORD!;
    const stored = await this.loadStored();
    let deviceUuid = trimOrNull(this.env.MONARCH_DEVICE_UUID) ?? stored?.deviceUuid;
    if (!deviceUuid) deviceUuid = generateDeviceUuid();

    const secret = trimOrNull(this.env.MONARCH_TOTP_SECRET);
    const totp = secret ? totpCode(secret, new Date(this.now())) : trimOrNull(this.env.MONARCH_TOTP);

    const transportOpts: LoginTransportOptions = { fetchImpl: this.fetchImpl };
    if (this.options.loginEndpoint) transportOpts.endpoint = this.options.loginEndpoint;
    const result = await login(
      {
        email,
        password,
        totp: totp ?? undefined,
        emailOtp: trimOrNull(this.env.MONARCH_EMAIL_OTP) ?? undefined,
        deviceUuid,
      },
      transportOpts
    );

    const next: SessionState = {
      token: result.token ?? '',
      ...(result.cookie ? { cookie: result.cookie } : {}),
      via: 'login',
      obtainedAt: new Date(this.now()).toISOString(),
      email: result.user?.email ?? email,
      deviceUuid,
    };
    await this.options.sessionStore.save(next);
    if (result.token) {
      return { credential: { method: 'token', token: result.token, source: 'login' }, source: 'login' };
    }
    return { credential: { method: 'cookie', cookie: result.cookie! }, source: 'login' };
  }

  /**
   * Install a cookie a human (or an agent acting for one) just copied: verify
   * it against Monarch FIRST, then put it in the live environment, then make
   * it durable. A cookie Monarch refuses is never written anywhere.
   */
  async setCookie(raw: string): Promise<SetCookieResult & { me: { id: string; email: string; name: string } }> {
    const cookie = normaliseCookieHeader(raw);
    if (!cookie) throw new Error('That is not a Cookie header: it holds no name=value pairs.');
    const credential: MonarchCredential = { method: 'cookie', cookie };
    let data: { me: { id: string; email: string; name: string } };
    try {
      data = await createGraphQLTransport({
        endpoint: this.endpoint,
        credential,
        fetchImpl: this.fetchImpl,
        deviceUuid: await this.deviceUuid(),
      }).request<{ me: { id: string; email: string; name: string } }>({ query: Q_ME });
    } catch (err) {
      if (err instanceof MonarchAuthError) err.method = 'cookie';
      throw err;
    }

    this.env.MONARCH_COOKIE = cookie;
    this.superseded = null;
    if (!this.options.persistCookie) {
      return {
        me: data.me,
        persisted: false,
        persistNote:
          'No write-back is configured, so this cookie lasts until the process restarts.',
      };
    }
    try {
      await this.options.persistCookie(cookie);
      return { me: data.me, persisted: true };
    } catch (err) {
      return {
        me: data.me,
        persisted: false,
        persistNote: `It could not be persisted (${errText(err)}), so it lasts until the process restarts.`,
      };
    }
  }

  /**
   * At boot, log in ahead of the first request when headless login is the only
   * credential there is. Never throws; a failure is the first request's error.
   */
  async warm(): Promise<void> {
    if (!this.canLogin() || (await this.resolve())) return;
    try {
      await this.relogin(null);
    } catch (err) {
      logWarning('monarch-money', errText(err));
    }
  }

  async status(): Promise<AuthStatus> {
    const resolved = await this.resolve();
    const last = this.lastLoginFailure;
    return {
      method: resolved ? resolved.credential.method : 'none',
      ...(resolved ? { source: resolved.source } : {}),
      headlessLogin: this.canLogin(),
      totpSecret: !!trimOrNull(this.env.MONARCH_TOTP_SECRET),
      cookiePersistence: !!this.options.persistCookie,
      ...(this.options.persistTarget ? { persistTarget: this.options.persistTarget } : {}),
      ...(last && this.now() - last.at < this.cooldownMs ? { lastLoginFailure: last.message } : {}),
    };
  }

}

function trimOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
