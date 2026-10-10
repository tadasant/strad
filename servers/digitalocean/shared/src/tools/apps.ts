/**
 * App Platform: list and read apps, follow a deployment, read its logs, and
 * create, update, redeploy or delete an app.
 *
 * LOGS LIVE ON ANOTHER ORIGIN. The logs endpoint does not return log text; it
 * returns `historic_urls` (pre-signed links to object storage) and a
 * `live_url` (a websocket). apps-get-logs fetches the first historic link with
 * NO credential — see `fetchExternalText` in client.ts — and returns a bounded
 * tail. The signed link itself is never returned: it is a bearer credential
 * for those logs for as long as it lives. The websocket is never opened: a
 * selection that has only a `live_url` is reported as live-only.
 *
 * A REDACTED SPEC IS NOT A SPEC. apps-get-info's spec has passed through
 * `redactSecrets` (secrets.ts), so a plaintext credential in it reads
 * "[redacted]". apps-update is a full replace; sending that spec back would
 * store the literal marker as the app's password. Both spec-taking writes
 * refuse any spec carrying the marker, before a request is made.
 */

import { listPage, type DigitalOceanClient } from "../client.js";
import { InputError } from "../errors.js";
import { findRedactionMarkers, REDACTED } from "../secrets.js";
import { pick } from "./account.js";
import {
  args,
  boundedInt,
  CREATE,
  DESTRUCTIVE_IDEMPOTENT,
  enumValue,
  guard,
  optionalBool,
  optionalString,
  optionalUuid,
  pageArgs,
  PAGE_PROPERTIES,
  READ,
  requiredObject,
  uuid,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

type Row = Record<string, unknown>;

const APP_ID = {
  type: "string",
  description: "The app's id (a UUID), from apps-list.",
};

const DEPLOYMENT_ID = {
  type: "string",
  description:
    "A deployment id (UUID), from apps-get-info's `active_deployment` / " +
    "`in_progress_deployment` or a previous call. Omit for the default " +
    "described above.",
};

const FROM_APPS = "apps-list";

/** The component kinds an app spec can declare, each a list of `{name, …}`. */
const COMPONENT_KINDS = [
  "services",
  "workers",
  "jobs",
  "static_sites",
  "functions",
] as const;

function components(spec: unknown): Row {
  const s = (spec && typeof spec === "object" ? spec : {}) as Row;
  const out: Row = {};
  for (const kind of COMPONENT_KINDS) {
    const list = s[kind];
    if (Array.isArray(list) && list.length > 0) {
      out[kind] = list.map((c) => (c as Row)?.name);
    }
  }
  return out;
}

function deploymentBrief(raw: unknown): Row | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return pick(raw, ["id", "phase", "cause", "created_at", "updated_at"]);
}

export function summariseApp(raw: unknown): Row {
  const a = (raw && typeof raw === "object" ? raw : {}) as Row;
  const spec = (a.spec ?? {}) as Row;
  const region = a.region as Row | undefined;
  return {
    id: a.id,
    name: spec.name,
    region: region?.slug ?? spec.region,
    ...pick(a, ["live_url", "default_ingress", "tier_slug"]),
    components: components(spec),
    active_deployment: deploymentBrief(a.active_deployment),
    in_progress_deployment: deploymentBrief(a.in_progress_deployment),
    ...pick(a, ["last_deployment_active_at", "created_at", "updated_at"]),
  };
}

export function appsListTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "apps-list",
    description:
      "App Platform apps on the account, one page at a time, summarised: id, " +
      "name, region, live_url, component names by kind, and the active and " +
      "in-progress deployment (id, phase, cause). apps-get-info has the full " +
      "spec.\n\n" +
      'Example row: {"id":"4f6c71e2-…","name":"strad","region":"nyc",' +
      '"live_url":"https://strad-abc.ondigitalocean.app","components":' +
      '{"services":["core"]},"active_deployment":{"id":"b6bb…","phase":"ACTIVE"}}',
    inputSchema: {
      type: "object",
      properties: { ...PAGE_PROPERTIES },
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const { page, perPage } = pageArgs(args(raw));
        const result = await listPage<Row>(
          api(),
          "/apps",
          "apps",
          page,
          perPage,
        );
        return { ...result, items: result.items.map(summariseApp) };
      }),
  };
}

