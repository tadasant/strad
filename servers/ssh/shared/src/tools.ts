/**
 * FIVE TOOLS, NAMED AS THE UPSTREAM NAMED THEM.
 *
 * This server replaces `ssh-agent-mcp-server` in five catalog entries, so the
 * names, the argument names and the result shapes are that package's wherever
 * they still mean something. Two could not keep their meaning:
 *
 *   ssh_download / ssh_upload took a `localPath` — a file on the machine the
 *   server ran on, which was the user's laptop. Here that machine is a shared
 *   container nobody can open, so a local path would be a file nobody can reach.
 *   The bytes travel in the tool call instead: download RETURNS the content,
 *   upload TAKES it. A call that still passes `localPath` gets an error saying
 *   so, rather than a success that wrote to a disk the caller cannot see.
 *
 * BREAK-GLASS, NOT ROUTINE. These are diagnosis and emergency tools. strad's
 * production invariant is that products run without box access, so a task that
 * keeps reaching for `ssh_execute` is a missing API, deploy step or workflow —
 * and the descriptions say that to the agent reading them.
 *
 * THE GROUPS ARE NOT THE ENFORCEMENT IN strad. The bundle runs every server at
 * full capability and the gateway's per-slug `tools:` policy decides what a slug
 * may call. The groups are the upstream's (`readonly`, `write`, `admin`), kept so
 * this server means the same thing outside strad, and so a policy can be written
 * from them.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_EXEC_WALL_MS,
  MAX_TRANSFER_BYTES,
  OUTPUT_HEAD_BYTES,
  OUTPUT_TAIL_BYTES,
  type Connector,
  type SshSession,
  SshConnectError,
} from "./client.js";
import { HOW_TO_SEED, missingCredentials, type SshConfig } from "./config.js";
import { ConfigError, HostKeyMismatchError, InputError, SshUnreachableError } from "./errors.js";
import { describePins } from "./host-key.js";
import { log, redact } from "./logging.js";

export type ToolGroup = "readonly" | "write" | "admin";

const ALL_GROUPS: ToolGroup[] = ["readonly", "write", "admin"];

/**
 * FAILS CLOSED. Unset is the full surface (the bundle's posture). Set and
 * unrecognised means somebody tried to narrow a shell on a production host and
 * mistyped it, and the safe reading of that is `readonly`, not everything.
 */
export function parseToolGroups(raw?: string): ToolGroup[] {
  if (!raw) return ALL_GROUPS;
  const valid = raw
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter((g): g is ToolGroup => ALL_GROUPS.includes(g as ToolGroup));
  return valid.length > 0 ? valid : ["readonly"];
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations: Record<string, boolean | string>;
  handler: (args: unknown) => Promise<ToolResult>;
}

export interface ToolContext {
  /** The strad slug this instance serves, for errors and connection info. */
  label: string;
  /** Read per call, so a value seeded after boot is used without a restart. */
  config: () => SshConfig;
  env: () => NodeJS.ProcessEnv;
  connector: Connector;
}

const BREAK_GLASS =
  "Break-glass: for diagnosis and emergencies on this one host, not routine " +
  "operation. If a task needs this repeatedly, the missing piece is an API, a " +
  "deploy step or a workflow. A host that does not answer (often: spun down " +
  "on purpose) fails the call with an UNREACHABLE message; bring it up, then " +
  "ssh_check_connection.";

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function failText(text: string, ctx: ToolContext): ToolResult {
  let secrets: Array<string | undefined> = [];
  try {
    const env = ctx.env();
    secrets = [env.SSH_PRIVATE_KEY, env.SSH_PASSPHRASE];
  } catch {
    // nothing to scrub beyond the PEM pattern
  }
  return { content: [{ type: "text", text: redact(text, secrets) }], isError: true };
}

/** The one error path. Each class has a different next move, and the text says which. */
function fail(err: unknown, ctx: ToolContext): ToolResult {
  if (err instanceof ConfigError) {
    return failText(`Not configured (${ctx.label}): ${err.message}`, ctx);
  }
  if (err instanceof HostKeyMismatchError) {
    log(ctx.label, `host key mismatch: presented ${err.presented.fingerprint}`);
    return failText(err.message, ctx);
  }
  if (err instanceof SshUnreachableError) {
    return failText(`${ctx.label}: ${err.message}`, ctx);
  }
  if (err instanceof InputError || err instanceof SshConnectError) {
    return failText(err.message, ctx);
  }
  const e = err as Error & { code?: unknown };
  // SFTP status errors carry a numeric code and a short message ("No such
  // file", "Permission denied") that is already the answer.
  const message = e instanceof Error ? e.message : String(err);
  return failText(typeof e?.code === "number" ? `SFTP: ${message}` : message, ctx);
}

