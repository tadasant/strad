/**
 * The harness every server-level suite shares: a REAL MCP client over an
 * in-memory transport, a fake socket, an in-memory GCS, and fast timers.
 */
import { afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMCPServer, MemoryBlobStore, type WhatsAppConfig } from "../src/index.js";
import type { BridgeOptions } from "../src/bridge.js";
import { fakeWhatsApp, waitFor, type FakeWhatsApp } from "./fake-socket.js";

export const NOW = 1_790_000_000;
export const clock = () => NOW * 1000;

export function config(key = randomBytes(32)): WhatsAppConfig {
  return {
    encryptionKey: key,
    bucket: "test-bucket",
    clientEmail: "bridge@example.iam.gserviceaccount.com",
    privateKey: "unused",
    prefix: "whatsapp",
    bufferMaxMessages: 1000,
    bufferMaxAgeDays: 30,
  };
}

export const FAST_PACING = {
  minGapMs: 0,
  perMinute: 3,
  perHour: 60,
  typingBaseMs: 0,
  typingPerCharMs: 0,
  typingMaxMs: 0,
};

export const open: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

export async function connect(
  options: {
    blobs?: MemoryBlobStore;
    fake?: FakeWhatsApp;
    cfg?: WhatsAppConfig;
    env?: NodeJS.ProcessEnv;
    clock?: () => number;
    bridgeOptions?: Partial<BridgeOptions>;
  } = {},
) {
  const blobs = options.blobs ?? new MemoryBlobStore();
  const fake = options.fake ?? fakeWhatsApp(clock);
  const created = createMCPServer({
    version: "test",
    ...(options.env ? { env: options.env } : { config: options.cfg ?? config() }),
    blobs,
    socketFactory: fake.factory,
    bridgeOptions: {
      clock: options.clock ?? clock,
      sleep: async () => {},
      pacing: FAST_PACING,
      flushDelayMs: 1,
      reconnectBaseMs: 1,
      replacedDelayMs: 1,
      pairingReadyTimeoutMs: 500,
      ...options.bridgeOptions,
    },
  });
  await created.registerHandlers(created.server);
  const mcp = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(clientTransport), created.server.connect(serverTransport)]);
  const close = async () => {
    await created.close();
    await mcp.close();
    await created.server.close();
  };
  open.push(close);
  return { mcp, blobs, fake, created, close };
}

export async function call(mcp: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await mcp.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const text = res.content[0]?.text ?? "";
  const images = res.content.filter((c) => c.type === "image") as unknown as {
    data: string;
    mimeType: string;
  }[];
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: res.isError === true, text, json, structured: res.structuredContent, images };
}

/** Pair through the tool, and have the phone accept the code. */
export async function pairAndConnect(mcp: Client, fake: FakeWhatsApp) {
  const pairing = call(mcp, "whatsapp_pair", { phone_number: "15550000001" });
  await waitFor(() => fake.sockets.length === 1);
  fake.latest().offerPairing();
  const result = await pairing;
  const first = fake.latest();
  first.acceptPairing();
  first.close(515); // WhatsApp asks for a fresh stream after pair-success
  await waitFor(() => fake.sockets.length === 2);
  fake.latest().open();
  await waitFor(async () => (await call(mcp, "whatsapp_status")).json?.connected === true);
  return result;
}