export function appsGetInfoTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "apps-get-info",
    description:
      "One App Platform app in full, including its complete `spec` — the " +
      "document apps-update takes. Read this BEFORE apps-update: an update " +
      "replaces the whole spec, so edit this one rather than writing a new " +
      "one. Env vars of type SECRET come back encrypted (`EV[…]`) and can be " +
      "sent back unchanged.\n\n" +
      "CREDENTIALS ARE REDACTED, and a redacted spec cannot be sent back as " +
      "it is: a password in a `scheme://user:password@` URI or a " +
      "`?password=` parameter, a plaintext env var whose key names a " +
      "credential (`…_PASSWORD`, `…_TOKEN`, `…_SECRET`, `API_KEY`), and " +
      "fields such as a log destination's `api_key` read `" +
      REDACTED +
      "`. apps-update refuses a spec that still carries that marker; " +
      "re-supply the real value (as a type SECRET env var) or remove the " +
      "field.",
    inputSchema: {
      type: "object",
      properties: { app_id: APP_ID },
      required: ["app_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = uuid(args(raw), "app_id", FROM_APPS);
        const body = await api().request<{ app?: Row }>(`/apps/${id}`);
        return body?.app ?? {};
      }),
  };
}

/** Every step, at any depth, that failed — the part of `progress` worth reading. */
function failedSteps(steps: unknown, out: Row[] = []): Row[] {
  if (!Array.isArray(steps)) return out;
  for (const step of steps as Row[]) {
    if (step?.status === "ERROR") {
      out.push(
        pick(step, ["name", "component_name", "reason", "message_base"]),
      );
    }
    failedSteps(step?.steps, out);
  }
  return out;
}

async function latestDeployment(
  client: DigitalOceanClient,
  appId: string,
): Promise<Row | undefined> {
  const page = await listPage<Row>(
    client,
    `/apps/${appId}/deployments`,
    "deployments",
    1,
    1,
  );
  return page.items[0];
}

export function appsGetDeploymentStatusTool(
  factory: ClientFactory,
): ToolDefinition {
  return {
    name: "apps-get-deployment-status",
    description:
      "Where one deployment of an app has got to. Defaults to the app's MOST " +
      "RECENT deployment (whatever its outcome), which is the one to watch " +
      "after apps-update or apps-create-deployment.\n\n" +
      "`phase` is PENDING_BUILD, BUILDING, PENDING_DEPLOY, DEPLOYING, ACTIVE " +
      "(live), SUPERSEDED (an older one, replaced), ERROR or CANCELED. " +
      "`failed_steps` names what broke; apps-get-logs with type BUILD or " +
      "DEPLOY has the detail. Poll every 15-30 s; builds take minutes.\n\n" +
      'Example: {"id":"b6bb…","phase":"ERROR","cause":"commit 1a2b pushed",' +
      '"progress":{"success_steps":3,"error_steps":1,"total_steps":6},' +
      '"failed_steps":[{"name":"build","component_name":"core","reason":' +
      '{"code":"BuildJobFailed"}}]}',
    inputSchema: {
      type: "object",
      properties: { app_id: APP_ID, deployment_id: DEPLOYMENT_ID },
      required: ["app_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const appId = uuid(input, "app_id", FROM_APPS);
        const deploymentId = optionalUuid(
          input,
          "deployment_id",
          "apps-get-info",
        );
        const client = api();
        let deployment: Row | undefined;
        if (deploymentId) {
          const body = await client.request<{ deployment?: Row }>(
            `/apps/${appId}/deployments/${deploymentId}`,
          );
          deployment = body?.deployment;
        } else {
          deployment = await latestDeployment(client, appId);
        }
        if (!deployment) {
          return {
            app_id: appId,
            deployment: null,
            note: "This app has no deployments.",
          };
        }
        const progress = (deployment.progress ?? {}) as Row;
        return {
          ...pick(deployment, [
            "id",
            "phase",
            "cause",
            "created_at",
            "updated_at",
            "phase_last_updated_at",
          ]),
          progress: pick(progress, [
            "success_steps",
            "error_steps",
            "pending_steps",
            "running_steps",
            "total_steps",
          ]),
          failed_steps: failedSteps(progress.steps),
          ...(deploymentId ? {} : { selected: "most recent deployment" }),
        };
      }),
  };
}

