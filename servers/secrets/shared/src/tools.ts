import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SecretsConfig } from "./config.js";
import { inManagedNamespace } from "./config.js";
import { variableOf } from "./parameter-wire.js";
import type { ParametersReader } from "./parameter-manager.js";
import { NO_CAPABILITIES, type Capabilities } from "./capabilities.js";
import type { ParametersWriter } from "./write-client.js";

/**
 * The four tools.
 *
 * THE INVARIANT: no tool returns a secret value. Not a redacted one, not a
 * truncated one, not a "safe prefix" — none. An agent can learn that a parameter
 * `/strad/staging/mcp/<slug>/static/<VAR>` exists, whether it is secret, the note
 * a human left on it, and when its latest version landed. If the parameter is
 * NON-secret it can also read its literal value (non-secrets are configuration,
 * not credentials, and live directly in Parameter Manager). If it is SECRET, the
 * value lives in Secret Manager and no tool here — and no credential in this
 * process — can reach it.
 *
 * That is enough for the thing an agent actually needs to do: tell a human WHICH
 * secret to go set, and hand them a link that lands on it — `open_secrets_manager`,
 * lifted from reframe-secrets, where the same idea is put well: the agent helps
 * without ever holding the thing.
 *
 * Writes (create a parameter, store or rotate a secret) are the console's job,
 * behind SSO, done by a person, with a DIFFERENT service account that never
 * reaches this process.
 */

interface ToolDeps {
  config: SecretsConfig;
  reader: () => ParametersReader;
  /**
   * What this server's credential may actually do, as reported by Google. The
   * tool surface is DERIVED from it — see capabilities.ts for why a probe rather
   * than a flag. Absent means fail closed: the read-only surface.
   */
  capabilities?: () => Promise<Capabilities>;
  /** The mutating client. Built only when the probe says writes are permitted. */
  writer?: () => ParametersWriter;
}

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: false } as const;

