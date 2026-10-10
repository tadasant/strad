import { PAGE_SIZE } from "../client.js";
import {
  args,
  BASE_ID,
  boundedInt,
  guard,
  ok,
  optionalString,
  READ,
  RECORD_ID,
  requiredString,
  requiredText,
  TABLE_ID,
  type ClientFactory,
  type ToolDefinition,
} from "./shared.js";

export function createCommentTool(client: ClientFactory): ToolDefinition {
  return {
    name: "create_comment",
    description:
      "Post a comment on a record, as the human who owns the token. Mention a " +
      "collaborator with @[usrXXXXXXXXXXXXXX]; reply in a thread with " +
      "`parentCommentId`.\n\n" +
      'Returns: {"comment":{"id":"comA1b2C3d4E5f6G7","createdTime":' +
      '"2026-10-09T12:00:00.000Z","lastUpdatedTime":null,"text":"Looks good",' +
      '"author":{"id":"usr…","email":"ada@example.com","name":"Ada"}}}',
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        recordId: RECORD_ID,
        text: { type: "string", description: "The comment text." },
        parentCommentId: {
          type: "string",
          description:
            "Reply under this comment ID instead of at the top level.",
        },
      },
      required: ["baseId", "tableId", "recordId", "text"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const recordId = requiredString(input, "recordId");
        // Not trimmed: a comment's leading indentation or trailing newline is the author's.
        const text = requiredText(input, "text");
        const parent = optionalString(input, "parentCommentId");
        const comment = await (
          await client()
        ).createComment(baseId, tableId, recordId, text, parent);
        return ok({ comment });
      }),
  };
}

export function listCommentsTool(client: ClientFactory): ToolDefinition {
  return {
    name: "list_comments",
    description:
      "List the comments on a record, newest first, one page per call.\n\n" +
      'Example: {"comments":[{"id":"comA1b2C3d4E5f6G7","createdTime":' +
      '"2026-10-09T12:00:00.000Z","lastUpdatedTime":null,"text":"Looks good",' +
      '"author":{"id":"usr…","email":"ada@example.com"}}],"offset":null}\n\n' +
      "`offset` is null on the last page; otherwise pass it back for the next.",
    inputSchema: {
      type: "object",
      properties: {
        baseId: BASE_ID,
        tableId: TABLE_ID,
        recordId: RECORD_ID,
        pageSize: {
          type: "integer",
          description: `Comments per page (1-${PAGE_SIZE}, default ${PAGE_SIZE}).`,
        },
        offset: {
          type: "string",
          description: "The `offset` from the previous page.",
        },
      },
      required: ["baseId", "tableId", "recordId"],
      additionalProperties: false,
    },
    annotations: READ,
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const baseId = requiredString(input, "baseId");
        const tableId = requiredString(input, "tableId");
        const recordId = requiredString(input, "recordId");
        const pageSize = boundedInt(input, "pageSize", PAGE_SIZE, PAGE_SIZE);
        const offset = optionalString(input, "offset");
        return ok(
          await (
            await client()
          ).listComments(baseId, tableId, recordId, pageSize, offset),
        );
      }),
  };
}
