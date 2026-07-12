import type {
  BuiltinContext,
  BuiltinModule,
} from "../gateway/adapters/types.ts";

/**
 * An example `builtin` server.
 *
 * strad ships ZERO servers by default. This one exists so that the config
 * example, the tests, and a fresh staging deploy have something real to talk to
 * — and so anyone writing their first builtin has a 40-line reference.
 *
 * It is NOT mounted unless a config entry names it:
 *
 *   servers:
 *     - slug: echo
 *       kind: builtin
 *       module: "./servers/echo.js"
 *       entitlements: [admin]
 */
const mod: BuiltinModule = {
  tools: [
    {
      name: "echo",
      description:
        "Return whatever text you send. Useful for proving a path works.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to echo back." },
        },
        required: ["text"],
      },
    },
    {
      name: "whoami",
      description:
        "Report which strad component served this call — the gateway itself, or a bundle component reached over the private network.",
      inputSchema: { type: "object", properties: {} },
    },
  ],

  async call(name: string, args: Record<string, unknown>, ctx: BuiltinContext) {
    switch (name) {
      case "echo": {
        const text = typeof args.text === "string" ? args.text : "";
        return { content: [{ type: "text", text }] };
      }

      case "whoami": {
        const where = {
          component: ctx.component.mode,
          bundle: ctx.component.bundle,
          hostname: ctx.component.hostname,
          greeting: (ctx.options.greeting as string) ?? "hello from strad",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(where, null, 2) }],
        };
      }

      default:
        throw new Error(`echo server has no tool "${name}"`);
    }
  },
};

export default mod;
