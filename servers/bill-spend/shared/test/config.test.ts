import { describe, expect, it } from "vitest";

import {
  BASE_URLS,
  ConfigError,
  ENV,
  loadConfig,
  missingCredentials,
  readEnvironment,
} from "../src/config.js";
import { redact } from "../src/logging.js";
import { createMCPServer } from "../src/server.js";
import { parseToolGroups, toolNames } from "../src/tools.js";

describe("credentials", () => {
  it("names the one variable it needs, and only that one", () => {
    expect(missingCredentials({})).toEqual([ENV.apiToken]);
    // BILL_ENVIRONMENT has a default; a deployment that omits it is configured,
    // not degraded, and reporting it here would mark the mount degraded over a
    // variable nobody has to set.
    expect(missingCredentials({ [ENV.apiToken]: "t0ken" })).toEqual([]);
    expect(missingCredentials({ [ENV.apiToken]: "   " })).toEqual([
      ENV.apiToken,
    ]);
  });

  it("tells a human where to get the token, and that it is not an AP/AR key", () => {
    const error = (() => {
      try {
        loadConfig({});
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain(ENV.apiToken);
    expect(error.message).toContain("create-sandbox-company");
    // The single most expensive wrong turn available: building against BILL's
    // AP/AR API, which shares a hostname and nothing else.
    expect(error.message).toContain("sessionId");
    expect(error.message).toContain("devKey");
  });
});

describe("which BILL company this deployment talks to", () => {
  it("defaults to sandbox, never to production", () => {
    // The direction is the whole point. An unset variable costs a 401 on a
    // deployment meant to be production; the other default would point an
    // unattended agent at real financial records over a missing line of YAML.
    expect(readEnvironment({})).toBe("sandbox");
    expect(readEnvironment({ [ENV.environment]: "" })).toBe("sandbox");
    expect(loadConfig({ [ENV.apiToken]: "t0ken" }).baseUrl).toBe(
      BASE_URLS.sandbox,
    );
  });

  it("maps each environment to its own gateway host", () => {
    expect(BASE_URLS.sandbox).toBe("https://gateway.stage.bill.com/connect");
    expect(BASE_URLS.production).toBe("https://gateway.prod.bill.com/connect");
    expect(
      loadConfig({ [ENV.apiToken]: "t0ken", [ENV.environment]: "production" })
        .baseUrl,
    ).toBe(BASE_URLS.production);
  });

  it("accepts a pasted value with stray case or whitespace", () => {
    expect(readEnvironment({ [ENV.environment]: " Production " })).toBe(
      "production",
    );
  });

  it("refuses a name it does not recognise rather than falling back", () => {
    // Falling back would mean a typo'd `prod` silently talking to sandbox and a
    // human concluding the token is broken.
    const error = (() => {
      try {
        readEnvironment({ [ENV.environment]: "prod" });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('"prod"');
    expect(error.message).toContain("sandbox, production");
  });
});

describe("the tool surface", () => {
  it("is five tools, and the write one is the only one in readwrite", () => {
    expect(toolNames()).toEqual([
      "list_coding_fields",
      "list_coding_options",
      "list_transactions",
      "get_transaction_coding",
      "set_transaction_coding",
    ]);
    expect(toolNames(["readonly"])).toEqual([
      "list_coding_fields",
      "list_coding_options",
      "list_transactions",
      "get_transaction_coding",
    ]);
  });

  it("offers nothing that issues a card, moves a budget, or touches a user", () => {
    // The apiToken is unscoped ADMIN and BILL has no way to narrow it, so this
    // list IS the security boundary. A tool added here is a decision about that
    // boundary rather than a feature, and this is where that gets noticed.
    const names = toolNames().join(" ");
    for (const forbidden of [
      "card",
      "budget",
      "user",
      "reimburs",
      "bank",
      "fund",
    ]) {
      expect(names, `no tool may mention "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  it("fails closed on a tool-group value it does not recognise", () => {
    expect(parseToolGroups(undefined)).toEqual(["readonly", "readwrite"]);
    expect(parseToolGroups("readonly")).toEqual(["readonly"]);
    // Somebody TRIED to restrict this server and mistyped it. The write tool
    // here edits a financial record; falling back to everything would cost the
    // guarantee rather than a tool.
    expect(parseToolGroups("read-only")).toEqual(["readonly"]);
    expect(parseToolGroups("readonly,nonsense")).toEqual(["readonly"]);
  });
});

describe("the server with no credentials at all", () => {
  it("still lists its tools, so one missing token cannot cost the bundle its boot", async () => {
    const { server, registerHandlers } = createMCPServer({
      version: "test",
      env: {},
    });
    await registerHandlers(server);
    // Nothing above threw. The tools are registered against a factory that will
    // only try to read the environment when a tool is actually CALLED.
    expect(toolNames()).toHaveLength(5);
  });

  it("fails a CALL with an error naming the variable", async () => {
    const { server, registerHandlers } = createMCPServer({
      version: "test",
      env: {},
    });
    await registerHandlers(server);
    const { toolDefinitions } = await import("../src/tools.js");
    const tools = toolDefinitions(async () => {
      const { loadConfig: load } = await import("../src/config.js");
      load({});
      throw new Error("unreachable");
    });
    const result = await tools[0]!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(ENV.apiToken);
  });
});

describe("redaction", () => {
  it("hides a token-shaped run and leaves BILL's public identifiers alone", () => {
    const token = "a".repeat(64);
    expect(redact(`apiToken ${token} rejected`)).toBe(
      "apiToken [redacted] rejected",
    );
    // Every result this server returns is made of these. Redacting them would
    // make the server useless in the name of safety.
    expect(redact("tvl_0901")).toBe("tvl_0901");
    expect(redact("Y3VzdG9tZmllbGR2YWx1ZTo5MDE")).toBe(
      "Y3VzdG9tZmllbGR2YWx1ZTo5MDE",
    );
    expect(redact("6f1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9")).toBe(
      "6f1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    );
  });
});
