import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { SecretsConfig, SecretsStore } from "./config.js";
import {
  describeNamespaces,
  storeForNamespace,
  storeForPath,
} from "./config.js";
import { variableOf } from "./parameter-wire.js";
import type { ParametersReader } from "./parameter-manager.js";
import {
  anyPermits,
  NO_CAPABILITIES,
  type Capabilities,
  type CapabilityLookup,
} from "./capabilities.js";
import type { ParametersWriter } from "./write-client.js";

/**
 * The tools.
 *
 * THE INVARIANT: no tool returns a secret value the store's own credential
 * cannot fetch. Not a redacted one, not a truncated one, not a "safe prefix" —
 * none. An agent can learn that a parameter
 * `/strad/staging/mcp/<slug>/static/<VAR>` exists, whether it is secret, the note
 * a human left on it, and when its latest version landed. If the parameter is
 * NON-secret it can also read its literal value (non-secrets are configuration,
 * not credentials, and live directly in Parameter Manager). If it is SECRET, the
 * value lives in Secret Manager and `get_parameter` never returns it.
 *
 * That is enough for the thing an agent actually needs to do: tell a human WHICH
 * secret to go set, and hand them a link that lands on it — `open_secrets_manager`,
 * lifted from reframe-secrets, where the same idea is put well: the agent helps
 * without ever holding the thing.
 *
 * ONE CONTAINER, N STORES, AND THE PATH IS WHAT BINDS A CALL TO ONE OF THEM.
 * Every tool that takes a canonical path resolves it to exactly one store
 * (`storeForPath`) before it does anything else, and from then on uses THAT
 * store's namespaces, THAT store's viewer credential and THAT store's probed
 * capability. There is no union anywhere on a call path. The tool LIST is a
 * union — see `anyPermits` in capabilities.ts for why it has to be, and why that
 * is safe only because these gates are per store.
 */

/**
 * Ask the strad gateway to drop its reading of the store, so the next `${NAME}`
 * it resolves reaches Parameter Manager rather than the reading it holds.
 *
 * NEVER THROWS. A refresh is best-effort: the gateway re-reads the store within
 * `gateway.secrets.ttlSeconds` regardless, so a failure is a reason in the
 * outcome, reported to the agent, and not a failed write.
 */
export type GatewayRefresh = () => Promise<
  { refreshed: true } | { refreshed: false; reason: string }
>;

interface ToolDeps {
  config: SecretsConfig;
  /** The read client for ONE store. Built per store, never shared. */
  reader: (store: SecretsStore) => ParametersReader;
  /**
   * Present when the host can reach core. Decides whether `refresh_gateway` is
   * OFFERED — a tool that would fail on every call is not listed — and what a
   * write tool does after it lands.
   */
  refreshGateway?: GatewayRefresh;
  /**
   * What ONE STORE's credential may actually do, as reported by Google, keyed by
   * project id. Every gate below resolves a store first and asks about that
   * store. Absent means fail closed: the read-only surface, everywhere.
   */
  capabilities?: CapabilityLookup;
  /** The mutating client for ONE store. Reached only through that store's gate. */
  writer?: (store: SecretsStore) => ParametersWriter;
}

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: false } as const;

/**
 * The tool list, from the capability of every store this server fronts.
 *
 * `caps` is per project and the union is taken HERE and nowhere else: an MCP
 * client caches one listing per session, so a tool cannot exist for one store
 * and be absent for another. What makes that safe is that the handlers below
 * refuse per store — a tool listed because staging can back it still refuses a
 * production path, and production's own credential would be refused by Google
 * underneath that.
 */
