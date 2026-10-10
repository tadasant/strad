import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkerRunner } from "../src/jobs.js";
import { DEFAULT_LIMITS, type Limits } from "../src/limits.js";
import { createMCPServer, type ImageServerKind } from "../src/server.js";
import { DESCRIPTION_BUDGET } from "../src/tools/shared.js";
import {
  body,
  png,
  rect,
  serve,
  texture,
  WHITE,
  type Fixture,
} from "./fixtures.js";

/**
 * The servers as an agent meets them: a real MCP client, the real guarded
 * fetch against a loopback fixture (reached through the operator allowlist),
 * and the REAL worker thread — `build/worker.js`, which `npm test` builds first.
 */

const WORKER = new URL("../build/worker.js", import.meta.url);
const ENV = { IMAGE_TOOLS_ALLOW_PRIVATE_HOSTS: "127.0.0.1" };

let fx: Fixture;

async function connect(kind: ImageServerKind, limits: Partial<Limits> = {}) {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  const { server, registerHandlers } = createMCPServer(kind, {
    version: "test",
    env: ENV,
    limits,
    runJob: createWorkerRunner({ limits: merged, workerUrl: WORKER }),
  });
  await registerHandlers(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Result = {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
};

beforeAll(async () => {
  const scene = await png(320, 240, texture);
  fx = await serve({
    "/mock.png": body(await png(200, 100, () => WHITE)),
    "/actual.png": body(
      await png(200, 100, rect(40, 30, 50, 20, [255, 0, 0, 255])),
    ),
    "/scene.png": body(scene),
    "/logo.png": body(
      await sharp(await png(64, 64, rect(16, 16, 32, 32)))
        .removeAlpha()
        .png()
        .toBuffer(),
    ),
    "/noise.png": body(await png(1000, 1000, texture)),
  });
});

afterAll(() => fx.close());

describe("tools/list", () => {
  it.each([
    ["image-diff", "get_diff_of_images"],
    ["svg-tracer", "trace_bitmap_to_svg"],
  ] as const)(
    "%s serves exactly %s, read-only, within the description budget",
    async (kind, name) => {
      const client = await connect(kind);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([name]);
      expect(tools[0]!.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(tools[0]!.description!.length).toBeLessThanOrEqual(
        DESCRIPTION_BUDGET,
      );
      for (const p of Object.values(tools[0]!.inputSchema.properties ?? {})) {
        expect((p as { description?: string }).description).toBeTruthy();
      }
    },
  );
});

describe("get_diff_of_images", () => {
  it("returns the JSON and the composite inline", async () => {
    const client = await connect("image-diff");
    const r = (await client.callTool({
      name: "get_diff_of_images",
      arguments: {
        source_image_url: fx.url("/mock.png"),
        target_image_url: fx.url("/actual.png"),
      },
    })) as Result;
    expect(r.isError).toBeFalsy();
    const json = JSON.parse(r.content[0]!.text!);
    expect(json.clusters[0]).toMatchObject({
      left: 40,
      top: 30,
      width: 50,
      height: 20,
    });
    expect(r.content[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    const meta = await sharp(
      Buffer.from(r.content[1]!.data!, "base64"),
    ).metadata();
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  it("aligns a crop against its scene through the worker", async () => {
    const client = await connect("image-diff");
    const crop = await sharp(await png(320, 240, texture))
      .extract({ left: 50, top: 40, width: 100, height: 60 })
      .png()
      .toBuffer();
    const cropFx = await serve({ "/crop.png": body(crop) });
    try {
      const r = (await client.callTool({
        name: "get_diff_of_images",
        arguments: {
          source_image_url: fx.url("/scene.png"),
          target_image_url: cropFx.url("/crop.png"),
        },
      })) as Result;
      const json = JSON.parse(r.content[0]!.text!);
      expect(json.alignment).toMatchObject({ x: 50, y: 40 });
      expect(json.identical).toBe(true);
      expect(r.content).toHaveLength(1);
    } finally {
      await cropFx.close();
    }
  });

  it("answers the npx package's path arguments with how to migrate", async () => {
    const client = await connect("image-diff");
    const r = (await client.callTool({
      name: "get_diff_of_images",
      arguments: { source_image: "/tmp/a.png", target_image: "/tmp/b.png" },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/local file path.*source_image_url/);
  });

  it("refuses a private address", async () => {
    const client = await connect("image-diff");
    const r = (await client.callTool({
      name: "get_diff_of_images",
      arguments: {
        source_image_url: "http://169.254.169.254/latest/meta-data/",
        target_image_url: fx.url("/mock.png"),
      },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(
      /^source_image_url: Refusing.*link-local/,
    );
  });

  it("validates arguments with a sentence", async () => {
    const client = await connect("image-diff");
    const r = (await client.callTool({
      name: "get_diff_of_images",
      arguments: {
        source_image_url: fx.url("/mock.png"),
        target_image_url: fx.url("/mock.png"),
        threshold: 3,
      },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/threshold/);
  });

  it("stops a job past its deadline by terminating the worker", async () => {
    const client = await connect("image-diff", { jobTimeoutMs: 50 });
    const r = (await client.callTool({
      name: "get_diff_of_images",
      arguments: {
        source_image_url: fx.url("/noise.png"),
        target_image_url: fx.url("/mock.png"),
      },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/took longer than .* was stopped/);
  });

  it("admits one job at a time, and refuses a caller as busy once its queue wait is spent", async () => {
    const client = await connect("image-diff", { queueTimeoutMs: 100 });
    const args = {
      source_image_url: fx.url("/noise.png"),
      target_image_url: fx.url("/noise.png"),
    };
    const results = (await Promise.all([
      client.callTool({ name: "get_diff_of_images", arguments: args }),
      client.callTool({ name: "get_diff_of_images", arguments: args }),
    ])) as Result[];
    const texts = results.map((r) => r.content[0]!.text!);
    expect(texts.filter((t) => /^Busy/.test(t))).toHaveLength(1);
    expect(texts.filter((t) => /"identical": true/.test(t))).toHaveLength(1);
  });
});

describe("trace_bitmap_to_svg", () => {
  it("returns the SVG inline", async () => {
    const client = await connect("svg-tracer");
    const r = (await client.callTool({
      name: "trace_bitmap_to_svg",
      arguments: {
        image_url: fx.url("/logo.png"),
        target_width: 32,
        target_height: 32,
      },
    })) as Result;
    expect(r.isError).toBeFalsy();
    const json = JSON.parse(r.content[0]!.text!);
    expect(json).toMatchObject({
      width: 32,
      height: 32,
      originalWidth: 64,
      preprocessed: false,
    });
    expect(json.svg).toMatch(/^<svg[^>]*viewBox="0 0 32 32"/);
    expect(json.svgLength).toBe(json.svg.length);
  });

  it("answers input_path / output_path with how to migrate", async () => {
    const client = await connect("svg-tracer");
    const r = (await client.callTool({
      name: "trace_bitmap_to_svg",
      arguments: { input_path: "/tmp/logo.png" },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/image_url/);
  });

  it("refuses an SVG over the inline limit with a way to simplify", async () => {
    const client = await connect("svg-tracer", { maxSvgChars: 50 });
    const r = (await client.callTool({
      name: "trace_bitmap_to_svg",
      arguments: { image_url: fx.url("/logo.png") },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/turd_size/);
  });

  it("rejects a malformed color", async () => {
    const client = await connect("svg-tracer");
    const r = (await client.callTool({
      name: "trace_bitmap_to_svg",
      arguments: { image_url: fx.url("/logo.png"), color: "red" },
    })) as Result;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/color: must be a hex color/);
  });
});

describe("the worker runner", () => {
  const base = { ...DEFAULT_LIMITS };
  const opts = {
    maxImageEdge: base.maxImageEdge,
    maxPixels: base.maxPixels,
    returnImages: "none" as const,
  };
  let heavy: { source: Buffer; target: Buffer };
  beforeAll(async () => {
    heavy = {
      source: await png(1500, 1500, texture),
      target: await png(1500, 1500, (x, y) => texture(y, x)),
    };
  });
  const heavyJob = () => ({ kind: "diff" as const, ...heavy, options: opts });
  const tinyJob = async () => ({
    kind: "trace" as const,
    input: await png(16, 16, rect(4, 4, 8, 8)),
    options: { maxPixels: base.maxPixels },
  });

  it("diffs millions of isolated components without running the worker out of heap", async () => {
    const run = createWorkerRunner({
      limits: { ...base, jobTimeoutMs: 120_000 },
      workerUrl: WORKER,
    });
    const white = await png(3000, 3000, () => WHITE);
    const dots = await png(3000, 3000, (x, y) =>
      x % 2 === 0 && y % 2 === 0 ? [0, 0, 0, 255] : WHITE,
    );
    const out = await run({
      kind: "diff",
      source: white,
      target: dots,
      options: { ...opts, minClusterSize: 1, clusterGap: 0 },
    });
    if (out.kind !== "diff") throw new Error("wrong job");
    expect(out.result.summary.diffPixels).toBe(1500 * 1500);
    expect(out.result.clustering.droppedClusters).toBeGreaterThan(2_000_000);
  }, 180_000);

  it("refuses at once past the queue cap, instead of holding another caller's bytes", async () => {
    const run = createWorkerRunner({
      limits: { ...base, maxQueuedJobs: 0 },
      workerUrl: WORKER,
    });
    const first = run(heavyJob());
    await expect(run(await tinyJob())).rejects.toThrow(
      /^Busy: an image job is running/,
    );
    await first;
  });

  it("lets a cancelled caller leave the queue", async () => {
    const run = createWorkerRunner({ limits: base, workerUrl: WORKER });
    const first = run(heavyJob());
    const controller = new AbortController();
    const second = run(await tinyJob(), controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow(/cancelled/);
    await first;
  });

  it("stops a cancelled job's worker and frees the slot for the next caller", async () => {
    const run = createWorkerRunner({ limits: base, workerUrl: WORKER });
    const controller = new AbortController();
    const first = run(heavyJob(), controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(first).rejects.toThrow(/cancelled/);
    const next = await run(await tinyJob());
    expect(next.kind).toBe("trace");
  });
});