export function toolDefinitions(
  config: SecretsConfig,
  caps: Capabilities = NO_CAPABILITIES,
) {
  const nsList = config.namespaces.map((n) => `"${n}"`).join(", ");
  const readOnly = [
    {
      name: "list_managed_namespaces",
      description:
        "List the parameter namespaces this server manages, and report what THIS deployment's credential " +
        "may actually do — the capabilities are probed from Google, not declared, so the answer matches " +
        "what a call would really get. A namespace is a canonical-path prefix like \"/strad/staging/mcp/\". " +
        "Call this first: whether a secret value can be read, and whether writes are possible, differs by " +
        "deployment. Where a value cannot be read here, a human can set it in the strad console (see " +
        "open_secrets_manager).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: ANNOTATIONS,
    },
    {
      name: "list_parameters",
      description:
        `List the parameters in a managed namespace (${nsList}). Returns each parameter's canonical path, ` +
        "its variable name, whether it is secret, its free-form note, and when its latest version landed — " +
        "never a secret value. Use this to find out which parameter a human needs to set, and to read the " +
        "non-secret configuration a server was given.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description: `A managed namespace, one of: ${nsList}`,
          },
        },
        required: ["namespace"],
        additionalProperties: false,
      },
      annotations: ANNOTATIONS,
    },
    {
      name: "get_parameter",
      description:
        "Read a single parameter by its canonical path. If the parameter is NON-secret, returns its literal " +
        "value — non-secrets are configuration, not credentials, and are safe to read. If the parameter is " +
        "SECRET, this returns an error: its value lives in Secret Manager and no tool here can return it. " +
        "Use open_secrets_manager to have a human view a secret in the console.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The canonical path, e.g. \"/strad/staging/mcp/remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL\".",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: ANNOTATIONS,
    },
    {
      name: "open_secrets_manager",
      description:
        "Get a deep link into the strad console where a HUMAN can add, rotate, reveal or delete a secret " +
        "value. This is how you help with a secret you must never see: hand the user this URL. The console " +
        "is gated by Google Workspace SSO and is the only place a secret value can be written or read.",
      inputSchema: {
        type: "object",
        properties: {
          secret: {
            type: "string",
            description:
              "Optional. A canonical path or variable name to focus in the console.",
          },
        },
        additionalProperties: false,
      },
      annotations: ANNOTATIONS,
    },
  ];

  // Everything below is listed only when Google says this credential can perform
  // it. A surface that advertises what the boundary forbids is a bug that
  // presents as an opaque 403 to whoever calls it.
  const gated = [];

  if (caps.readSecretValues) {
    gated.push({
      name: "get_secret_value",
      description:
        "Read the RESOLVED value of a parameter, dereferencing a secret reference. This tool is " +
        "listed only on a deployment whose credential holds secretmanager.versions.access — on " +
        "one that does not (production), it does not exist and Google would refuse the call " +
        "underneath it. Use it for end-to-end verification, not to move credentials around.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: `The canonical path. Must be inside a managed namespace (${nsList}).`,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
  }

  if (caps.writeParameters) {
    gated.push({
      name: "create_parameter",
      description:
        `Create a parameter inside a managed namespace (${nsList}). A NON-SECRET value is stored ` +
        "in Parameter Manager and is readable; a SECRET value goes to Secret Manager and " +
        (caps.writeSecretValues
          ? "is referenced from Parameter Manager."
          : "CANNOT be written by this credential — pass secret: false, or use the console."),
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The canonical path, e.g. \"/strad/staging/mcp/<slug>/static/<VAR>\". The " +
              "<slug>/static/ segment is what routes the value to one MCP server.",
          },
          value: { type: "string", description: "The value to store." },
          secret: {
            type: "boolean",
            description:
              "True for a credential (goes to Secret Manager). False for configuration.",
          },
          note: {
            type: "string",
            description: "Optional free-form note. Readable by agents; never put a value in it.",
          },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    });

    gated.push({
      name: "set_parameter_value",
      description:
        "Rotate an existing parameter: store a new value as a new version. The previous version " +
        "is retained by the store. The parameter must already exist and be inside a managed namespace.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The canonical path." },
          value: { type: "string", description: "The new value." },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    });

    gated.push({
      name: "set_parameter_note",
      description:
        "Set or clear a parameter's free-form note. Agents can read notes, so a note documents " +
        "what a credential is for — it must never contain the credential.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The canonical path." },
          note: { type: "string", description: "The note. Empty clears it." },
        },
        required: ["name", "note"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    });
  }

  if (caps.deleteParameters) {
    gated.push({
      name: "delete_parameter",
      description:
        "Delete a parameter and every version of it, plus its Secret Manager secret if it had " +
        "one. This cannot be undone.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The canonical path." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    });
  }

  return [...readOnly, ...gated];
}