async function withSession<T>(
  ctx: ToolContext,
  run: (session: SshSession, config: SshConfig) => Promise<T>,
): Promise<T> {
  const config = ctx.config();
  const session = await ctx.connector(config);
  try {
    return await run(session, config);
  } finally {
    session.close();
  }
}

function asObject(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new InputError("Arguments must be an object.");
  }
  return args as Record<string, unknown>;
}

function str(args: Record<string, unknown>, name: string, required: true): string;
function str(args: Record<string, unknown>, name: string, required: false): string | undefined;
function str(args: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") {
    if (required) throw new InputError(`${name} is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new InputError(`${name} must be a string.`);
  return v;
}

function int(
  args: Record<string, unknown>,
  name: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new InputError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function refuseLocalPath(args: Record<string, unknown>, tool: string, instead: string): void {
  if (args.localPath === undefined) return;
  throw new InputError(
    `${tool} does not take localPath here: this server runs inside strad, so a ` +
      `"local" path would be a file in a shared container that you cannot open. ` +
      instead,
  );
}

// ---------------------------------------------------------------------------

function connectionInfoTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "ssh_connection_info",
    description:
      `Show which host this SSH server targets and how it is configured, without ` +
      `exposing the key. Optionally test the connection.\n\n` +
      `Returns JSON: slug, host, port, username, the private key's TYPE (never the ` +
      `key), the pinned host-key fingerprints, and any missing settings. With ` +
      `test_connection: true it also connects, verifies the host key against the ` +
      `pin, authenticates and disconnects, reporting the key the host presented.\n\n` +
      `Use it first, to confirm you are about to act on the machine you mean.`,
    inputSchema: {
      type: "object",
      properties: {
        test_connection: {
          type: "boolean",
          description:
            "Connect and authenticate, then disconnect. Runs no command. Default false.",
        },
      },
    },
    annotations: { title: "SSH connection info", readOnlyHint: true, openWorldHint: true },
    handler: async (raw) => {
      try {
        const args = asObject(raw);
        const test = args.test_connection === true || args.test_connection === "true";
        const missing = missingCredentials(ctx.env());
        if (missing.length > 0) {
          return ok({
            slug: ctx.label,
            configured: false,
            missing,
            how_to_fix: HOW_TO_SEED,
          });
        }
        const config = ctx.config();
        const info: Record<string, unknown> = {
          slug: ctx.label,
          configured: true,
          host: config.host,
          port: config.port,
          username: config.username,
          authentication: {
            method: "private key from strad's store",
            key_type: config.keyType,
            encrypted: config.passphrase !== undefined,
          },
          host_key_checking: "strict: only the pinned key is accepted",
          pinned_host_keys: describePins(config.hostKeyPins),
          connect_timeout_ms: config.connectTimeoutMs,
          command_timeout_ms: config.commandTimeoutMs,
        };
        if (test) info.connection = await checkConnection(ctx);
        return ok(info);
      } catch (err) {
        return fail(err, ctx);
      }
    },
  };
}

/**
 * What a connection attempt found, as a status an agent can branch on.
 *
 * Every status but `ok` names its own next move, and they do not overlap:
 * `unreachable` is the one fixed by bringing the host up and calling this
 * again; `host_key_mismatch` is never retried; `not_configured` and
 * `auth_rejected` are fixed in the store or on the host, not by waiting.
 */
type ConnectionCheck =
  | { ok: true; status: "ok"; host_key_presented: { type: string | null; fingerprint: string }; elapsed_ms: number }
  | {
      ok: false;
      status: "unreachable" | "host_key_mismatch" | "not_configured" | "connect_failed";
      elapsed_ms: number;
      error: string;
      next_step: string;
    };

