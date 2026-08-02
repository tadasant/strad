import { z } from "zod";
import {
  PATH_DESCRIPTION,
  fail,
  ok,
  type StoreFactory,
  type ToolDefinition,
} from "./shared.js";

const PARAMS = { path: PATH_DESCRIPTION } as const;

export const DeleteSchema = z.object({
  path: z.string().min(1).describe(PARAMS.path),
});

const DESCRIPTION = `Permanently delete a stored artifact.

There is no undo and no trash. Every link to the artifact — signed, restricted, or
public — stops working at once, which makes this the ONLY way to genuinely revoke
access to something already shared.

**Example response:**
\`\`\`json
{ "path": "uploads/2026/08/02/081500-a1b2c3.png", "deleted": true }
\`\`\`

**Use cases:**
- Revoke an artifact whose signed link leaked (set_sensitivity cannot recall a
  signature that is already out there; deleting the object can)
- Remove something uploaded by mistake
- Clean up a batch of superseded screenshots after a human confirms

**Ask first.** Deleting an artifact a human might still want is not recoverable, so do
not do it on your own initiative unless the request was explicit.`;

export function deleteFileTool(storeFactory: StoreFactory): ToolDefinition {
  return {
    name: "delete_file",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: PARAMS.path } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args: unknown) => {
      try {
        const input = DeleteSchema.parse(args);
        await storeFactory().remove(input.path);
        return ok({ path: input.path, deleted: true });
      } catch (err) {
        return fail(err);
      }
    },
  };
}
