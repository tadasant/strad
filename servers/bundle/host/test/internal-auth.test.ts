import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  internalAuthRefusal,
  requireInternalToken,
} from "../src/internal-auth.js";

/**
 * The gate in front of this image's MCP mounts.
 *
 * The failure direction here is OPEN: a middleware wired to the wrong env name,
 * or a comparator that says yes to everything, passes any test that only asks
 * "does a correct token work". So every case below asserts a REFUSAL except the
 * two that assert the served path, and the served path is asserted over real
 * HTTP through express — the same `app.METHOD(path, internalOnly, handler)`
 * shape `index.ts` uses — rather than by calling the middleware directly.
 */

const TOKEN = "internal-token-value";

describe("the decision", () => {
  it("admits a correctly presented token", () => {
    expect(
      internalAuthRefusal(
        `Bearer ${TOKEN}`,
        { STRAD_INTERNAL_TOKEN: TOKEN } as NodeJS.ProcessEnv,
        timingSafeEqual,
      ),
    ).toBeUndefined();
  });

  it("admits the bare token, and any casing of the scheme", () => {
    for (const header of [TOKEN, `bearer ${TOKEN}`, `BEARER   ${TOKEN}`]) {
      expect(
        internalAuthRefusal(
          header,
          { STRAD_INTERNAL_TOKEN: TOKEN } as NodeJS.ProcessEnv,
          timingSafeEqual,
        ),
      ).toBeUndefined();
    }
  });

  it("refuses a request with no Authorization header at all", () => {
    expect(
      internalAuthRefusal(
        undefined,
        { STRAD_INTERNAL_TOKEN: TOKEN } as NodeJS.ProcessEnv,
        timingSafeEqual,
      ),
    ).toEqual({ status: 401, error: "invalid internal token" });
  });

  it("refuses a wrong token, including one that is a prefix of the right one", () => {
    for (const presented of ["nope", TOKEN.slice(0, -1), `${TOKEN}x`, ""]) {
      expect(
        internalAuthRefusal(
          `Bearer ${presented}`,
          { STRAD_INTERNAL_TOKEN: TOKEN } as NodeJS.ProcessEnv,
          timingSafeEqual,
        )?.status,
      ).toBe(401);
    }
  });

  // The whole point of the entry. A component that cannot tell core from
  // anything else in the VPC must not guess, and "unset" must never read as
  // "unauthenticated is fine" — which is what this image did before.
  it("fails CLOSED with 503 when STRAD_INTERNAL_TOKEN is unset", () => {
    for (const env of [{}, { STRAD_INTERNAL_TOKEN: "" }]) {
      expect(
        internalAuthRefusal(
          `Bearer ${TOKEN}`,
          env as NodeJS.ProcessEnv,
          timingSafeEqual,
        ),
      ).toEqual({ status: 503, error: "internal token not configured" });
    }
  });

  it("refuses even an empty presented token when the host holds none", () => {
    expect(
      internalAuthRefusal(
        undefined,
        {} as NodeJS.ProcessEnv,
        timingSafeEqual,
      )?.status,
    ).toBe(503);
  });
});

/** A mount-shaped route behind the middleware, served over a real socket. */
function serve(env: NodeJS.ProcessEnv): Promise<{ url: string; server: Server }> {
  const app = express();
  const internalOnly = requireInternalToken(env, timingSafeEqual);
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.all("/gmail", internalOnly, (_req, res) => {
    res.status(200).json({ served: true });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

describe("a mount behind the middleware", () => {
  let gated: { url: string; server: Server };
  let tokenless: { url: string; server: Server };

  beforeAll(async () => {
    gated = await serve({ STRAD_INTERNAL_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    tokenless = await serve({} as NodeJS.ProcessEnv);
  });

  afterAll(() => {
    gated.server.close();
    tokenless.server.close();
  });

  it("serves a POST that carries the token", async () => {
    const res = await fetch(`${gated.url}/gmail`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ served: true });
  });

  it("answers 401 and serves nothing when the token is absent", async () => {
    const res = await fetch(`${gated.url}/gmail`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid internal token" });
  });

  it("answers 401 to a wrong token", async () => {
    const res = await fetch(`${gated.url}/gmail`, {
      method: "POST",
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  // The refusal outlives nothing. A cached 401 would survive the redeploy that
  // fixed the token, which is the same reason the presence route is `no-store`.
  it("never lets a refusal be cached", async () => {
    const res = await fetch(`${gated.url}/gmail`, { method: "POST" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("gates every method the mounts register, not just POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${gated.url}/gmail`, { method });
      expect(res.status).toBe(401);
    }
  });

  it("serves nothing at all when the host holds no token", async () => {
    const res = await fetch(`${tokenless.url}/gmail`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });

  // App Platform's health prober holds no credential. Gating /healthz would
  // take the component out of service — an authorization fix that costs
  // availability, which is the one way to get this wrong in the other
  // direction.
  it("leaves /healthz reachable with no token, on both hosts", async () => {
    for (const host of [gated, tokenless]) {
      const res = await fetch(`${host.url}/healthz`);
      expect(res.status).toBe(200);
    }
  });
});
