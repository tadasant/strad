import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchImage, ImageInputError } from "../src/fetch-image.js";
import { DEFAULT_LIMITS, type Limits } from "../src/limits.js";
import {
  createGuardedDispatcher,
  parseAllowedHosts,
} from "../src/url-guard.js";
import { body, png, rect, serve, WHITE, type Fixture } from "./fixtures.js";

const allowed = parseAllowedHosts("127.0.0.1");
const dispatcher = createGuardedDispatcher({ allowed });

let fx: Fixture;
let small: Buffer;

function get(path: string, limits: Partial<Limits> = {}) {
  return fetchImage(fx.url(path), {
    limits: { ...DEFAULT_LIMITS, ...limits },
    dispatcher,
    allowed,
    label: "image_url",
  });
}

beforeAll(async () => {
  small = await png(20, 10, rect(2, 2, 5, 5));
  const huge = await png(4000, 3000, () => WHITE); // 12MP, a few KB compressed
  const avif = await sharp(small).avif().toBuffer();
  fx = await serve({
    "/ok.png": body(small),
    "/photo.avif": body(avif, "image/avif"),
    "/not-modified": (_req, res) => {
      res.statusCode = 304;
      res.setHeader("location", "/ok.png");
      res.end();
    },
    "/huge.png": body(huge),
    "/text": body(Buffer.from("hello"), "text/plain"),
    "/vector.svg": body(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      ),
      "image/svg+xml",
    ),
    "/redirect": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/ok.png");
      res.end();
    },
    "/to-file": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "file:///etc/passwd");
      res.end();
    },
    "/to-private": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `http://127.0.0.2:${fx.port}/ok.png`);
      res.end();
    },
    "/loop": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/loop");
      res.end();
    },
    "/forbidden": (_req, res) => {
      res.statusCode = 403;
      res.end("<Error><Code>AccessDenied</Code></Error>");
    },
    "/declared-big": (_req, res) => {
      res.setHeader("content-length", String(DEFAULT_LIMITS.maxBytes + 1));
      res.flushHeaders();
      res.destroy();
    },
    "/streamed-big": (_req, res) => {
      // No content-length: the cap has to hold while streaming.
      res.write(Buffer.alloc(64 * 1024));
      res.write(Buffer.alloc(64 * 1024));
      res.end(Buffer.alloc(64 * 1024));
    },
    "/hang": () => {
      /* never answers */
    },
  });
});

afterAll(async () => {
  await fx.close();
  await dispatcher.close();
});

describe("fetchImage", () => {
  it("fetches an image and reads its header", async () => {
    const img = await get("/ok.png");
    expect(img).toMatchObject({ format: "png", width: 20, height: 10 });
    expect(Buffer.from(img.bytes).equals(small)).toBe(true);
  });

  it("accepts AVIF, which sharp reports as heif/av1", async () => {
    expect(await get("/photo.avif")).toMatchObject({
      format: "avif",
      width: 20,
      height: 10,
    });
  });

  it("does not follow a 304, Location or not", async () => {
    await expect(get("/not-modified")).rejects.toThrow(/HTTP 304/);
  });

  it("follows a redirect", async () => {
    expect((await get("/redirect")).width).toBe(20);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    await expect(get("/to-file")).rejects.toThrow(/http and https only/);
  });

  it("refuses a redirect into a private address the allowlist does not name", async () => {
    await expect(get("/to-private")).rejects.toThrow(
      /127\.0\.0\.2 is a loopback address/,
    );
  });

  it("caps redirects", async () => {
    await expect(get("/loop")).rejects.toThrow(/more than 5 redirects/);
  });

  it("explains a 403 as a likely expired link, without quoting the query", async () => {
    const err = await fetchImage(
      fx.url("/forbidden") + "?X-Goog-Signature=SECRET",
      {
        limits: DEFAULT_LIMITS,
        dispatcher,
        allowed,
        label: "image_url",
      },
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ImageInputError);
    expect(err.message).toMatch(/HTTP 403.*refresh_link/);
    expect(err.message).not.toContain("SECRET");
  });

  it("refuses an oversized body by its declared length", async () => {
    await expect(get("/declared-big")).rejects.toThrow(/limit is 25\.0MB/);
  });

  it("refuses an oversized body while streaming it", async () => {
    await expect(
      get("/streamed-big", { maxBytes: 100 * 1024 }),
    ).rejects.toThrow(/larger than the 0\.1MB limit/);
  });

  it("refuses an image over the pixel limit from its header, before decoding", async () => {
    await expect(get("/huge.png")).rejects.toThrow(
      /4000x3000 .*Crop or downscale/,
    );
  });

  it("refuses what is not a bitmap", async () => {
    await expect(get("/text")).rejects.toThrow(/not an image/);
    await expect(get("/vector.svg")).rejects.toThrow(/svg is not accepted/);
  });

  it("times out", async () => {
    await expect(get("/hang", { fetchTimeoutMs: 300 })).rejects.toThrow(
      /took longer than 0\.3s/,
    );
  });

  it("refuses loopback when the operator has not allowed it", async () => {
    const strict = createGuardedDispatcher();
    await expect(
      fetchImage(fx.url("/ok.png"), {
        limits: DEFAULT_LIMITS,
        dispatcher: strict,
        allowed: new Set(),
        label: "x",
      }),
    ).rejects.toThrow(/loopback/);
    await strict.close();
  });
});
