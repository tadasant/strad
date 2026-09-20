import { z } from "zod";

import type { Config } from "../config.js";
import { defineTool, json, text, type Capability } from "../mcp/tool.js";
import { clip } from "./output.js";
import { ProcessManager, type CommandRecord } from "./processes.js";

const P = {
  command:
    'The command line, run by the machine owner\'s login shell (zsh on macOS) as `$SHELL -lc "<command>"`. ' +
    'Pipes, globs, `&&` and `~` all work, e.g. "ls -la ~/Downloads | head -20" or "rg -l TODO ~/code/strad/src". ' +
    "There is no stdin and no TTY: anything that prompts (sudo, an ssh host-key question) fails instead of hanging.",
  cwd:
    'Directory to run in. Absolute ("/Users/me/code"), "~"-relative ("~/code"), or relative to the default. ' +
    "Defaults to the owner's home directory.",
  wait_seconds:
    "How long to wait for the command before returning. Default 30, max 300. A command still running when " +
    'the wait ends is NOT killed: you get status "running" and a command_id to poll with get_command. ' +
    "Use 0 to start a long job and return at once.",
  max_output_chars:
    "Cap on the output returned in this response. Default 20000. Output over the cap keeps its first and last " +
    "halves and says how much was omitted.",
  command_id: 'A command_id from run_command or list_commands, e.g. "c3".',
} as const;

function render(c: CommandRecord, maxChars: number) {
  const out = clip(c.output.toString(), maxChars);
  return {
    command_id: c.id,
    status: c.status,
    exit_code: c.exitCode ?? null,
    signal: c.signal ?? null,
    cwd: c.cwd,
    runtime_seconds:
      Math.round(((c.endedAt ?? Date.now()) - c.startedAt) / 100) / 10,
    output: out.text,
    output_truncated: out.truncated,
    ...(c.status === "running"
      ? {
          next: `Still running. Poll with get_command {"command_id":"${c.id}"} or stop it with kill_command.`,
        }
      : {}),
  };
}

