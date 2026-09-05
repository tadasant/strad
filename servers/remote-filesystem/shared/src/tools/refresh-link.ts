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

Signed links expire; the artifacts behind them do not. Give this a \`path\` and it returns
a working URL again; nothing is re-uploaded and the stored object does not change. Any
path in the bucket works, however old, and list_files finds one you do not have.

**Sensitivity is preserved, not re-decided.** A \`restricted\` artifact comes back with its
sign-in URL, \`expires_in_days\` ignored (that link never went stale) and \`sign_in_hint\`
for a human whose browser 403s it. The inverse is a signal: \`access: "link"\` on something
you believe is sensitive means the domain grant is gone. set_sensitivity changes either.

${LINK_HANDLING_DESCRIPTION}

**Use cases:**
- A link in an old PR comment or Slack message has expired
- A human asks to see an artifact from a previous session
- You need a longer-lived link than the one you first handed out
- Confirming an artifact's current access level`;

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
