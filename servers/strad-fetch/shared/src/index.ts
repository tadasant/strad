/**
 * strad fetch — web page retrieval over MCP.
 *
 * FORKED from `@pulsemcp/pulse-fetch` 0.3.3 (pulsemcp/mcp-servers@b1f13fe). The
 * deltas, and the evidence for each, are in ../../FORK.md. The one that matters
 * most is invisible from here: this tree is the `shared/` half ONLY. Upstream's
 * stdio entrypoint — which probed every configured credential at boot and called
 * `process.exit(1)` when one was rejected — is not vendored, and neither is the
 * health check it called. A rejected key is now a failed tool CALL.
 */
export * from './server.js';
export * from './resources.js';
export * from './tools.js';