export const LOG_TYPES = ["BUILD", "DEPLOY", "RUN", "RUN_RESTARTED"] as const;
export const MAX_LOG_LINES = 200;
export const MAX_LOG_BYTES = 64 * 1024;

/**
 * The last `maxLines` lines of `text`, then trimmed from the FRONT until it fits
 * `maxBytes` — the end of a log is where the failure is.
 */
export function tail(
  text: string,
  maxLines: number,
  maxBytes: number,
): {
  text: string;
  total_lines: number;
  returned_lines: number;
  dropped_lines: number;
  total_bytes: number;
  returned_bytes: number;
} {
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  let kept = lines.slice(Math.max(0, total - maxLines));
  let joined = kept.join("\n");
  while (kept.length > 1 && Buffer.byteLength(joined, "utf8") > maxBytes) {
    kept = kept.slice(1);
    joined = kept.join("\n");
  }
  // One line longer than the whole budget keeps its END.
  let buf = Buffer.from(joined, "utf8");
  if (buf.length > maxBytes) {
    buf = buf.subarray(buf.length - maxBytes);
    joined = buf.toString("utf8").replace(/^�+/, "");
  }
  return {
    text: joined,
    total_lines: total,
    returned_lines: kept.length,
    dropped_lines: total - kept.length,
    total_bytes: totalBytes,
    returned_bytes: Buffer.byteLength(joined, "utf8"),
  };
}

export function appsGetLogsTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "apps-get-logs",
    description:
      "The tail of an app's logs, as text. `type` is BUILD (the image build), " +
      "DEPLOY (rollout and health checks), RUN (the running process; " +
      "default) or RUN_RESTARTED (the run before the component's last " +
      "restart — where a crash is). Pass `component_name` (from apps-list's `components`) for " +
      "one component, or omit it for all of them interleaved.\n\n" +
      "With no `deployment_id`: RUN and RUN_RESTARTED read the ACTIVE " +
      "deployment; BUILD and " +
      "DEPLOY read the MOST RECENT one, which is where a failed build is. " +
      "The result says which deployment it read.\n\n" +
      `BOUNDED: at most \`max_lines\` (default and cap ${MAX_LOG_LINES}) and ` +
      `\`max_bytes\` (default and cap ${MAX_LOG_BYTES}) from the END of the ` +
      "log; `dropped_lines` says how much earlier output was not returned. " +
      "This is a snapshot, not a stream: a selection DigitalOcean serves only " +
      "live says so and returns no text. Passwords in `scheme://user:pw@` " +
      "URIs and `?password=` parameters are redacted from the text.\n\n" +
      'Example: {"deployment_id":"b6bb…","type":"BUILD","component_name":' +
      '"core","total_lines":912,"returned_lines":200,"dropped_lines":712,' +
      '"text":"…npm ERR! code ELIFECYCLE"}',
    inputSchema: {
      type: "object",
      properties: {
        app_id: APP_ID,
        type: {
          type: "string",
          enum: [...LOG_TYPES],
          description: "BUILD, DEPLOY, RUN or RUN_RESTARTED. Default RUN.",
        },
        component_name: {
          type: "string",
          description: "One component's name; omit for all.",
        },
        deployment_id: DEPLOYMENT_ID,
        max_lines: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LOG_LINES,
          description: `Lines from the end (1-${MAX_LOG_LINES}). Default ${MAX_LOG_LINES}.`,
        },
        max_bytes: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LOG_BYTES,
          description: `Byte ceiling on the returned text (1-${MAX_LOG_BYTES}). Default ${MAX_LOG_BYTES}.`,
        },
      },
      required: ["app_id"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const appId = uuid(input, "app_id", FROM_APPS);
        const type = enumValue(input, "type", LOG_TYPES) ?? "RUN";
        const component = optionalString(input, "component_name");
        if (
          component !== undefined &&
          !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(component)
        ) {
          throw new InputError(
            `\`component_name\`="${component}" is not a component name. Take it from apps-list's \`components\`.`,
          );
        }
        let deploymentId = optionalUuid(
          input,
          "deployment_id",
          "apps-get-info",
        );
        const maxLines = boundedInt(
          input,
          "max_lines",
          MAX_LOG_LINES,
          MAX_LOG_LINES,
        );
        const maxBytes = boundedInt(
          input,
          "max_bytes",
          MAX_LOG_BYTES,
          MAX_LOG_BYTES,
        );

        const client = api();
        let selected: string | undefined;
        if (!deploymentId) {
          if (type === "RUN" || type === "RUN_RESTARTED") {
            const body = await client.request<{ app?: Row }>(`/apps/${appId}`);
            const active = body?.app?.active_deployment as Row | undefined;
            if (typeof active?.id === "string") {
              deploymentId = active.id;
              selected = "active deployment";
            }
          }
          if (!deploymentId) {
            const latest = await latestDeployment(client, appId);
            if (typeof latest?.id === "string") {
              deploymentId = latest.id;
              selected = "most recent deployment";
            }
          }
          if (!deploymentId) {
            return {
              app_id: appId,
              type,
              text: "",
              note: "This app has no deployments, so it has no logs.",
            };
          }
        }

        const path = component
          ? `/apps/${appId}/deployments/${deploymentId}/components/${component}/logs`
          : `/apps/${appId}/deployments/${deploymentId}/logs`;
        const links = await client.request<{
          historic_urls?: unknown;
          live_url?: unknown;
        }>(path, {
          query: { type, follow: false },
        });
        const urls = Array.isArray(links?.historic_urls)
          ? links.historic_urls.filter(
              (u): u is string => typeof u === "string",
            )
          : [];
        const header = {
          app_id: appId,
          deployment_id: deploymentId,
          ...(selected ? { selected } : {}),
          type,
          ...(component ? { component_name: component } : {}),
        };
        if (urls.length === 0) {
          // The live link is not returned either: like a historic one, it
          // authorises by itself.
          if (typeof links?.live_url === "string" && links.live_url !== "") {
            return {
              ...header,
              text: "",
              live_only: true,
              note:
                "DigitalOcean has no stored logs for this selection, only a live " +
                "stream (a websocket), and this server does not open one. Stored " +
                "logs appear once DigitalOcean archives them; call again in a few " +
                "minutes, or read the live stream in the control panel or with " +
                "`doctl apps logs --follow`.",
            };
          }
          return {
            ...header,
            text: "",
            note:
              "DigitalOcean returned no stored logs for this selection. A component that " +
              "never started has no RUN logs; try BUILD or DEPLOY.",
          };
        }
        const fetched = await client.fetchExternalText(urls[0]!);
        const out = tail(fetched.text, maxLines, maxBytes);
        if (!fetched.truncated) return { ...header, ...out };
        return {
          ...header,
          ...out,
          total_bytes: fetched.bytes,
          fetch_truncated: true,
          note:
            `The stored log is ${fetched.bytes} bytes; only its last ` +
            `${fetched.kept_bytes} were read, so \`total_lines\` and ` +
            "`dropped_lines` count that window, not the whole log.",
        };
      }),
  };
}

