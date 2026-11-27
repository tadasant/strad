/**
 * The six tools, named as the npm `hatchbox-mcp-server` names them, so an
 * agent or a skill written against it calls the same names here.
 *
 * ALL SIX ALWAYS LIST. Which of them a slug may use is the gateway's `tools:`
 * policy and which credentials the slug was given, never a flag in this
 * process, so `tools/list` is never empty (pulsemcp/pulsemcp#3492). A tool whose
 * credential is absent fails on call, naming the variables.
 */
import type { HatchboxClient } from "./client.js";
import {
  loadApiConfig,
  loadDeployConfig,
  loadSshConfig,
  type ToolGroup,
} from "./config.js";
import { InputError } from "./errors.js";
import type { EnvironReader } from "./ssh.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface ToolContext {
  env: Env;
  client: HatchboxClient;
  readEnviron: EnvironReader;
}

export interface Annotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  group: ToolGroup;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Annotations;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** The longest deploy output a result keeps: its END, where a failure is. */
export const MAX_DEPLOY_OUTPUT_CHARS = 20_000;
export const MAX_DELETE_NAMES = 50;

/** An env var name as Hatchbox and a shell accept it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const SHA = /^[0-9a-fA-F]{7,40}$/;
const ACTIVITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new InputError(`\`${key}\` is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new InputError(`\`${key}\` must be a string.`);
  return v;
}

function envName(raw: string, key: string): string {
  if (!ENV_NAME.test(raw)) {
    throw new InputError(
      `\`${key}\` "${raw.slice(0, 80)}" is not an environment variable name: letters, digits ` +
        `and _, not starting with a digit.`,
    );
  }
  return raw;
}

function only(args: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new InputError(
      `Unknown argument${extra.length === 1 ? "" : "s"} ${extra.map((k) => `\`${k}\``).join(", ")}. ` +
        (allowed.length ? `This tool takes ${allowed.map((k) => `\`${k}\``).join(", ")}.` : "This tool takes no arguments."),
    );
  }
}

const READ: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const SECRET_WARNING =
  "The values are the app's real production configuration — database URLs, API keys, " +
  "the Rails master key — so do not repeat them anywhere you were not asked to.";

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "getEnvVars",
    group: "ssh",
    description:
      "Read every environment variable of the Rails app as it is RUNNING on its Hatchbox web " +
      "server, from the puma process over SSH. This is the deployed state: a value set with " +
      "setEnvVar is not here until the next deploy. Pass `names_only: true` to get the names " +
      `without any values. ${SECRET_WARNING} Needs HATCHBOX_SSH_HOST, HATCHBOX_SSH_PRIVATE_KEY ` +
      "and HATCHBOX_SSH_HOST_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        names_only: {
          type: "boolean",
          description: "Return the variable names only, no values. Default false.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, ctx) => {
      only(args, ["names_only"]);
      if (args.names_only !== undefined && typeof args.names_only !== "boolean") {
        throw new InputError("`names_only` must be true or false.");
      }
      const config = loadSshConfig(ctx.env);
      const read = await ctx.readEnviron(config);
      return {
        app_id: config.appId,
        server: config.host,
        pid: read.pid,
        count: read.vars.length,
        ...(args.names_only
          ? { names: read.vars.map((v) => v.name) }
          : { env_vars: Object.fromEntries(read.vars.map((v) => [v.name, v.value])) }),
      };
    },
  },
  {
    name: "getEnvVar",
    group: "ssh",
    description:
      "Read ONE environment variable of the Rails app as it is running on its Hatchbox web " +
      "server, from the puma process over SSH. Prefer this to getEnvVars when you need one " +
      `value. ${SECRET_WARNING} Needs HATCHBOX_SSH_HOST, HATCHBOX_SSH_PRIVATE_KEY and ` +
      "HATCHBOX_SSH_HOST_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'The variable\'s name, e.g. "RAILS_ENV".',
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, ctx) => {
      only(args, ["name"]);
      const name = envName(str(args, "name", true), "name");
      const config = loadSshConfig(ctx.env);
      const read = await ctx.readEnviron(config);
      const found = read.vars.find((v) => v.name === name);
      return found
        ? { name, found: true, value: found.value }
        : {
            name,
            found: false,
            note: `${name} is not set in the running app. If it was just set with setEnvVar, it arrives with the next deploy.`,
          };
    },
  },
  {
    name: "setEnvVar",
    group: "api",
    description:
      "Set or update one environment variable of the app in Hatchbox. It takes effect on the " +
      "NEXT deploy, not now: call triggerDeploy after, if the change should go live. An existing " +
      "value is overwritten and is not returned or kept. The result lists the app's variable " +
      "names, never values. Needs HATCHBOX_API_KEY, HATCHBOX_ACCOUNT_ID and HATCHBOX_APP_ID.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'The variable\'s name, e.g. "FEATURE_FLAG_ENABLED".' },
        value: { type: "string", description: "The value, as text." },
      },
      required: ["name", "value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      only(args, ["name", "value"]);
      const name = envName(str(args, "name", true), "name");
      const value = args.value;
      if (typeof value !== "string") throw new InputError("`value` must be a string.");
      const config = loadApiConfig(ctx.env);
      const names = await ctx.client.setEnvVar(config, name, value);
      return {
        set: name,
        takes_effect: "on the next deploy",
        ...(names ? { count: names.length, names: names.map((n) => n.name) } : {}),
      };
    },
  },
  {
    name: "deleteEnvVars",
    group: "api",
    description:
      "Delete environment variables from the app in Hatchbox. A deleted value cannot be " +
      "recovered — read it with getEnvVar first if it may be needed. Takes effect on the NEXT " +
      "deploy. Needs HATCHBOX_API_KEY, HATCHBOX_ACCOUNT_ID and HATCHBOX_APP_ID.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_DELETE_NAMES,
          description: 'The names to delete, e.g. ["OLD_API_KEY"].',
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (args, ctx) => {
      only(args, ["names"]);
      const raw = args.names;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new InputError("`names` must be a non-empty array of variable names.");
      }
      if (raw.length > MAX_DELETE_NAMES) {
        throw new InputError(`\`names\` may hold at most ${MAX_DELETE_NAMES} names per call.`);
      }
      const names = [
        ...new Set(
          raw.map((n, i) => {
            if (typeof n !== "string") throw new InputError(`\`names[${i}]\` must be a string.`);
            return envName(n, `names[${i}]`);
          }),
        ),
      ];
      const config = loadApiConfig(ctx.env);
      const remaining = await ctx.client.deleteEnvVars(config, names);
      return {
        deleted: names,
        takes_effect: "on the next deploy",
        ...(remaining ? { remaining_count: remaining.length } : {}),
      };
    },
  },
  {
    name: "triggerDeploy",
    group: "deploy",
    description:
      "Deploy the app on Hatchbox: pull the branch, build, run migrations and restart. With " +
      "`sha`, deploys that commit (a rollback is a deploy of an older sha); without it, the " +
      "latest commit of the app's branch. A deploy restarts production — do not trigger one " +
      "you were not asked for. Returns the activity id checkDeploy takes. Needs HATCHBOX_DEPLOY_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        sha: {
          type: "string",
          description: "A commit sha, 7 to 40 hex characters. Omit for the branch's latest commit.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args, ctx) => {
      only(args, ["sha"]);
      const sha = str(args, "sha", false);
      if (sha !== undefined && !SHA.test(sha)) {
        throw new InputError("`sha` must be a commit sha: 7 to 40 hexadecimal characters.");
      }
      const config = loadDeployConfig(ctx.env);
      const started = await ctx.client.triggerDeploy(config, sha);
      return {
        triggered: true,
        deploying: sha ?? "latest commit of the app's branch",
        activity_id: started.id,
        status: started.status ?? "pending",
        next:
          started.id === null
            ? "Hatchbox returned no activity id, so checkDeploy cannot follow this one; see the app's Activity page."
            : `checkDeploy with activityId "${started.id}" to follow it. Deploys usually take 3 to 10 minutes.`,
      };
    },
  },
  {
    name: "checkDeploy",
    group: "deploy",
    description:
      "Status and output of one deploy activity, by the id triggerDeploy returned. Long " +
      `output keeps its last ${MAX_DEPLOY_OUTPUT_CHARS} characters, where a failure is. ` +
      "Needs HATCHBOX_DEPLOY_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        activityId: { type: "string", description: 'The activity id triggerDeploy returned, e.g. "12345".' },
      },
      required: ["activityId"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: async (args, ctx) => {
      only(args, ["activityId"]);
      const activityId = str(args, "activityId", true);
      if (!ACTIVITY_ID.test(activityId)) {
        throw new InputError("`activityId` must be the id triggerDeploy returned: letters, digits, - or _.");
      }
      const config = loadDeployConfig(ctx.env);
      const status = await ctx.client.checkDeploy(config, activityId);
      const output = status.output;
      const cut = output !== null && output.length > MAX_DEPLOY_OUTPUT_CHARS;
      return {
        activity_id: status.id,
        status: status.status,
        output: cut ? output!.slice(-MAX_DEPLOY_OUTPUT_CHARS) : output,
        ...(cut ? { output_cut: `kept the last ${MAX_DEPLOY_OUTPUT_CHARS} of ${output!.length} characters` } : {}),
      };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
