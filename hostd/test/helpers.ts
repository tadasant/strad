import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { ConfigSchema, type Config } from "../src/config.js";
import type {
  PromptAnswer,
  Prompter,
  PromptRequest,
} from "../src/consent/prompter.js";

export const SHELL_KEY = "shell-key-0123456789abcdef0123456789abcdef";
export const BROWSER_KEY = "browser-key-0123456789abcdef0123456789abcd";

export function tmpState(): string {
  return mkdtempSync(join(tmpdir(), "hostd-test-"));
}

export function testConfig(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    machine: "Test Mac",
    capabilities: {
      shell: { enabled: true, key: SHELL_KEY, displayName: "shell-test-mbp" },
      browser: {
        enabled: true,
        key: BROWSER_KEY,
        displayName: "browser-use-test-mbp-headless",
      },
    },
    shell: { shell: "/bin/sh", defaultCwd: tmpdir() },
    ...over,
  });
}

/** A prompter that answers from a script and remembers what it was shown. */
export class ScriptedPrompter implements Prompter {
  readonly seen: PromptRequest[] = [];
  constructor(
    public answer: PromptAnswer | (() => Promise<PromptAnswer>) = "allowed",
  ) {}
  async prompt(req: PromptRequest): Promise<PromptAnswer> {
    this.seen.push(req);
    return typeof this.answer === "function" ? this.answer() : this.answer;
  }
}

export async function connect(
  port: number,
  path: string,
  key?: string,
): Promise<Client> {
  const client = new Client({ name: "hostd-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}${path}`),
      {
        requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : {},
      },
    ),
  );
  return client;
}

export function resultText(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] })
    .content;
  return content.map((c) => c.text ?? "").join("\n");
}

export function resultJson<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(resultText(result)) as T;
}