export function shellCapability(
  config: Config,
): Capability & { processes: ProcessManager } {
  const processes = new ProcessManager(config);

  const runCommand = defineTool({
    name: "run_command",
    description: `Run a shell command on the owner's machine and return its combined stdout+stderr.

The command runs as the owner's own user, in the background of their desktop — no window opens and nothing takes focus. It can read and write whatever that user can. It is not sandboxed: treat it like typing into their terminal.

**Returns** (JSON):
{"command_id":"c3","status":"exited","exit_code":0,"signal":null,"cwd":"/Users/me","runtime_seconds":0.4,"output":"…","output_truncated":false}

**status values:** "exited" (finished; read exit_code), "running" (outlived wait_seconds — still going, poll get_command), "killed" (stopped by kill_command or because the grant ended), "timed_out" (hit the daemon's hard runtime ceiling and was killed).

**Use cases:**
- Look through files: "ls", "rg", "find ~/Documents -name '*.pdf' -mtime -7"
- Read a config or a log: "tail -100 ~/Library/Logs/foo.log"
- Check machine state: "df -h", "ps aux | head", "git -C ~/code/x status"
- Start a long job with wait_seconds 0 and poll it
- Run a project's own scripts or tests in its directory via cwd

A non-zero exit_code is a normal result, not a tool error — read the output.`,
    schema: z.object({
      command: z.string().min(1).max(20_000).describe(P.command),
      cwd: z.string().min(1).optional().describe(P.cwd),
      wait_seconds: z
        .number()
        .min(0)
        .max(300)
        .default(30)
        .describe(P.wait_seconds),
      max_output_chars: z
        .number()
        .int()
        .min(200)
        .max(200_000)
        .default(20_000)
        .describe(P.max_output_chars),
    }),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: P.command },
        cwd: { type: "string", description: P.cwd },
        wait_seconds: {
          type: "number",
          description: P.wait_seconds,
          default: 30,
          minimum: 0,
          maximum: 300,
        },
        max_output_chars: {
          type: "integer",
          description: P.max_output_chars,
          default: 20_000,
        },
      },
      required: ["command"],
    },
    annotations: {
      title: "Run a shell command",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    summarize: (a) => `run_command: ${a.command.slice(0, 200)}`,
    handler: async (a, { grant }) => {
      let record: CommandRecord;
      try {
        record = processes.start(grant, a.command, a.cwd);
      } catch (err) {
        return text((err as Error).message, true);
      }
      await processes.wait(record, a.wait_seconds * 1000);
      return json(render(record, a.max_output_chars));
    },
  });

  const getCommand = defineTool({
    name: "get_command",
    description: `Get the status and output of a command started with run_command — the way to follow one that was still "running" when run_command returned.

**Returns** the same JSON shape as run_command: {"command_id":"c3","status":"running","exit_code":null,…,"output":"…"}. Output is cumulative from the start of the command, not a delta.

**Use cases:**
- Poll a long-running job until status is "exited"
- Re-read a finished command's output with a larger max_output_chars
- Block up to wait_seconds for a job to finish instead of polling in a tight loop

You can only see commands started under your own grant.`,
    schema: z.object({
      command_id: z.string().min(1).describe(P.command_id),
      wait_seconds: z
        .number()
        .min(0)
        .max(300)
        .default(0)
        .describe(P.wait_seconds),
      max_output_chars: z
        .number()
        .int()
        .min(200)
        .max(200_000)
        .default(20_000)
        .describe(P.max_output_chars),
    }),
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", description: P.command_id },
        wait_seconds: {
          type: "number",
          description: P.wait_seconds,
          default: 0,
          minimum: 0,
          maximum: 300,
        },
        max_output_chars: {
          type: "integer",
          description: P.max_output_chars,
          default: 20_000,
        },
      },
      required: ["command_id"],
    },
    annotations: {
      title: "Get a command's status and output",
      readOnlyHint: true,
    },
    handler: async (a, { grant }) => {
      const record = processes.get(grant.id, a.command_id);
      if (!record)
        return text(
          `No command "${a.command_id}" under this grant. list_commands shows the ones there are.`,
          true,
        );
      await processes.wait(record, a.wait_seconds * 1000);
      return json(render(record, a.max_output_chars));
    },
  });

  const listCommands = defineTool({
    name: "list_commands",
    description: `List the commands started under this grant, running and finished, without their output.

**Returns:** {"commands":[{"command_id":"c3","status":"running","exit_code":null,"runtime_seconds":12.5,"command":"npm test"}]}

**Use cases:**
- Find the command_id of a job you started earlier
- Check whether anything is still running before ending control
- See which commands failed (non-zero exit_code) at a glance`,
    schema: z.object({}),
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List this grant's commands", readOnlyHint: true },
    handler: async (_a, { grant }) =>
      json({
        commands: processes.list(grant.id).map((c) => ({
          command_id: c.id,
          status: c.status,
          exit_code: c.exitCode ?? null,
          runtime_seconds:
            Math.round(((c.endedAt ?? Date.now()) - c.startedAt) / 100) / 10,
          command: c.command.slice(0, 200),
        })),
      }),
  });

  const killCommand = defineTool({
    name: "kill_command",
    description: `Stop a running command and everything it spawned (the whole process group): SIGTERM, then SIGKILL two seconds later if it has not exited.

**Returns** the command's final JSON, as get_command does, with status "killed".

**Use cases:**
- Stop a job that is taking too long or was started by mistake
- Stop a server or watcher you started with wait_seconds 0
- Clean up before end_control (ending the grant kills whatever is left anyway)`,
    schema: z.object({ command_id: z.string().min(1).describe(P.command_id) }),
    inputSchema: {
      type: "object",
      properties: { command_id: { type: "string", description: P.command_id } },
      required: ["command_id"],
    },
    annotations: {
      title: "Kill a running command",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    summarize: (a) => `kill_command: ${a.command_id}`,
    handler: async (a, { grant }) => {
      const record = processes.get(grant.id, a.command_id);
      if (!record)
        return text(`No command "${a.command_id}" under this grant.`, true);
      await processes.kill(record);
      return json(render(record, 20_000));
    },
  });

  return {
    processes,
    tools: [runCommand, getCommand, listCommands, killCommand],
    close: () => processes.closeAll(),
  };
}
