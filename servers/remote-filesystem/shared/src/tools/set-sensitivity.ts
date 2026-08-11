import { z } from "zod";
import { DEFAULT_LINK_DAYS, MAX_LINK_DAYS } from "../config.js";
import {
  EXPIRES_DESCRIPTION,
  PATH_DESCRIPTION,
  SENSITIVE_DESCRIPTION,
  artifactPayload,
  fail,
  ok,
  type StoreFactory,
  type ToolDefinition,
} from "./shared.js";

const PARAMS = {
  path: PATH_DESCRIPTION,
  is_sensitive: SENSITIVE_DESCRIPTION,
  expires_in_days: EXPIRES_DESCRIPTION,
} as const;

export const SetSensitivitySchema = z.object({
  path: z.string().min(1).describe(PARAMS.path),
  is_sensitive: z.boolean().describe(PARAMS.is_sensitive),
  expires_in_days: z
    .number()
    .positive()
    .max(MAX_LINK_DAYS)
    .optional()
    .describe(PARAMS.expires_in_days),
});

const DESCRIPTION = `Change whether an already-uploaded artifact is sensitive, and get its new link.

This is the correction path. If you uploaded something with the wrong sensitivity —
most importantly, if you uploaded genuinely sensitive material without
\`is_sensitive: true\` — call this immediately with \`is_sensitive: true\`. The object
becomes readable only to signed-in members of the viewer domain, and the old signed
URL... see the warning below.

\`is_sensitive: false\` goes the other way: it drops the domain grant, and the artifact
goes back to being reachable through a time-limited signed link.

**⚠️ A signed URL you already handed out keeps working.** A signature is valid until
it expires, independently of the object's ACL. Restricting an artifact stops NEW
readers from reaching it and stops new signed links being minted, but it cannot recall
a URL already pasted into a message. If the artifact truly must not be readable, use
delete_file and re-upload with \`is_sensitive: true\`.

**⚠️ And if the artifact was ever \`public\`, Google's edge may serve the old copy for
up to an hour** after you restrict it, from the plain \`storage.googleapis.com\` URL.
Restricting is still the right first move, but treat it as "no new readers", not "no
readers", and say so if a human is relying on it.

**Example response:**
\`\`\`json
{
  "path": "screenshots/net-worth-2026.png",
  "url": "https://storage.cloud.google.com/artifacts/screenshots/net-worth-2026.png?authuser=dana%40example.com",
  "access": "restricted",
  "requires_sign_in": true,
  "expires_at": null,
  "signing_version": null,
  "size_bytes": 88213,
  "content_type": "image/png",
  "bucket": "artifacts",
  "viewer_domain": "example.com",
  "viewer_account": "dana@example.com",
  "sign_in_hint": "Opens only for a signed-in example.com account. ..."
}
\`\`\`

The \`?authuser=\` suffix and \`viewer_account\` appear only when an operator has
configured an account for this deployment; \`sign_in_hint\` is always there.

**Pass \`sign_in_hint\` on when a restricted link does not open.** A reader signed in
to several Google accounts gets a 403 from the default one even though the grant is
correct, and the hint says how to pick the right account. It is the answer to "your
link is broken" — do not let that get filed as a permissions bug.

**Use cases:**
- You realise after uploading that a screenshot shows account balances
- A human asks you to lock down an artifact you already shared
- Un-restricting an artifact that turned out not to be sensitive, so it stops
  demanding a login
- Checking and correcting the access level of an old artifact`;

export function setSensitivityTool(storeFactory: StoreFactory): ToolDefinition {
  return {
    name: "set_sensitivity",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: PARAMS.path },
        is_sensitive: { type: "boolean", description: PARAMS.is_sensitive },
        expires_in_days: {
          type: "number",
          minimum: 1,
          maximum: MAX_LINK_DAYS,
          default: DEFAULT_LINK_DAYS,
          description: PARAMS.expires_in_days,
        },
      },
      required: ["path", "is_sensitive"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args: unknown) => {
      try {
        const input = SetSensitivitySchema.parse(args);
        const store = storeFactory();
        const { artifact, link } = await store.setSensitive(
          input.path,
          input.is_sensitive,
          input.expires_in_days ?? store.defaultLinkDays(),
        );
        const warning =
          artifact.access === "public"
            ? {
                warning:
                  "This object carries an allUsers grant from an earlier configuration, " +
                  "so it is world-readable regardless of link expiry. Delete and re-upload " +
                  "it if that is not intended.",
              }
            : {};
        return ok(artifactPayload(store, artifact, link, warning));
      } catch (err) {
        return fail(err);
      }
    },
  };
}
