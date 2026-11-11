/**
 * Logging for the Google Drive MCP server.
 *
 * IMPORTANT: everything goes to stderr. A stdio-transported MCP server must keep
 * stdout free for JSON-RPC, and the bundle host's stdout is not shipped anywhere
 * either — see strad's AGENTS.md on logging.
 */

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERROR] ${context}: ${message}`);
}