const SPEC_DESCRIPTION =
  "The app spec as a JSON object — the same document `doctl apps spec get` " +
  'prints, e.g. {"name":"web","region":"nyc","services":[{"name":' +
  '"api","github":{"repo":"owner/repo","branch":"main"},' +
  '"instance_size_slug":"apps-s-1vcpu-0.5gb","http_port":8080}]}.';

/**
 * The `spec` argument, refused if it still carries the REDACTED marker anywhere.
 * The marker only ever comes from this server's own redaction, so a spec that
 * has one is apps-get-info's output sent back with a credential in it replaced.
 */
function specWithoutMarkers(input: Record<string, unknown>): Row {
  const spec = requiredObject(input, "spec");
  const found = findRedactionMarkers(spec, "spec");
  if (found.length === 0) return spec;
  const shown = found.slice(0, 5).join(", ");
  const more = found.length > 5 ? ` and ${found.length - 5} more` : "";
  throw new InputError(
    `\`spec\` contains the literal "${REDACTED}" marker at ${shown}${more}. ` +
      "apps-get-info redacts credentials before returning a spec, so that " +
      "text is not the real value, and sending it would store " +
      `"${REDACTED}" in its place. Re-supply the real value there (an env ` +
      "var holding a credential should be `type: SECRET`, which DigitalOcean " +
      "encrypts and apps-get-info returns as `EV[…]`), or remove the env var " +
      "or field. Nothing was sent.",
  );
}