async function checkConnection(ctx: ToolContext): Promise<ConnectionCheck> {
  const started = Date.now();
  try {
    const presented = await withSession(ctx, async (s) => s.hostKey);
    return { ok: true, status: "ok", host_key_presented: presented, elapsed_ms: Date.now() - started };
  } catch (err) {
    const elapsed_ms = Date.now() - started;
    const error = fail(err, ctx).content[0]!.text;
    if (err instanceof SshUnreachableError) {
      return {
        ok: false,
        status: "unreachable",
        elapsed_ms,
        error,
        next_step: "Bring the host up, then call ssh_check_connection again.",
      };
    }
    if (err instanceof HostKeyMismatchError) {
      return {
        ok: false,
        status: "host_key_mismatch",
        elapsed_ms,
        error,
        next_step: "Do not retry. A human verifies the host's key out of band and re-seeds SSH_HOST_KEY.",
      };
    }
    if (err instanceof ConfigError) {
      return {
        ok: false,
        status: "not_configured",
        elapsed_ms,
        error,
        next_step: "A human seeds the named parameters in strad's store; retrying does not help.",
      };
    }
    return {
      ok: false,
      status: "connect_failed",
      elapsed_ms,
      error,
      next_step: "The host answered but the login failed; the error says what to fix on the host.",
    };
  }
}

function checkConnectionTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "ssh_check_connection",
    description:
      `Try to reach this host now: connect, verify its host key against the pin, ` +
      `log in, and disconnect. Runs no command.\n\n` +
      `Call it after bringing a powered-off or spun-down host back up, or ` +
      `whenever another ssh_ tool reported the host UNREACHABLE. It is the retry: ` +
      `once it reports ok, every other tool works on its next call, in this same ` +
      `session, with nothing to reconnect.\n\n` +
      `Returns JSON: { ok, status ("ok" | "unreachable" | "host_key_mismatch" | ` +
      `"not_configured" | "connect_failed"), host_key_presented (on ok), ` +
      `elapsed_ms, error and next_step (otherwise) }. Only "unreachable" is fixed ` +
      `by waiting for or starting the host; "host_key_mismatch" must never be retried.`,
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Check SSH connection", readOnlyHint: true, openWorldHint: true },
    handler: async () => ok({ slug: ctx.label, ...(await checkConnection(ctx)) }),
  };
}

function listDirectoryTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "ssh_list_directory",
    description:
      `List a directory on the remote host over SFTP.\n\n` +
      `Returns JSON: { path, total, truncated, entries: [{ name, type ` +
      `("directory" | "file" | "symlink" | "other"), size, permissions ` +
      `("drwxr-xr-x"), modified (ISO 8601) }] }, sorted by name, at most ` +
      `${MAX_DIRECTORY_ENTRIES} entries.\n\n${BREAK_GLASS}`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'Directory on the remote host. Example: "/var/log".',
        },
      },
      required: ["path"],
    },
    annotations: { title: "List remote directory", readOnlyHint: true, openWorldHint: true },
    handler: async (raw) => {
      try {
        const args = asObject(raw);
        const path = str(args, "path", true);
        return await withSession(ctx, async (s) => {
          const { entries, total } = await s.listDirectory(path);
          return ok({ path, total, truncated: total > entries.length, entries });
        });
      } catch (err) {
        return fail(err, ctx);
      }
    },
  };
}

const DEFAULT_DOWNLOAD_BYTES = 256 * 1024;

/**
 * UTF-8 when the bytes are text, base64 when they are not. Decoding in stream
 * mode holds back a multi-byte character split by the read window instead of
 * calling the whole read binary, so the next window starts on that character.
 *
 * Two cases must not hold anything back, or paging would never advance: the
 * read that reaches the END of the file (a character cut short there is not
 * text, and stays undecodable however it is paged), and a window too small to
 * hold one whole character. Both are decoded strictly instead, which in `auto`
 * falls through to base64.
 */
function encodeContent(
  data: Buffer,
  want: "auto" | "utf8" | "base64",
  atEnd: boolean,
): { encoding: "utf8" | "base64"; content: string; bytes: number } {
  if (want !== "base64") {
    try {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: !atEnd });
      if (text === "" && data.length > 0) {
        text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      }
      if (want === "utf8" || !text.includes("\u0000")) {
        return { encoding: "utf8", content: text, bytes: Buffer.byteLength(text, "utf8") };
      }
    } catch {
      if (want === "utf8") {
        throw new InputError(
          "These bytes are not valid UTF-8 (binary, a character cut off at the end of the " +
            "file, or a maxBytes smaller than one character). Call again with " +
            "encoding: \"base64\" (or \"auto\"), or a larger maxBytes.",
        );
      }
    }
  }
  return { encoding: "base64", content: data.toString("base64"), bytes: data.length };
}

function downloadTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "ssh_download",
    description:
      `Read a file from the remote host over SFTP and return its content.\n\n` +
      `Returns JSON: { remotePath, size, offset, bytes, truncated, nextOffset, ` +
      `encoding ("utf8" for text, "base64" otherwise), content }. A file larger ` +
      `than maxBytes comes back in part with truncated: true — call again with ` +
      `offset: nextOffset for the rest. To read the END of a large log, ` +
      `ssh_execute with tail is cheaper.\n\n` +
      `Unlike the npm ssh-agent-mcp-server, there is no localPath: the content is ` +
      `in the result.\n\n${BREAK_GLASS}`,
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: 'File on the remote host. Example: "/var/log/syslog".',
        },
        offset: {
          type: "integer",
          description: "Byte offset to start reading at. Default 0.",
        },
        maxBytes: {
          type: "integer",
          description: `Most bytes to return. Default ${DEFAULT_DOWNLOAD_BYTES}, at most ${MAX_TRANSFER_BYTES}.`,
        },
        encoding: {
          type: "string",
          enum: ["auto", "utf8", "base64"],
          description:
            'How to return the bytes. "auto" (default) is utf8 for text and base64 ' +
            'for anything else; "utf8" fails on binary; "base64" always encodes.',
        },
      },
      required: ["remotePath"],
    },
    annotations: { title: "Download remote file", readOnlyHint: true, openWorldHint: true },
    handler: async (raw) => {
      try {
        const args = asObject(raw);
        refuseLocalPath(args, "ssh_download", "The file's content is returned in the result instead.");
        const remotePath = str(args, "remotePath", true);
        const offset = int(args, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0;
        const maxBytes =
          int(args, "maxBytes", { min: 1, max: MAX_TRANSFER_BYTES }) ?? DEFAULT_DOWNLOAD_BYTES;
        const want = (str(args, "encoding", false) ?? "auto") as "auto" | "utf8" | "base64";
        if (!["auto", "utf8", "base64"].includes(want)) {
          throw new InputError('encoding must be "auto", "utf8" or "base64".');
        }
        return await withSession(ctx, async (s) => {
          const read = await s.readFile(remotePath, { offset, maxBytes });
          const { encoding, content, bytes } = encodeContent(
            read.data,
            want,
            offset + read.data.length >= read.size,
          );
          const end = offset + bytes;
          return ok({
            remotePath,
            size: read.size,
            offset,
            bytes,
            truncated: end < read.size,
            nextOffset: end < read.size ? end : null,
            encoding,
            content,
          });
        });
      } catch (err) {
        return fail(err, ctx);
      }
    },
  };
}

function uploadTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "ssh_upload",
    description:
      `Write a file on the remote host over SFTP, creating or REPLACING it.\n\n` +
      `Returns JSON: { remotePath, bytes }. The content travels in the call ` +
      `(utf8 text, or base64 for binary), at most ${MAX_TRANSFER_BYTES} bytes once ` +
      `decoded. The parent directory must exist. Unlike the npm ` +
      `ssh-agent-mcp-server, there is no localPath.\n\n${BREAK_GLASS}`,
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: 'Destination on the remote host. Example: "/tmp/fix.sh".',
        },
        content: {
          type: "string",
          description: "The file's content, encoded as `encoding` says.",
        },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: 'How `content` is encoded. Default "utf8".',
        },
        mode: {
          type: "string",
          description:
            'Octal permissions for a NEW file, e.g. "0644" or "0755". An existing ' +
            "file keeps its own. Default: the server's umask.",
        },
      },
      required: ["remotePath", "content"],
    },
    annotations: {
      title: "Upload remote file",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (raw) => {
      try {
        const args = asObject(raw);
        refuseLocalPath(
          args,
          "ssh_upload",
          "Pass the file's bytes as content (encoding: \"base64\" for binary).",
        );
        const remotePath = str(args, "remotePath", true);
        if (typeof args.content !== "string") {
          throw new InputError("content is required, as a string.");
        }
        const encoding = str(args, "encoding", false) ?? "utf8";
        if (encoding !== "utf8" && encoding !== "base64") {
          throw new InputError('encoding must be "utf8" or "base64".');
        }
        if (encoding === "base64" && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(args.content)) {
          throw new InputError("content is not valid base64.");
        }
        const data = Buffer.from(args.content, encoding);
        if (data.length > MAX_TRANSFER_BYTES) {
          throw new InputError(
            `content is ${data.length} bytes; the most one call carries is ${MAX_TRANSFER_BYTES}.`,
          );
        }
        let mode: number | undefined;
        const rawMode = str(args, "mode", false);
        if (rawMode !== undefined) {
          if (!/^0?[0-7]{3,4}$/.test(rawMode)) {
            throw new InputError('mode must be octal digits, e.g. "0644".');
          }
          mode = parseInt(rawMode, 8);
        }
        return await withSession(ctx, async (s) => {
          await s.writeFile(remotePath, data, { mode });
          return ok({ remotePath, bytes: data.length });
        });
      } catch (err) {
        return fail(err, ctx);
      }
    },
  };
}

