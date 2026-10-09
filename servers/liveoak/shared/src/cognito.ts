/**
 * The LiveOak login: AWS Cognito, spoken through `amazon-cognito-identity-js`
 * — the same client library, the same user pool and the same app client the
 * portal at secure.liveoak.bank runs in the browser.
 *
 * WHY THE PORTAL'S OWN LIBRARY rather than a hand-written SRP client. The
 * exchange has three legs that must be byte-exact (USER_SRP_AUTH, the
 * PASSWORD_VERIFIER signature over a formatted timestamp, and DEVICE_SRP_AUTH
 * for the remembered device), and this server cannot be tested against
 * LiveOak's real pool before it ships. Matching what the portal already does
 * is the smallest claim to make about a wire nobody here can watch. The pool
 * and client ids are read out of the portal's public bundle
 * (`main-es2015.*.js`: `cognito:{poolId:…,appClientId:…}`).
 *
 * The password goes into `AuthenticationDetails` and nowhere else. SRP sends
 * Cognito a proof derived from it, never the value.
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
  type IAuthenticationCallback,
  type ICognitoStorage,
} from "amazon-cognito-identity-js";
import type { DeviceState } from "./device-store.js";
import { redact } from "./logging.js";

/** secure.liveoak.bank's Cognito pool and app client. Public: the portal ships them. */
export const LIVEOAK_COGNITO = {
  userPoolId: "us-east-1_RDbe8eaw5",
  clientId: "59hfimqoiusof59efui7ufvgis",
} as const;

export interface CognitoOptions {
  userPoolId: string;
  clientId: string;
  /** Tests only: a local stand-in for `https://cognito-idp.<region>.amazonaws.com/`. */
  endpoint?: string;
}

/** What a successful login leaves this process holding. */
export interface Session {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /**
   * The device this login was made as. Non-null and different from what was
   * passed in exactly when Cognito minted and confirmed a NEW device — which
   * is what an MFA-completed login does, and what the caller must persist.
   */
  device: DeviceState | null;
}

export type LoginOutcome =
  | { kind: "session"; session: Session }
  | { kind: "mfa"; challenge: MfaChallenge };

/**
 * A login paused on an MFA code. It lives only in this process's memory, for
 * as long as Cognito's challenge session does (three minutes by default; the
 * pool decides).
 */
export interface MfaChallenge {
  type: "SMS_MFA" | "SOFTWARE_TOKEN_MFA";
  /** "SMS", "EMAIL", or undefined for an authenticator app. */
  medium?: string;
  /** Cognito's own masked destination, e.g. "+*******1234". Never unmasked. */
  destination?: string;
  respond(code: string): Promise<Session>;
}

/**
 * A login Cognito refused, with a message safe to show a caller: Cognito's own
 * wording (which never carries the password) run through `redact`, plus what
 * to do next. `code` is Cognito's exception name.
 */
export class LoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

/**
 * The library's storage interface, over a Map that lives for one login. The
 * only keys that outlive it are the three device keys, and they leave through
 * `deviceFor` and arrive through `seedDevice` — never through the Map itself.
 */
class LoginStorage implements ICognitoStorage {
  readonly items = new Map<string, string>();
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

/**
 * Turn whatever the library rejected with into a {@link LoginError}. The
 * library rejects with an `Error` whose `code` is Cognito's exception type,
 * and its message is Cognito's — `redact` runs over it all the same.
 */
export function loginError(err: unknown): LoginError {
  if (err instanceof LoginError) return err;
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  const code =
    typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "Error";
  const said = redact(typeof e?.message === "string" && e.message ? e.message : String(err));
  const advice: Record<string, string> = {
    NotAuthorizedException:
      "Check LIVEOAK_USERNAME and LIVEOAK_PASSWORD in strad's console. Repeated " +
      "failures lock the account, so do not retry in a loop.",
    UserNotFoundException:
      "Check LIVEOAK_USERNAME in strad's console. It is the login for " +
      "secure.liveoak.bank (lowercased before it is sent, as the portal does).",
    PasswordResetRequiredException:
      "LiveOak requires a password reset. Reset it on secure.liveoak.bank, " +
      "then update LIVEOAK_PASSWORD in strad's console.",
    UserNotConfirmedException: "The LiveOak account is not confirmed.",
    CodeMismatchException:
      "That is not the code LiveOak sent. Check it and call confirm_device " +
      "again; Cognito allows a few attempts before the challenge expires.",
    ExpiredCodeException: "The code expired. Call enrol_device for a new one.",
    TooManyRequestsException: "Cognito is rate limiting this account; wait a minute and retry.",
    LimitExceededException: "Cognito is rate limiting this account; wait a minute and retry.",
    NetworkError: "Cognito could not be reached: transient; retry the call.",
  };
  return new LoginError(
    code,
    `LiveOak's login (AWS Cognito) said ${code}: ${said}${advice[code] ? ` ${advice[code]}` : ""}`,
  );
}

export class CognitoLogin {
  constructor(private readonly options: CognitoOptions) {}