export function toolDefinitions(
  config: SecretsConfig,
  caps: ReadonlyMap<string, Capabilities> = new Map(),
  opts: { refreshGateway?: boolean } = {},
) {
  const { stores } = config;
  const multi = stores.length > 1;
  const nsList = describeNamespaces(stores);
  const perStore = anyPermits(caps.values());
  const readOnly = [
    {
      name: "list_managed_namespaces",
      description:
        (multi
          ? "List the parameter STORES this server fronts — each a GCP project with its own " +
            "namespaces and its own credential — and report, PER STORE, what that store's " +
            "credential may actually do. "
          : "List the parameter namespaces this server manages, and report what THIS deployment's " +
            "credential may actually do. ") +
        "The capabilities are probed from Google, not declared, so the answer matches what a call " +
        "would really get. A namespace is a canonical-path prefix like \"/strad/staging/mcp/\", and " +
        "it is what decides which store a parameter path addresses. Call this first: whether a " +
        "secret value can be read, and whether writes are possible, differs by store. Where a value " +
        "cannot be read here, a human can set it in the strad console (see open_secrets_manager).",
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
        "SECRET, this returns an error: its value lives in Secret Manager and this tool never returns one. " +
        "Use open_secrets_manager to have a human view a secret in the console.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "The canonical path, e.g. \"/strad/staging/mcp/remote-filesystem-tmp-public/static/REMOTE_FILESYSTEM_TMP_PUBLIC_GCS_CLIENT_EMAIL\". " +
              "The namespace it starts with is what selects the store.",
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

  // Everything below is listed only when Google says SOME store's credential can
  // perform it. A surface that advertises what every boundary forbids is a bug
  // that presents as an opaque 403 to whoever calls it; a surface that hides a
  // tool one store can back would take a capability away from that store.
  const gated = [];

  if (perStore.readSecretValues) {
    gated.push({
      name: "get_secret_value",
      description:
        "Read the RESOLVED value of a parameter, dereferencing a secret reference. " +
        (multi
          ? "It is listed because AT LEAST ONE store this server fronts holds " +
            "secretmanager.versions.access (or parametermanager.parameterVersions.render). Each " +
            "call is checked against the store the PATH addresses: on a store whose credential " +
            "holds neither — production — this refuses, and Google would refuse underneath it, " +
            "because that store is read with its own viewer key. Call " +
            "list_managed_namespaces to see which store permits it."
          : "This tool is listed only on a deployment whose credential holds " +
            "secretmanager.versions.access — on one that does not (production), it does not " +
            "exist and Google would refuse the call underneath it.") +
        " Use it for end-to-end verification, not to move credentials around.",
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

  if (perStore.writeParameters) {
    gated.push({
      name: "create_parameter",
      description:
        `Create a parameter inside a managed namespace (${nsList}). The namespace selects the store, ` +
        "and the write is refused unless THAT store's credential permits it. A NON-SECRET value is " +
        "stored in Parameter Manager and is readable; a SECRET value goes to Secret Manager and " +
        (perStore.writeSecretValues
          ? multi
            ? "is referenced from Parameter Manager — on the stores whose credential can write one; " +
              "elsewhere pass secret: false, or use the console."
            : "is referenced from Parameter Manager."
          : "CANNOT be written by this deployment's credentials — pass secret: false, or use the console."),
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
        "is retained by the store. The parameter must already exist and be inside a managed namespace, " +
        "and the store that namespace addresses must permit writes.",
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

  if (perStore.deleteParameters) {
    gated.push({
      name: "delete_parameter",
      description:
        "Delete a parameter and every version of it, plus its Secret Manager secret if it had " +
        "one. Refused unless the store the path addresses permits deletes. This cannot be undone.",
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

  // The gateway re-read. Offered whenever the host can reach core, on every
  // credential: it reads nothing and writes nothing in the store, it only
  // makes the gateway's next read reach it. Withheld when the host cannot
  // reach core, for the same reason a tool the credential cannot back is
  // withheld — a listed tool that fails on every call is worse than none.
  const refresh = opts.refreshGateway
    ? [
        {
          name: "refresh_gateway",
          description:
            "Make the strad gateway re-read the parameter store NOW. The gateway holds one reading of " +
            "the store per process for gateway.secrets.ttlSeconds (an hour by default), so a value " +
            "written outside strad's console — including through this server's write tools — reaches " +
            "a running server within that window on its own. This drops the reading so the next read " +
            "reaches Parameter Manager. The write tools call it for you after a successful write; call " +
            "it yourself after a rotation made elsewhere (gcloud, another tool). Nothing is written. " +
            "The gateway refuses to re-read more than once every 30 seconds and says so.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
      ]
    : [];
  return [...readOnly, ...gated, ...refresh];
}

/**
 * What a write tool says about the gateway, after the write landed.
 *
 * Calls the refresh when the host gave us one, and reports what happened —
 * never throws, never hides: a write that landed but did not reach the gateway
 * yet is still a write that landed, and the agent should know both halves.
 */
async function gatewayNote(deps: ToolDeps): Promise<string> {
  if (!deps.refreshGateway) {
    return (
      "Stored. The gateway re-reads the store within gateway.secrets.ttlSeconds; this " +
      "server cannot reach it to make that sooner."
    );
  }
  const outcome = await deps.refreshGateway();
  return outcome.refreshed
    ? "Stored, and the gateway has dropped its reading of the store: the next read reaches this value."
    : `Stored. The gateway was not made to re-read it now (${outcome.reason}); it picks the value up ` +
        "within gateway.secrets.ttlSeconds, or call refresh_gateway.";
}

export function registerTools(server: Server, deps: ToolDeps): void {
  const { config } = deps;
  const { stores } = config;

  /** THE gate. Per project, fail closed, and the only way to obtain one. */
  const capsOf: CapabilityLookup =
    deps.capabilities ?? (() => Promise.resolve(NO_CAPABILITIES));

  const allCaps = async (): Promise<Map<string, Capabilities>> =>
    new Map(
      await Promise.all(
        stores.map(
          async (s) => [s.project, await capsOf(s.project)] as const,
        ),
      ),
    );

  /**
   * Resolve a path to its store, or an error naming why not.
   *
   * Every path-taking tool starts here — including the read-only ones, where it
   * is what keeps one store's namespace from being read with another store's
   * credential.
   */
  const resolve = (path: string) => storeForPath(path, stores);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions(config, await allCaps(), {
      refreshGateway: Boolean(deps.refreshGateway),
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "list_managed_namespaces": {
          // Reported from the PROBE, never from a constant, and PER STORE. A
          // single flat answer would be a lie on any deployment whose stores
          // differ — told to an agent, next to a tool list that is their union.
          const probes = await allCaps();
          return text({
            stores: stores.map((store) => {
              const probed = probes.get(store.project) ?? NO_CAPABILITIES;
              return {
                project: store.project,
                label: store.label ?? store.project,
                managedNamespaces: store.namespaces,
                canReadSecretValues: probed.readSecretValues,
                canWrite: probed.writeParameters,
                canWriteSecretValues: probed.writeSecretValues,
                canDelete: probed.deleteParameters,
                capabilitiesProbed: probed.probed,
                whyNot: probed.readSecretValues
                  ? undefined
                  : probed.probed
                    ? "This store's service account holds neither secretmanager.versions.access nor " +
                      "parametermanager.parameterVersions.render, so a secret value cannot be read " +
                      "from it here. That is denied by Google, not merely declined by this code."
                    : `This store's capabilities could not be established (${probed.reason ?? "no reason given"}), ` +
                      "so it fails closed: no write, no delete and no secret value.",
              };
            }),
            note:
              stores.length > 1
                ? "The tool LIST is the union of these stores — a tool is offered when any store can " +
                  "back it. Every CALL is checked against the store its path addresses, with that " +
                  "store's own credential, so a capability one store has is not a capability on another."
                : undefined,
            consoleUrl: consoleLink(config),
          });
        }

        case "list_parameters": {
          const namespace = String(
            (args as { namespace?: unknown } | undefined)?.namespace ?? "",
          );
          const store = storeForNamespace(namespace, stores);
          if (!store) {
            return error(
              `"${namespace}" is not a managed namespace. Managed: ${describeNamespaces(stores)}. ` +
                `Call list_managed_namespaces first.`,
            );
          }
          const parameters = await deps.reader(store).listParameters(namespace);
          return text({
            namespace,
            project: store.project,
            count: parameters.length,
            parameters,
            note:
              "Metadata only. Secret parameter values live in Secret Manager and this tool never returns one.",
          });
        }

        case "get_parameter": {
          const path = String(
            (args as { name?: unknown } | undefined)?.name ?? "",
          );
          const found = resolve(path);
          if (!found.store) return error(found.error);
          const record = await deps.reader(found.store).getParameter(path);
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
              `"${path}" is a SECRET parameter; its value lives in Secret Manager and this tool never ` +
                `returns one. Use open_secrets_manager to have a human view it in the console.`,
            );
          }
          return text({
            name: path,
            project: found.store.project,
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
          // THE PATH SELECTS THE STORE BEFORE ANY CAPABILITY IS CONSULTED, and
          // the capability consulted is that store's own. This is the gate the
          // whole multi-store design turns on: a permissive staging credential
          // must not open a read on a production project, and here it cannot,
          // because the answer being read is keyed by the project the path
          // resolved to.
          const found = resolve(path);
          if (!found.store) return error(found.error);
          const c = await capsOf(found.store.project);
          if (!c.readSecretValues) {
            return error(
              `store "${found.store.project}" cannot read secret values ` +
                `(${c.probed ? "no secretmanager.versions.access" : (c.reason ?? "capability unverified")}). ` +
                "That store is read with its own viewer credential, so Google refuses it too. " +
                "Use open_secrets_manager to have a human view it in the console.",
            );
          }
          const writer = deps.writer?.(found.store);
          if (!writer) return error("no client is configured for value reads");
          return text({
            name: path,
            project: found.store.project,
            value: await writer.readValue(path),
          });
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
          const found = resolve(path);
          if (!found.store) return error(found.error);
          const c = await capsOf(found.store.project);
          const denied = writeDenial(c, secret, found.store);
          if (denied) return error(denied);
          if (typeof a.value !== "string" || a.value === "") {
            return error("a non-empty `value` is required");
          }
          const writer = deps.writer?.(found.store);
          if (!writer) return error("no client is configured for writes");
          await writer.create({
            path,
            secret,
            value: a.value,
            note: typeof a.note === "string" && a.note ? a.note : undefined,
          });
          return text({
            created: path,
            project: found.store.project,
            variable: variableOf(path),
            secret,
            gateway: await gatewayNote(deps),
            note: "Whether a running server RESOLVES this path depends on that server's `params: true` and the deployment's resolver credential — see the console.",
          });
        }

        case "set_parameter_value": {
          const a = (args ?? {}) as { name?: unknown; value?: unknown };
          const path = String(a.name ?? "");
          const found = resolve(path);
          if (!found.store) return error(found.error);
          const c = await capsOf(found.store.project);
          const denied = writeDenial(c, false, found.store);
          if (denied) return error(denied);
          if (typeof a.value !== "string" || a.value === "") {
            return error("a non-empty `value` is required");
          }
          const writer = deps.writer?.(found.store);
          if (!writer) return error("no client is configured for writes");
          await writer.rotate(path, a.value);
          return text({
            rotated: path,
            project: found.store.project,
            variable: variableOf(path),
            gateway: await gatewayNote(deps),
          });
        }

        case "set_parameter_note": {
          const a = (args ?? {}) as { name?: unknown; note?: unknown };
          const path = String(a.name ?? "");
          const found = resolve(path);
          if (!found.store) return error(found.error);
          const c = await capsOf(found.store.project);
          const denied = writeDenial(c, false, found.store);
          if (denied) return error(denied);
          const writer = deps.writer?.(found.store);
          if (!writer) return error("no client is configured for writes");
          await writer.setNote(path, String(a.note ?? ""));
          return text({
            noted: path,
            project: found.store.project,
            variable: variableOf(path),
          });
        }

        case "delete_parameter": {
          const path = String((args as { name?: unknown } | undefined)?.name ?? "");
          const found = resolve(path);
          if (!found.store) return error(found.error);
          const c = await capsOf(found.store.project);
          if (!c.deleteParameters) {
            return error(
              `store "${found.store.project}" cannot delete parameters ` +
                `(${c.probed ? "no parametermanager.parameters.delete" : (c.reason ?? "capability unverified")}).`,
            );
          }
          const writer = deps.writer?.(found.store);
          if (!writer) return error("no client is configured for writes");
          await writer.destroy(path);
          return text({
            deleted: path,
            project: found.store.project,
            variable: variableOf(path),
            gateway: await gatewayNote(deps),
          });
        }

        case "refresh_gateway": {
          if (!deps.refreshGateway) {
            return error(
              "This server cannot reach the strad gateway (no STRAD_CORE_URL / STRAD_INTERNAL_TOKEN " +
                "in its environment). The gateway re-reads the store within gateway.secrets.ttlSeconds.",
            );
          }
          // A refresh the gateway held off — inside its 30-second floor, or
          // core not answering — is a plain outcome, not a tool error: nothing
          // is broken, the value lands within the TTL, and the write tools
          // report the same outcome the same way. The one error above is a
          // capability gap, which is different in kind.
          const outcome = await deps.refreshGateway();
          if (!outcome.refreshed) {
            return text({
              refreshed: false,
              reason: outcome.reason,
              note:
                "The gateway kept the reading it holds. It re-reads the store on its own within " +
                "gateway.secrets.ttlSeconds; call again after the floor if it must be sooner.",
            });
          }
          return text({
            refreshed: true,
            note:
              "The gateway dropped its reading of the store. Its next resolution of any ${NAME} " +
              "reaches Parameter Manager. Nothing was written.",
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

/**
 * Why a write to THIS STORE is refused, or null when it is permitted.
 *
 * Split by kind because the two failures have different fixes: a non-secret write
 * needs Parameter Manager only, a secret write needs Secret Manager too, and
 * telling someone "you cannot write" when they can in fact write configuration is
 * the kind of message that sends them to the wrong IAM page. The store is named
 * in every one of them, because on a multi-store server "which project" is the
 * first thing the reader needs and the message is otherwise identical for all of
 * them.
 */
function writeDenial(
  caps: Capabilities,
  secret: boolean,
  store: SecretsStore,
): string | null {
  if (!caps.probed) {
    return (
      `store "${store.project}": write capability could not be established ` +
      `(${caps.reason ?? "no reason given"}), so writes are refused rather than attempted.`
    );
  }
  if (!caps.writeParameters) {
    return (
      `store "${store.project}": this store's credential cannot write parameters (no ` +
      "parametermanager.parameters.create / parameterVersions.create). Use the console."
    );
  }
  if (secret && !caps.writeSecretValues) {
    return (
      `store "${store.project}": this store's credential can write configuration but not SECRET ` +
      "values (no secretmanager.secrets.create / versions.add). Pass secret: false, or set it in " +
      "the console."
    );
  }
  return null;
}

/**
 * The console link, with the parameter carried as a query parameter.
 *
 * `https://strad/ui/secrets` + `/strad/staging/mcp/.../VAR`
 *   -> `https://strad/ui/secrets?param=%2Fstrad%2Fstaging%2Fmcp%2F...%2FVAR`
 *
 * `SECRETS_CONSOLE_URL` IS FREE-FORM CONFIG AND MAY ALREADY CARRY A QUERY
 * STRING: on a multi-store console the URL that lands a human on the right store
 * is `.../ui/secrets?project=zimmer-secrets-prod`. A bare `?` join makes that one
 * query string whose `project` value is the whole rest of the link, and the
 * console reads an unrecognised `?project=` as a stale bookmark and falls back to
 * the first store — a deep link that opens silently on the WRONG store. So the
 * join goes through `URL`: `searchParams.set` joins with `&`, and replaces rather
 * than duplicates a `param` the configured URL already carries (a duplicate is
 * read as the first one, which is the configured one, not ours).
 *
 * An UNPARSEABLE `consoleUrl` falls back to concatenation, because free-form
 * config is not this function's to reject: `new URL()` throws where a
 * concatenation returns a string, and a relative value like `/ui/secrets` — a
 * usable link for a human on the same host — is exactly what throws. The only
 * value that yields no link at all is no value.
 */
function consoleLink(config: SecretsConfig, param?: string): string | undefined {
  if (!config.consoleUrl) return undefined;
  const base = config.consoleUrl.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return param ? `${base}?param=${encodeURIComponent(param)}` : base;
  }
  if (param) url.searchParams.set("param", param);
  return url.toString();
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
