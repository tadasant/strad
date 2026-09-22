import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HelperClient,
  HelperError,
  type HelperEvent,
} from "../src/native/client.js";
import {
  helperBinaryCandidates,
  helperConnector,
  helperSocketPath,
} from "../src/native/transport.js";
import { FakeHelper } from "./fake-ax.js";
import { testConfig, tmpState } from "./helpers.js";

describe("the helper client", () => {
  it("matches answers to requests by id and surfaces the helper's error codes", async () => {
    const fake = new FakeHelper();
    const client = new HelperClient({
      connect: fake.transport,
      requestTimeoutMs: 2000,
    });
    const [hello, apps] = await Promise.all([
      client.hello(),
      client.call<{ apps: unknown[] }>("list_apps"),
    ]);
    expect(hello.version).toBe("fake");
    expect(apps.apps).toHaveLength(1);
    await expect(
      client.call("ax_perform", { element: "e9", action: "press" }),
    ).rejects.toMatchObject({
      code: "unknown_element",
    });
    expect(fake.connections).toBe(1);
    client.close();
  });

  it("reconnects on the next call after the helper drops, and fails the calls in flight", async () => {
    const fake = new FakeHelper();
    const client = new HelperClient({
      connect: fake.transport,
      requestTimeoutMs: 2000,
    });
    await client.hello();
    expect(client.connected).toBe(true);
    // A call in flight when the helper dies is refused, not hung.
    const inFlight = client.call("list_apps");
    fake.drop();
    await expect(inFlight).rejects.toMatchObject({ code: "disconnected" });
    expect(client.connected).toBe(false);
    expect(fake.connections).toBe(0);
    // The next call opens a fresh connection on its own.
    await client.hello();
    expect(client.connected).toBe(true);
    expect(fake.connections).toBe(1);
    client.close();
  });

  it("times out a request the helper never answers", async () => {
    let hang = true;
    const fake = new FakeHelper();
    const client = new HelperClient({
      connect: async () => {
        const s = await fake.transport();
        if (hang) {
          // Swallow the request instead of answering it.
          const write = s.write.bind(s);
          s.write = ((chunk: unknown, ...rest: unknown[]) => {
            const cb = rest.find((r) => typeof r === "function") as
              ((e?: Error) => void) | undefined;
            cb?.();
            return true;
          }) as typeof s.write;
          void write;
        }
        return s;
      },
      requestTimeoutMs: 150,
    });
    await expect(client.hello()).rejects.toBeInstanceOf(HelperError);
    hang = false;
    client.close();
  });

  it("hands events (banner buttons) to the daemon", async () => {
    const fake = new FakeHelper();
    const events: HelperEvent[] = [];
    const client = new HelperClient({
      connect: fake.transport,
      requestTimeoutMs: 2000,
      onEvent: (e) => events.push(e),
    });
    await client.hello();
    fake.emit({ event: "kill", grant_id: "g_1" });
    fake.emit({ event: "disable" });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([
      { event: "kill", grant_id: "g_1" },
      { event: "disable" },
    ]);
    client.close();
  });

  it("reports the reason it could not connect, and does not crash", async () => {
    const fake = new FakeHelper({ fail: "no socket, no binary" });
    const client = new HelperClient({
      connect: fake.transport,
      requestTimeoutMs: 2000,
    });
    await expect(client.hello()).rejects.toThrow(/no socket, no binary/);
    expect(client.connected).toBe(false);
    expect(client.error).toBe("no socket, no binary");
  });
});

describe("the transport: socket, else spawn", () => {
  it("names where it looks, in order, and defaults the socket to the state directory", () => {
    const dir = tmpState();
    const config = testConfig({ native: { binary: "/opt/ax" } });
    expect(helperSocketPath(config, dir)).toBe(join(dir, "ax.sock"));
    const candidates = helperBinaryCandidates(config, dir);
    expect(candidates[0]).toBe("/opt/ax");
    expect(candidates).toContain(join(dir, "bin", "strad-hostd-ax"));
    expect(candidates[candidates.length - 1]).toBe("strad-hostd-ax");
  });

  it("spawns the binary over stdio when there is no socket, and ends the child with the stream", async () => {
    const dir = tmpState();
    // A shim that runs the fake helper under node, in place of the Swift binary.
    const shim = join(dir, "strad-hostd-ax");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${join(process.cwd(), "test", "fake-ax-child.mjs")}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const logs: string[] = [];
    const client = new HelperClient({
      connect: helperConnector(
        testConfig({ native: { binary: shim } }),
        dir,
        (l) => logs.push(l),
      ),
      requestTimeoutMs: 5000,
    });
    const hello = await client.hello();
    expect(hello.version).toBe("fake-child");
    expect(hello.trusted).toEqual({
      accessibility: true,
      screen_recording: false,
    });
    // The child exiting is a disconnect the next call recovers from.
    await expect(client.call("crash")).rejects.toMatchObject({
      code: "disconnected",
    });
    expect(client.connected).toBe(false);
    expect((await client.hello()).version).toBe("fake-child");
    client.close();
    expect(logs.some((l) => l.includes("fake-ax started"))).toBe(true);
  });

  it("says what is missing when neither a socket nor a binary exists", async () => {
    const dir = tmpState();
    const client = new HelperClient({
      connect: helperConnector(
        testConfig({ native: { binary: join(dir, "nope") } }),
        dir,
      ),
      requestTimeoutMs: 1000,
    });
    await expect(client.hello()).rejects.toThrow(/not installed.*swift build/s);
  });
});