const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

function executeTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "ssh_execute",
    description:
      `Run a shell command on the remote host and return its output.\n\n` +
      `Returns JSON: { exitCode, signal, stdout, stderr, stdoutBytes, ` +
      `stderrBytes, truncated, timedOut, timeout ("inactivity" | "ceiling" | null) }. A non-zero exitCode is a result, not ` +
      `a tool error. Each stream keeps its first ${OUTPUT_HEAD_BYTES / 1024} KiB ` +
      `and last ${OUTPUT_TAIL_BYTES / 1024} KiB; the middle of anything longer is ` +
      `replaced by a marker. The timeout is for INACTIVITY: it restarts on every ` +
      `byte of output, so a long job that keeps printing runs to the end — up to a ` +
      `hard ceiling of ${MAX_EXEC_WALL_MS / 60_000} minutes, so a follow (tail -f) ` +
      `ends too. A timed-out command is sent SIGKILL where sshd supports it, but ` +
      `may keep running on the host.\n\n` +
      `No terminal is allocated: interactive programs (sudo prompts, editors, ` +
      `pagers) will hang until the timeout. Use non-interactive flags.\n\n` +
      `${BREAK_GLASS} On a production host, prefer reading (logs, status) over ` +
      `changing anything.`,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: 'Shell command. Example: "df -h && systemctl status nginx --no-pager".',
        },
        cwd: {
          type: "string",
          description: 'Directory to run it in. Example: "/srv/app". Default: the login directory.',
        },
        timeout: {
          type: "integer",
          description: `Inactivity timeout in milliseconds. Default SSH_COMMAND_TIMEOUT or 60000, at most ${MAX_COMMAND_TIMEOUT_MS}.`,
        },
      },
      required: ["command"],
    },
    annotations: {
      title: "Execute remote command",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (raw) => {
      try {
        const args = asObject(raw);
        const command = str(args, "command", true);
        const cwd = str(args, "cwd", false);
        const timeout = int(args, "timeout", { min: 1000, max: MAX_COMMAND_TIMEOUT_MS });
        return await withSession(ctx, async (s, config) => {
          const result = await s.exec(command, {
            cwd,
            timeoutMs: timeout ?? config.commandTimeoutMs,
          });
          const out = ok(result);
          if (result.timedOut) {
            out.isError = true;
            out.content.unshift({
              type: "text",
              text:
                result.timeout === "ceiling"
                  ? `The command ran past the ${MAX_EXEC_WALL_MS / 60_000}-minute ceiling ` +
                    `and was abandoned. Partial output follows.`
                  : `The command produced no output for ${timeout ?? config.commandTimeoutMs} ms ` +
                    `and was abandoned. Partial output follows.`,
            });
          }
          return out;
        });
      } catch (err) {
        return fail(err, ctx);
      }
    },
  };
}

interface Entry {
  factory: (ctx: ToolContext) => ToolDefinition;
  groups: ToolGroup[];
}

/** The upstream's grouping, unchanged. */
const ENTRIES: Entry[] = [
  { factory: connectionInfoTool, groups: ["readonly", "write", "admin"] },
  { factory: checkConnectionTool, groups: ["readonly", "write", "admin"] },
  { factory: listDirectoryTool, groups: ["readonly", "write", "admin"] },
  { factory: downloadTool, groups: ["readonly", "write", "admin"] },
  { factory: uploadTool, groups: ["write", "admin"] },
  { factory: executeTool, groups: ["admin"] },
];

export function toolDefinitions(
  ctx: ToolContext,
  groups: ToolGroup[] = ALL_GROUPS,
): ToolDefinition[] {
  return ENTRIES.filter((e) => e.groups.some((g) => groups.includes(g))).map((e) =>
    e.factory(ctx),
  );
}

export function registerTools(
  server: Server,
  ctx: ToolContext,
  groups: ToolGroup[] = ALL_GROUPS,
): void {
  const tools = toolDefinitions(ctx, groups);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new Error(
        `Unknown tool: ${request.params.name}. This server offers: ${tools
          .map((t) => t.name)
          .join(", ")}.`,
      );
    }
    return tool.handler(request.params.arguments);
  });
}
