/**
 * The Cognito login, driven through `amazon-cognito-identity-js` against a
 * fake pool that does the server half of SRP for real (see fakes.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CognitoLogin, LoginError } from "../src/cognito.js";
import { CLIENT_ID, FakeCognito, POOL_ID } from "./fakes.js";

const USERNAME = "Tadas@Example.com";
const PASSWORD = "correct horse battery staple!";

let cognito: FakeCognito;
let login: CognitoLogin;

beforeEach(async () => {
  cognito = await new FakeCognito({ username: USERNAME, password: PASSWORD }).start();
  login = new CognitoLogin({ userPoolId: POOL_ID, clientId: CLIENT_ID, endpoint: cognito.endpoint });
});

afterEach(async () => {
  await cognito.close();
});

async function enrol() {
  const first = await login.authenticate(USERNAME, PASSWORD, null);
  if (first.kind !== "mfa") throw new Error("expected an MFA challenge");
  return first.challenge.respond(cognito.smsCodes.at(-1)!);
}

describe("CognitoLogin", () => {
  it("never puts the password on the wire: SRP sends a proof, not the value", async () => {
    await enrol();
    expect(cognito.calls.length).toBeGreaterThan(0);
    for (const call of cognito.calls) expect(call.body).not.toContain(PASSWORD);
  });

  it("lowercases the username, as the portal does", async () => {
    await login.authenticate(USERNAME, PASSWORD, null);
    const init = JSON.parse(cognito.calls.find((c) => c.target === "InitiateAuth")!.body);
    expect(init.AuthParameters.USERNAME).toBe("tadas@example.com");
    expect(init.AuthFlow).toBe("USER_SRP_AUTH");
    expect(init.ClientId).toBe(CLIENT_ID);
  });

  it("first login: an SMS challenge, then a confirmed and REMEMBERED device", async () => {
    const first = await login.authenticate(USERNAME, PASSWORD, null);
    expect(first.kind).toBe("mfa");
    if (first.kind !== "mfa") return;
    expect(first.challenge).toMatchObject({ type: "SMS_MFA", medium: "SMS", destination: "+*******1234" });

    const session = await first.challenge.respond(cognito.smsCodes.at(-1)!);
    expect(cognito.accessTokens.has(session.accessToken)).toBe(true);
    expect(session.device).not.toBeNull();
    expect(session.device!.userIdForSrp).toBe(cognito.userIdForSrp);
    const server = cognito.devices.get(session.device!.deviceKey)!;
    expect(server.verifier).toBeDefined();
    expect(server.remembered).toBe(true);
    expect(cognito.calls.map((c) => c.target)).toEqual([
      "InitiateAuth",
      "RespondToAuthChallenge",
      "RespondToAuthChallenge",
      "ConfirmDevice",
      "UpdateDeviceStatus",
    ]);
  });

  it("with the remembered device: no SMS, and the device SRP leg is proven", async () => {
    const enrolled = await enrol();
    const sent = cognito.smsCodes.length;
    cognito.calls.length = 0;

    const again = await login.authenticate(USERNAME, PASSWORD, enrolled.device);
    expect(again.kind).toBe("session");
    if (again.kind !== "session") return;
    expect(cognito.smsCodes.length).toBe(sent);
    expect(again.session.device!.deviceKey).toBe(enrolled.device!.deviceKey);
    const challenges = cognito.calls
      .filter((c) => c.target === "RespondToAuthChallenge")
      .map((c) => JSON.parse(c.body).ChallengeName);
    expect(challenges).toEqual(["PASSWORD_VERIFIER", "DEVICE_SRP_AUTH", "DEVICE_PASSWORD_VERIFIER"]);
  });

  it("a tampered device password is refused by the device SRP leg", async () => {
    const enrolled = await enrol();
    const tampered = { ...enrolled.device!, devicePassword: "not-the-device-password" };
    await expect(login.authenticate(USERNAME, PASSWORD, tampered)).rejects.toMatchObject({
      code: "NotAuthorizedException",
    });
  });

  it("a device the pool forgot falls back to MFA", async () => {
    const enrolled = await enrol();
    cognito.forgetAllDevices();
    const again = await login.authenticate(USERNAME, PASSWORD, enrolled.device);
    expect(again.kind).toBe("mfa");
  });

  it("a wrong password is refused with Cognito's words and the password nowhere in them", async () => {
    const err = await login.authenticate(USERNAME, "wrong password!", null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as LoginError).code).toBe("NotAuthorizedException");
    expect((err as Error).message).toContain("Incorrect username or password.");
    expect((err as Error).message).not.toContain("wrong password!");
  });

  it("a wrong MFA code is a CodeMismatchException the same challenge can retry", async () => {
    const first = await login.authenticate(USERNAME, PASSWORD, null);
    if (first.kind !== "mfa") throw new Error("expected mfa");
    await expect(first.challenge.respond("000000")).rejects.toMatchObject({ code: "CodeMismatchException" });
    const session = await first.challenge.respond(cognito.smsCodes.at(-1)!);
    expect(session.device).not.toBeNull();
  });
});
