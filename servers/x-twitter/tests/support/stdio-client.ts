import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface TestMCPClientOptions {
  serverPath: string;
  env?: Record<string, string>;
  cwd?: string;
}

export class TestMCPClient {
  private readonly options: TestMCPClientOptions;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(options: TestMCPClientOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.client = new Client(
      { name: "x-twitter-test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.options.serverPath],
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.env ?? {}),
      } as Record<string, string>,
      stderr: "pipe",
    });
    await this.client.connect(this.transport);
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }

  async listTools() {
    return this.requireClient().listTools();
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return this.requireClient().callTool({ name, arguments: args });
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error("TestMCPClient is not connected");
    }
    return this.client;
  }
}
