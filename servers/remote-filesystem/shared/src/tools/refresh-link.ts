import { z } from "zod";
import { DEFAULT_LINK_DAYS, MAX_LINK_DAYS } from "../config.js";
import {
  EXPIRES_DESCRIPTION,
  LINK_HANDLING_DESCRIPTION,
  PATH_DESCRIPTION,
  artifactPayload,
  fail,
  ok,
  type StoreFactory,
  type ToolDefinition,
} from "./shared.js";

const PARAMS = {
  path: PATH_DESCRIPTION,
  expires_in_days: EXPIRES_DESCRIPTION,
} as const;

export const RefreshLinkSchema = z.object({
  path: z.string().min(1).describe(PARAMS.path),
  expires_in_days: z
    .number()
    .positive()
    .max(MAX_LINK_DAYS)
    .optional()
    .describe(PARAMS.expires_in_days),
});

const DESCRIPTION = `Mint a fresh link for an artifact whose old link has expired.

Signed links expire; the artifacts behind them do not. When a human says "that
screenshot link is dead" or asks you to dig up an artifact from weeks ago, this is the
tool: give it the artifact's \`path\` and it returns a working URL again. Nothing is
re-uploaded and nothing changes about the stored object.

It also works on artifacts uploaded long before, by any tool, anywhere in the bucket —
there is no prefix confinement, so an old path is still a valid handle.

**Finding the path:** if you have the original upload_file response, use its \`path\`.
If you do not, call list_files first — its \`prefix\` parameter narrows to a directory
and its results carry the exact paths.

**Example response:**
\`\`\`json
{
  "path": "screenshots/8379/v1-kpi-dashboard.png",
  "url": "https://storage.googleapis.com/artifacts/screenshots/8379/v1-kpi-dashboard.png?GoogleAccessId=...&Expires=1788000000&Signature=...",
  "access": "link",
  "requires_sign_in": false,
  "expires_at": "2026-08-16T09:00:00.000Z",
  "signing_version": "v2",
  "size_bytes": 6988,
  "content_type": "image/png",
  "bucket": "artifacts"
}
\`\`\`

**Sensitivity is preserved, not re-decided.** If the artifact is \`restricted\`, you get
its sign-in URL back and \`expires_in_days\` is ignored — that link never went stale in
the first place. To CHANGE whether an artifact is sensitive, use set_sensitivity.

A \`restricted\` response also carries \`viewer_domain\` and \`sign_in_hint\` (and
\`viewer_account\` where one is configured). Hand \`sign_in_hint\` to any human whose
link 403s — the usual cause is their browser opening it as the wrong one of several
signed-in Google accounts, not a missing grant. And note the inverse: \`access: "link"\`
on something you believe is sensitive means the domain grant is gone, so it 403s for
everyone; set_sensitivity puts it back.

${LINK_HANDLING_DESCRIPTION}

**Use cases:**
- A link in an old PR comment or Slack message has expired
- A human asks to see an artifact from a previous session
- You need a longer-lived link than the one you first handed out
- Confirming what an artifact's current access level actually is`;

export function refreshLinkTool(storeFactory: StoreFactory): ToolDefinition {
  return {
    name: "refresh_link",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: PARAMS.path },
        expires_in_days: {
          type: "number",
          minimum: 1,
          maximum: MAX_LINK_DAYS,
          default: DEFAULT_LINK_DAYS,
          description: PARAMS.expires_in_days,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args: unknown) => {
      try {
        const input = RefreshLinkSchema.parse(args);
        const store = storeFactory();
        const { artifact, link } = await store.link(
          input.path,
          input.expires_in_days ?? store.defaultLinkDays(),
        );
        return ok(artifactPayload(store, artifact, link));
      } catch (err) {
        return fail(err);
      }
    },
  };
}
