import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RuntimeConfig } from "../../config/runtime.ts";
import type {
  BuiltinContext,
  BuiltinModule,
  CallContext,
  CallToolResult,
  ServerAdapter,
} from "./types.ts";

/**
 * An MCP server that lives inside a strad process.
 *
 * This is how private/internal servers ship: tadasant-internal builds its own
 * strad image with its modules compiled in, and registers them with the same
 * one-line config entry a public server uses. Builtins are the cheap kind —
 * several of them colocate in one bundle component at no marginal cost.
 */
export class BuiltinServerAdapter implements ServerAdapter {
  readonly kind = "builtin" as const;

  constructor(
    readonly slug: string,
    private readonly mod: BuiltinModule,
    /**
     * The builtin's options, resolved ON EACH CALL rather than captured once.
     *
     * A builtin's `options:` may carry `${SECRET}` refs, and a `params: true`
     * builtin has its whole managed namespace merged in. Both can change under a
     * running process, so the adapter asks for them per call instead of holding
     * the values a boot happened to see. In the common case this is a lookup
     * against a warm cache, not a network round-trip.
     *
     * `listTools` deliberately does not call it: a tool LIST is static metadata
     * and needs no credential, so listing must not be able to fail on a secret
     * store outage.
     */
    private readonly options: () => Promise<Record<string, unknown>>,
    private readonly component: BuiltinContext["component"],
    /** The roster holder, for a builtin whose surface depends on it. */
    private readonly runtime?: () => RuntimeConfig | null,
  ) {}

  async listTools(): Promise<Tool[]> {
    // `visibleTools` where the module has one, `tools` where it does not.
    // Neither resolves `options`, so listing still cannot fail on a store
    // outage — see the note on the options thunk above.
    return (
      this.mod.visibleTools?.({
        component: this.component,
        ...(this.runtime ? { runtime: this.runtime } : {}),
      }) ?? this.mod.tools
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: CallContext,
  ): Promise<CallToolResult> {
    return this.mod.call(name, args, {
      options: await this.options(),
      component: this.component,
      ...(this.runtime ? { runtime: this.runtime } : {}),
      clientCapabilities: ctx?.clientCapabilities,
      principal: ctx?.principal,
    });
  }

  async close(): Promise<void> {
    // In-process: nothing to tear down.
  }
}

/**
 * Load a builtin module by specifier.
 *
 * A bare specifier ("@acme/mcp-thing") is resolved as a package. A relative one
 * ("./servers/echo.js") is resolved against the SOURCE ROOT — src/ when running
 * from TypeScript, dist/ when running the built image — not against this file's
 * directory, which would make every config entry start with "../../".
 *
 * Accepts either module shape, because both are natural to write:
 *   export default { tools, call }
 *   export const tools = [...]; export async function call() {}
 */
export async function loadBuiltin(specifier: string): Promise<BuiltinModule> {
  const mod = (await importFromRoot(specifier)) as {
    default?: BuiltinModule;
    tools?: Tool[];
    call?: BuiltinModule["call"];
  };

  const candidate = mod.default ?? (mod as unknown as BuiltinModule);

  if (!Array.isArray(candidate.tools) || typeof candidate.call !== "function") {
    throw new Error(
      `builtin module "${specifier}" must export { tools: Tool[], call(name, args, ctx) } ` +
        `(as a default export or as named exports)`,
    );
  }
  return candidate;
}

/** src/ in development, dist/ in the built image. */
const SOURCE_ROOT = new URL("../../", import.meta.url);

async function importFromRoot(specifier: string): Promise<unknown> {
  if (!specifier.startsWith(".")) return import(specifier);

  const resolved = new URL(specifier, SOURCE_ROOT).href;
  try {
    return await import(resolved);
  } catch (err) {
    // Configs name the *built* file ("./servers/echo.js") because that is what
    // ships. When running from source under --experimental-strip-types, that
    // file does not exist — the .ts does. Fall back rather than making the
    // config differ between dev and prod.
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND")
      throw err;
    if (!resolved.endsWith(".js")) throw err;
    return import(`${resolved.slice(0, -3)}.ts`);
  }
}