export function registerTools(server: Server, deps: ToolDeps): void {
  const { config } = deps;

  const caps = deps.capabilities ?? (() => Promise.resolve(NO_CAPABILITIES));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions(config, await caps()),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "list_managed_namespaces": {
          // Reported from the PROBE, never from a constant. A hardcoded "no"
          // would be a lie on a deployment whose credential can read — told to
          // an agent, next to a listed get_secret_value tool.
          const probed = await caps();
          return text({
            projectId: config.projectId,
            managedNamespaces: config.namespaces,
            canReadSecretValues: probed.readSecretValues,
            canWrite: probed.writeParameters,
            canDelete: probed.deleteParameters,
            capabilitiesProbed: probed.probed,
            whyNot: probed.readSecretValues
              ? undefined
              : probed.probed
                ? "This deployment's service account holds neither secretmanager.versions.access nor " +
                  "parametermanager.parameterVersions.render, so a secret value cannot be read here. That " +
                  "is denied by Google, not merely declined by this code."
                : `This server's capabilities could not be established (${probed.reason ?? "no reason given"}), ` +
                  "so it fails closed: the surface is read-only and no secret value can be read.",
            consoleUrl: consoleLink(config),
          });
        }

        case "list_parameters": {
          const namespace = String(
            (args as { namespace?: unknown } | undefined)?.namespace ?? "",
          );
          if (!config.namespaces.includes(namespace)) {
            return error(
              `"${namespace}" is not a managed namespace. Managed: ${config.namespaces.join(", ")}. ` +
                `Call list_managed_namespaces first.`,
            );
          }
          const parameters = await deps.reader().listParameters(namespace);
          return text({
            namespace,
            count: parameters.length,
            parameters,
            note:
              "Metadata only. Secret parameter values live in Secret Manager and no tool here can return one.",
          });
        }

        case "get_parameter": {
          const path = String(
            (args as { name?: unknown } | undefined)?.name ?? "",
          );
          if (!inManagedNamespace(path, config.namespaces)) {
            return error(
              `"${path}" is outside the managed namespaces (${config.namespaces.join(", ")}). ` +
                `This server will not read a parameter outside them.`,
            );
          }
          const record = await deps.reader().getParameter(path);
          if (!record) {
            return error(
              `"${path}" has no value yet, or is not a managed parameter.`,
            );
          }
          if (record.envelope.secret === true) {
            // The invariant, enforced in code as well as in IAM: a secret's value
            // is never returned. The envelope this viewer can read holds only a
            // Secret Manager REFERENCE, not the bytes — but we refuse even to
            // surface that; the answer is "go to the console".
            return error(
              `"${path}" is a SECRET parameter; its value lives in Secret Manager and cannot be read over MCP. ` +
                `Use open_secrets_manager to have a human view it in the console.`,
            );
          }
          return text({
            name: path,
            secret: false,
            value: record.envelope.value,
            note: record.envelope.note,
          });
        }

        case "open_secrets_manager": {
          const secret = (args as { secret?: unknown } | undefined)?.secret;
          const url = consoleLink(
            config,
            typeof secret === "string" ? secret : undefined,
          );
          if (!url) {
            return error(
              "No console URL is configured for this server (SECRETS_CONSOLE_URL).",
            );
          }
          return text({
            url,
            instructions:
              "Send this link to the human. They sign in with Google Workspace SSO and can add, " +
              "rotate, reveal or delete the value there. Do not ask them to paste the value back " +
              "to you — nothing on this server, and no agent, needs it.",
          });
        }

        case "get_secret_value": {
          const path = String((args as { name?: unknown } | undefined)?.name ?? "");
          const c = await caps();
          if (!c.readSecretValues) {
            return error(
              "This deployment's credential cannot read secret values " +
                `(${c.probed ? "no secretmanager.versions.access" : (c.reason ?? "capability unverified")}). ` +
                "Use open_secrets_manager to have a human view it in the console.",
            );
          }
          if (!inManagedNamespace(path, config.namespaces)) {
            return error(
              `"${path}" is outside the managed namespaces (${config.namespaces.join(", ")}).`,
            );
          }
          const writer = deps.writer?.();
          if (!writer) return error("no client is configured for value reads");
          return text({ name: path, value: await writer.readValue(path) });
        }

        case "create_parameter": {
          const a = (args ?? {}) as {
            name?: unknown;
            value?: unknown;
            secret?: unknown;
            note?: unknown;
          };
          const path = String(a.name ?? "");
          const secret = a.secret === true;
          const c = await caps();
          const denied = writeDenial(c, secret);
          if (denied) return error(denied);
          if (!inManagedNamespace(path, config.namespaces)) {
            return error(
              `"${path}" is outside the managed namespaces (${config.namespaces.join(", ")}).`,
            );
          }
          if (typeof a.value !== "string" || a.value === "") {
            return error("a non-empty `value` is required");
          }
          const writer = deps.writer?.();
          if (!writer) return error("no client is configured for writes");
          await writer.create({
            path,
            secret,
            value: a.value,
            note: typeof a.note === "string" && a.note ? a.note : undefined,
          });
          return text({
            created: path,
            variable: variableOf(path),
            secret,
            note: "Stored. Whether a running server RESOLVES this path depends on that server's `params: true` and the deployment's resolver credential — see the console.",
          });
        }

        case "set_parameter_value": {
          const a = (args ?? {}) as { name?: unknown; value?: unknown };
          const path = String(a.name ?? "");
          const c = await caps();
          if (!c.writeParameters) return error(writeDenial(c, false) ?? "denied");
          if (!inManagedNamespace(path, config.namespaces)) {
            return error(
              `"${path}" is outside the managed namespaces (${config.namespaces.join(", ")}).`,
            );
          }
          if (typeof a.value !== "string" || a.value === "") {
            return error("a non-empty `value` is required");
          }
          const writer = deps.writer?.();
          if (!writer) return error("no client is configured for writes");
          await writer.rotate(path, a.value);
          return text({ rotated: path, variable: variableOf(path) });
        }

        case "set_parameter_note": {
          const a = (args ?? {}) as { name?: unknown; note?: unknown };
          const path = String(a.name ?? "");
          const c = await caps();
          if (!c.writeParameters) return error(writeDenial(c, false) ?? "denied");
          if (!inManagedNamespace(path, config.namespaces)) {
            return error(
              `"${path}" is outside the managed namespaces (${config.namespaces.join(", ")}).`,
            );
          }
          const writer = deps.writer?.();
          if (!writer) return error("no client is configured for writes");
          await writer.setNote(path, String(a.note ?? ""));
          return text({ noted: path, variable: variableOf(path) });
        }

        case "delete_parameter": {
          const path = String((args as { name?: unknown } | undefined)?.name ?? "");
          const c = await caps();
          if (!c.deleteParameters) {
            return error(
              "This deployment's credential cannot delete parameters " +
                `(${c.probed ? "no parametermanager.parameters.delete" : (c.reason ?? "capability unverified")}).`,
            );
          }
          if (!inManagedNamespace(path, config.namespaces)) {
            return error(
              `"${path}" is outside the managed namespaces (${config.namespaces.join(", ")}).`,
            );
          }
          const writer = deps.writer?.();
          if (!writer) return error("no client is configured for writes");
          await writer.destroy(path);
          return text({ deleted: path, variable: variableOf(path) });
        }

        default:
          return error(`unknown tool: ${name}`);
      }
    } catch (err) {
      // A failure here can only ever be about PATHS and STATUS CODES — this
      // server never holds a secret value to leak into a message. Still: report
      // the shape, not the payload, and never the credential.
      return error(err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * Why a write is refused, or null when it is permitted.
 *
 * Split by kind because the two failures have different fixes: a non-secret write
 * needs Parameter Manager only, a secret write needs Secret Manager too, and
 * telling someone "you cannot write" when they can in fact write configuration is
 * the kind of message that sends them to the wrong IAM page.
 */
function writeDenial(caps: Capabilities, secret: boolean): string | null {
  if (!caps.probed) {
    return (
      "This deployment's write capability could not be established " +
      `(${caps.reason ?? "no reason given"}), so writes are refused rather than attempted.`
    );
  }
  if (!caps.writeParameters) {
    return (
      "This deployment's credential cannot write parameters (no " +
      "parametermanager.parameters.create / parameterVersions.create). Use the console."
    );
  }
  if (secret && !caps.writeSecretValues) {
    return (
      "This deployment's credential can write configuration but not SECRET values (no " +
      "secretmanager.secrets.create / versions.add). Pass secret: false, or set it in the console."
    );
  }
  return null;
}

/** `https://strad/ui/secrets?param=/strad/staging/mcp/.../VAR` */
function consoleLink(config: SecretsConfig, param?: string): string | undefined {
  if (!config.consoleUrl) return undefined;
  const base = config.consoleUrl.replace(/\/+$/, "");
  return param ? `${base}?param=${encodeURIComponent(param)}` : base;
}

function text(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function error(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
