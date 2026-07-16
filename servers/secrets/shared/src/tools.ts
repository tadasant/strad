import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SecretsConfig } from "./config.js";
import { inManagedNamespace } from "./config.js";
import type { ParametersReader } from "./parameter-manager.js";

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
}

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: false } as const;

export function toolDefinitions(config: SecretsConfig) {
  const nsList = config.namespaces.map((n) => `"${n}"`).join(", ");
  return [
    {
      name: "list_managed_namespaces",
      description:
        "List the parameter namespaces this server manages, and state plainly what it can and cannot do. " +
        "A namespace is a canonical-path prefix like \"/strad/staging/mcp/\". This server is the VIEWER: it " +
        "holds Parameter Manager viewer access, so it can list parameters and read NON-secret values — but " +
        "it cannot read a SECRET value, because secret bytes live in Secret Manager and this credential " +
        "lacks secretmanager.versions.access. Secret values are set by a human in the strad console (see " +
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
              "The canonical path, e.g. \"/strad/staging/mcp/remote-fs-screenshots/static/REMOTE_FS_SCREENSHOTS_GCS_CLIENT_EMAIL\".",
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
}

export function registerTools(server: Server, deps: ToolDeps): void {
  const { config } = deps;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions(config),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "list_managed_namespaces":
          return text({
            projectId: config.projectId,
            managedNamespaces: config.namespaces,
            canReadSecretValues: false,
            whyNot:
              "This server is the VIEWER: its service account holds Parameter Manager viewer access only. " +
              "It can list parameters and read NON-secret parameter values, but secret values live in " +
              "Secret Manager and this credential lacks secretmanager.versions.access — so even the " +
              "Parameter Manager :render deref of a secret reference is denied. A value request for a secret " +
              "is denied by Google, not merely declined by this code.",
            consoleUrl: consoleLink(config),
          });

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
