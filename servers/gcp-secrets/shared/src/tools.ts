import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { GcpSecretsConfig } from "./config.js";
import type { SecretsReader } from "./client.js";

/**
 * The three tools.
 *
 * THE INVARIANT: no tool accepts a secret value, and no tool returns one. Not a
 * redacted one, not a truncated one, not a "safe prefix" — none. An agent can
 * learn that `mcp-openai-api-key` exists, that a human noted "billing account,
 * rotate quarterly" on it, and that its latest version landed on Tuesday. It
 * cannot learn what it says.
 *
 * That is enough for the thing an agent actually needs to do, which is tell a
 * human WHICH secret to go set, and hand them a link that lands on it —
 * `open_secrets_manager`, lifted from reframe-secrets, where the same idea is
 * put well: the agent helps without ever holding the thing.
 *
 * Writes are the console's job, behind SSO, done by a person. There is no MCP
 * tool to add, rotate or delete a value, and there is no service-account key in
 * this process that could perform one if there were.
 */

interface ToolDeps {
  config: GcpSecretsConfig;
  reader: () => SecretsReader;
}

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: false } as const;

export function toolDefinitions(config: GcpSecretsConfig) {
  const nsList = config.namespaces.map((n) => `"${n}"`).join(", ");
  return [
    {
      name: "list_managed_namespaces",
      description:
        "List the secret namespaces this server manages, and state plainly what it can and cannot do. " +
        "A namespace is a secret-name prefix in the Google Cloud project. This server can read secret " +
        "NAMES and METADATA only — its service account does not hold secretmanager.versions.access, so " +
        "no tool here can return a secret value, ever. Values are added and read by a human in the strad " +
        "console (see open_secrets_manager).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: ANNOTATIONS,
    },
    {
      name: "list_secrets",
      description:
        `List the secrets in a managed namespace (${nsList}). Returns each secret's name, its free-form ` +
        "note, when it was created, and whether it currently has a value (its latest version number and " +
        "date) — never the value itself. Use this to find out which secret a human needs to set or rotate.",
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
      name: "open_secrets_manager",
      description:
        "Get a deep link into the strad console where a HUMAN can add, rotate, reveal or delete a secret " +
        "value. This is how you help with a secret you must never see: hand the user this URL. The console " +
        "is gated by Google Workspace SSO and is the only place a value can be written or read.",
      inputSchema: {
        type: "object",
        properties: {
          secret: {
            type: "string",
            description:
              "Optional. A secret name to focus in the console, e.g. \"mcp-openai-api-key\".",
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
              "This server's service account holds roles/secretmanager.viewer " +
              "(list/describe) and NOT secretmanager.versions.access. A request for a " +
              "value would be denied by Google, not merely declined by this code.",
            consoleUrl: consoleLink(config),
          });

        case "list_secrets": {
          const namespace = String(
            (args as { namespace?: unknown } | undefined)?.namespace ?? "",
          );
          if (!config.namespaces.includes(namespace)) {
            return error(
              `"${namespace}" is not a managed namespace. Managed: ${config.namespaces.join(", ")}. ` +
                `Call list_managed_namespaces first.`,
            );
          }
          const secrets = await deps.reader().listSecrets(namespace);
          return text({
            namespace,
            count: secrets.length,
            secrets,
            note: "Metadata only. No tool on this server can return a secret value.",
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
              "No console URL is configured for this server (GCP_SECRETS_CONSOLE_URL).",
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
      // A failure here can only ever be about NAMES and STATUS CODES — this
      // server never holds a value to leak into a message. Still: report the
      // shape, not the payload, and never the credential.
      return error(err instanceof Error ? err.message : String(err));
    }
  });
}

/** `https://strad/ui/gcp-secrets?secret=mcp-openai-api-key` */
function consoleLink(
  config: GcpSecretsConfig,
  secret?: string,
): string | undefined {
  if (!config.consoleUrl) return undefined;
  const base = config.consoleUrl.replace(/\/+$/, "");
  return secret
    ? `${base}?secret=${encodeURIComponent(secret)}`
    : base;
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