  /**
   * Log in as `username`, presenting `device` if one is enrolled. Resolves to
   * a session, or to an MFA challenge the caller may answer or drop.
   */
  authenticate(
    username: string,
    password: string,
    device: DeviceState | null,
  ): Promise<LoginOutcome> {
    const storage = new LoginStorage();
    const pool = new CognitoUserPool({
      UserPoolId: this.options.userPoolId,
      ClientId: this.options.clientId,
      Storage: storage,
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
    });
    if (device) this.seedDevice(storage, device);

    // The portal lowercases and trims the username before it builds the user
    // (`getCognitoUser`), and the pool's internal username is case-sensitive.
    const user = new CognitoUser({ Username: username.toLowerCase().trim(), Pool: pool, Storage: storage });
    const details = new AuthenticationDetails({
      Username: username.toLowerCase().trim(),
      Password: password,
    });

    return new Promise<LoginOutcome>((resolve, reject) => {
      const finish = (session: CognitoUserSession): void => {
        this.finishLogin(user, storage, session, device).then(
          (s) => resolve({ kind: "session", session: s }),
          (err: unknown) => reject(loginError(err)),
        );
      };
      const challenge = (type: MfaChallenge["type"], params: unknown): void => {
        const p = (params ?? {}) as Record<string, unknown>;
        resolve({
          kind: "mfa",
          challenge: {
            type,
            medium: typeof p.CODE_DELIVERY_DELIVERY_MEDIUM === "string" ? p.CODE_DELIVERY_DELIVERY_MEDIUM : undefined,
            destination:
              typeof p.CODE_DELIVERY_DESTINATION === "string" ? p.CODE_DELIVERY_DESTINATION : undefined,
            respond: (code) => this.respond(user, storage, device, type, code),
          },
        });
      };
      const refuse = (code: string, message: string) => (): void =>
        reject(new LoginError(code, message));

      const callbacks: IAuthenticationCallback = {
        onSuccess: finish,
        onFailure: (err: unknown) => reject(loginError(err)),
        mfaRequired: (_name, params) => challenge("SMS_MFA", params),
        totpRequired: (_name, params) => challenge("SOFTWARE_TOKEN_MFA", params),
        newPasswordRequired: refuse(
          "NEW_PASSWORD_REQUIRED",
          "LiveOak requires a new password before this account can log in. Set one " +
            "on secure.liveoak.bank, then update LIVEOAK_PASSWORD in strad's console.",
        ),
        customChallenge: refuse(
          "CUSTOM_CHALLENGE",
          "LiveOak answered the login with a custom challenge this server does not " +
            "implement. The pool's login flow has changed; see docs/servers/liveoak.",
        ),
        mfaSetup: refuse(
          "MFA_SETUP",
          "LiveOak requires MFA to be set up for this account first. Do that on " +
            "secure.liveoak.bank, then call enrol_device.",
        ),
        selectMFAType: refuse(
          "SELECT_MFA_TYPE",
          "LiveOak asked which MFA method to use, which this server does not " +
            "choose for the account. Set a preferred MFA method on secure.liveoak.bank.",
        ),
      };
      user.authenticateUser(details, callbacks);
    });
  }

  private respond(
    user: CognitoUser,
    storage: LoginStorage,
    device: DeviceState | null,
    type: MfaChallenge["type"],
    code: string,
  ): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
      user.sendMFACode(
        code,
        {
          onSuccess: (session) =>
            this.finishLogin(user, storage, session, device).then(resolve, (err: unknown) =>
              reject(loginError(err)),
            ),
          onFailure: (err: unknown) => reject(loginError(err)),
        },
        type,
      );
    });
  }

  /**
   * After any successful login: read back the device the library holds, and
   * if it is a NEW one, mark it remembered — what the portal does when its
   * "remember this device" box is ticked (`setDeviceStatusRemembered`). A pool
   * that remembers every device already has; a pool that asks the user to opt
   * in only suppresses MFA for a device marked this way.
   */
  private async finishLogin(
    user: CognitoUser,
    storage: LoginStorage,
    session: CognitoUserSession,
    presented: DeviceState | null,
  ): Promise<Session> {
    const held = this.deviceFor(storage, user.getUsername());
    let device: DeviceState | null = presented;
    if (held && held.deviceKey !== presented?.deviceKey) {
      await new Promise<void>((resolve, reject) => {
        user.setDeviceStatusRemembered({
          onSuccess: () => resolve(),
          onFailure: (err: unknown) => reject(err),
        });
      });
      device = held;
    } else if (!held) {
      // Cognito dropped the device we presented (the library clears it when
      // Cognito says it no longer exists) and minted none.
      device = null;
    }
    const access = session.getAccessToken();
    return {
      accessToken: access.getJwtToken(),
      expiresAt: access.getExpiration() * 1000,
      device,
    };
  }

  private keyPrefix(userIdForSrp: string): string {
    return `CognitoIdentityServiceProvider.${this.options.clientId}.${userIdForSrp}`;
  }

  private seedDevice(storage: LoginStorage, device: DeviceState): void {
    const prefix = this.keyPrefix(device.userIdForSrp);
    storage.setItem(`${prefix}.deviceKey`, device.deviceKey);
    storage.setItem(`${prefix}.deviceGroupKey`, device.deviceGroupKey);
    storage.setItem(`${prefix}.randomPasswordKey`, device.devicePassword);
  }

  private deviceFor(storage: LoginStorage, userIdForSrp: string): DeviceState | null {
    const prefix = this.keyPrefix(userIdForSrp);
    const deviceKey = storage.getItem(`${prefix}.deviceKey`);
    const deviceGroupKey = storage.getItem(`${prefix}.deviceGroupKey`);
    const devicePassword = storage.getItem(`${prefix}.randomPasswordKey`);
    if (!deviceKey || !deviceGroupKey || !devicePassword) return null;
    return {
      userIdForSrp,
      deviceKey,
      deviceGroupKey,
      devicePassword,
      enrolledAt: new Date().toISOString(),
    };
  }
}