export function appsCreateAppFromSpecTool(
  factory: ClientFactory,
): ToolDefinition {
  return {
    name: "apps-create-app-from-spec",
    description:
      "Create an App Platform app from a spec. The first deployment starts at " +
      "once and the app bills from then; follow it with " +
      "apps-get-deployment-status. Returns the app summary. A spec that " +
      "points at a private repository needs DigitalOcean's GitHub app " +
      "installed on it first — a human does that in the control panel. A " +
      "spec carrying the `" +
      REDACTED +
      "` marker is refused.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "object", description: SPEC_DESCRIPTION },
        project_id: {
          type: "string",
          description: "Project to put it in; the default project if omitted.",
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
    annotations: CREATE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const spec = specWithoutMarkers(input);
        const projectId = optionalString(input, "project_id");
        const body = await api().request<{ app?: Row }>("/apps", {
          method: "POST",
          body: { spec, ...(projectId ? { project_id: projectId } : {}) },
        });
        return {
          app: summariseApp(body?.app),
          next: "Follow the first deployment with apps-get-deployment-status.",
        };
      }),
  };
}

export function appsUpdateTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "apps-update",
    description:
      "Replace an app's spec. THIS IS A FULL REPLACE, NOT A PATCH: a " +
      "component, env var, domain or alert missing from `spec` is DELETED " +
      "from the app. Always start from apps-get-info's `spec`, change only " +
      "what you mean to, and send the whole thing back. A removed domain " +
      "detaches it and breaks TLS for that hostname.\n\n" +
      "apps-get-info REDACTS credentials, and a spec that still carries the " +
      "`" +
      REDACTED +
      "` marker anywhere is refused with nothing sent: replace each marked " +
      "value with the real one (a credential env var as `type: SECRET`) or " +
      "remove that env var or field first.\n\n" +
      "Most changes trigger a new deployment; follow it with " +
      "apps-get-deployment-status. Returns the app summary.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: APP_ID,
        spec: {
          type: "object",
          description: `The COMPLETE new spec. ${SPEC_DESCRIPTION}`,
        },
      },
      required: ["app_id", "spec"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = uuid(input, "app_id", FROM_APPS);
        const spec = specWithoutMarkers(input);
        const body = await api().request<{ app?: Row }>(`/apps/${id}`, {
          method: "PUT",
          body: { spec },
        });
        return {
          app: summariseApp(body?.app),
          next: "If this started a deployment, follow it with apps-get-deployment-status.",
        };
      }),
  };
}

export function appsCreateDeploymentTool(
  factory: ClientFactory,
): ToolDefinition {
  return {
    name: "apps-create-deployment",
    description:
      "Redeploy an app with its current spec — pulling the latest commit of " +
      "the tracked branch, or the image tag. `force_build: true` rebuilds even " +
      "when the source has not changed (a stale cache, a changed base " +
      "image). The live deployment keeps serving until the new one is " +
      "healthy. Returns the deployment; follow it with " +
      "apps-get-deployment-status.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: APP_ID,
        force_build: {
          type: "boolean",
          description: "Rebuild from scratch. Default false.",
        },
      },
      required: ["app_id"],
      additionalProperties: false,
    },
    annotations: CREATE,
    handler: (raw) =>
      guard(factory, async (api) => {
        const input = args(raw);
        const id = uuid(input, "app_id", FROM_APPS);
        const force = optionalBool(input, "force_build") ?? false;
        const body = await api().request<{ deployment?: Row }>(
          `/apps/${id}/deployments`,
          {
            method: "POST",
            body: { force_build: force },
          },
        );
        return pick(body?.deployment, ["id", "phase", "cause", "created_at"]);
      }),
  };
}

export function appsDeleteTool(factory: ClientFactory): ToolDefinition {
  return {
    name: "apps-delete",
    description:
      "DELETE an App Platform app, permanently: every component, its " +
      "deployments and logs, its `ondigitalocean.app` hostname, and the " +
      "attachment of any custom domain. Dev databases created inside the app " +
      "go with it; managed database clusters do not. There is no undo — " +
      "confirm the id with apps-get-info first.",
    inputSchema: {
      type: "object",
      properties: { app_id: APP_ID },
      required: ["app_id"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE_IDEMPOTENT,
    handler: (raw) =>
      guard(factory, async (api) => {
        const id = uuid(args(raw), "app_id", FROM_APPS);
        await api().request(`/apps/${id}`, { method: "DELETE" });
        return { deleted: true, app_id: id };
      }),
  };
}
