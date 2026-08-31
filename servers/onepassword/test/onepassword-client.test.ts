/**
 * The 1Password client's request-building and response-shaping.
 *
 * The client talks to 1Password by shelling out to the `op` CLI, so "building a
 * request" here means building an argv, and "shaping a response" means what the
 * client makes of the CLI's stdout, stderr and exit code. `child_process.spawn`
 * is faked: nothing in this file starts a process, reaches the network, or reads
 * a credential. The token below is a placeholder and is not a 1Password token.
 *
 * Tests live at the TREE root rather than in `shared/`, which is a verbatim
 * vendor copy of pulsemcp/mcp-servers (HACKS.md #15) — a test file added there
 * would be a merge conflict on every re-vendor. They import the vendored
 * TypeScript sources directly.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

type OpRun =
  | { stdout?: string; stderr?: string; code: number | null }
  | { spawnError: Error & { code?: string } };

type SpawnCall = {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
};

const op = vi.hoisted(() => ({
  calls: [] as {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  }[],
  runs: [] as (
    | { stdout?: string; stderr?: string; code: number | null }
    | { spawnError: Error & { code?: string } }
  )[],
}));

vi.mock("child_process", () => ({
  spawn: (
    command: string,
    args: string[],
    options: { env: Record<string, string | undefined> },
  ) => {
    op.calls.push({ command, args: [...args], env: options.env });
    const run = op.runs.shift() ?? { stdout: "{}", code: 0 };

    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end: () => void };
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: () => {} };
    proc.kill = () => {};

    setImmediate(() => {
      if ("spawnError" in run) {
        proc.emit("error", run.spawnError);
        return;
      }
      if (run.stdout !== undefined) proc.stdout.emit("data", run.stdout);
      if (run.stderr !== undefined) proc.stderr.emit("data", run.stderr);
      proc.emit("close", run.code);
    });

    return proc;
  },
}));

import {
  OnePasswordAuthenticationError,
  OnePasswordCommandError,
  OnePasswordNotFoundError,
} from "../shared/src/types.js";
import { getVaults } from "../shared/src/onepassword-client/lib/get-vaults.js";
import { getItem } from "../shared/src/onepassword-client/lib/get-item.js";
import { listItems } from "../shared/src/onepassword-client/lib/list-items.js";
import { listItemsByTag } from "../shared/src/onepassword-client/lib/list-items-by-tag.js";
import { createLogin } from "../shared/src/onepassword-client/lib/create-login.js";
import { createSecureNote } from "../shared/src/onepassword-client/lib/create-secure-note.js";
import { createApiCredential } from "../shared/src/onepassword-client/lib/create-api-credential.js";
import { shareItem } from "../shared/src/onepassword-client/lib/share-item.js";
import { executeCommand } from "../shared/src/onepassword-client/lib/execute-command.js";

/** Obviously fake. `op` is never spawned, so nothing authenticates with it. */
const TOKEN = "ops_not-a-real-token_placeholder";

/** Queue the CLI's answer to the next spawn. */
function nextRun(run: OpRun): void {
  op.runs.push(run);
}

/** Queue a successful CLI run whose stdout is `value` as JSON. */
function nextJson(value: unknown): void {
  nextRun({ stdout: JSON.stringify(value), code: 0 });
}

/** The single spawn the test under it provoked. */
function onlyCall(): SpawnCall {
  expect(op.calls).toHaveLength(1);
  return op.calls[0];
}

beforeEach(() => {
  op.calls.length = 0;
  op.runs.length = 0;
});

describe("the op invocation", () => {
  it("runs `op vault list` and asks for JSON", async () => {
    nextJson([]);
    await getVaults(TOKEN);

    const call = onlyCall();
    expect(call.command).toBe("op");
    expect(call.args).toEqual(["vault", "list", "--format", "json"]);
  });

  it("carries the service-account token in the environment, never in argv", async () => {
    nextJson([]);
    await getVaults(TOKEN);

    const call = onlyCall();
    expect(call.env.OP_SERVICE_ACCOUNT_TOKEN).toBe(TOKEN);
    expect(call.args).not.toContain(TOKEN);
    expect(call.args.join(" ")).not.toContain(TOKEN);
  });

  it("leaves a caller-chosen format alone rather than appending a second one", async () => {
    nextRun({ stdout: '{"ok":true}', code: 0 });
    await executeCommand(TOKEN, ["item", "get", "x", "--format", "csv"]);

    expect(onlyCall().args).toEqual([
      "item",
      "get",
      "x",
      "--format",
      "csv",
    ]);
  });
});

describe("listing items", () => {
  it("scopes `item list` to the vault it was given", async () => {
    nextJson([]);
    await listItems(TOKEN, "vault-abc");

    expect(onlyCall().args).toEqual([
      "item",
      "list",
      "--vault",
      "vault-abc",
      "--format",
      "json",
    ]);
  });

  it("filters by tag without a vault when none is given", async () => {
    nextJson([]);
    await listItemsByTag(TOKEN, "ops");

    expect(onlyCall().args).toEqual([
      "item",
      "list",
      "--tags",
      "ops",
      "--format",
      "json",
    ]);
  });

  it("narrows a tag filter to a vault when one is given", async () => {
    nextJson([]);
    await listItemsByTag(TOKEN, "ops", "vault-abc");

    expect(onlyCall().args).toEqual([
      "item",
      "list",
      "--tags",
      "ops",
      "--vault",
      "vault-abc",
      "--format",
      "json",
    ]);
  });

  it("drops the item id, the vault id and additional_information from every row", async () => {
    nextJson([
      {
        id: "item-1",
        title: "Deploy key",
        category: "LOGIN",
        vault: { id: "vault-abc", name: "Infra" },
        tags: ["ops"],
        additional_information: "deploy@example.com",
      },
    ]);

    const items = await listItems(TOKEN, "vault-abc");

    expect(items).toEqual([
      {
        title: "Deploy key",
        category: "LOGIN",
        vault: { name: "Infra" },
        tags: ["ops"],
      },
    ]);
  });

  it("leaves the vault undefined when the CLI reports an item without one", async () => {
    nextJson([{ id: "item-1", title: "Orphan", category: "LOGIN" }]);

    const [item] = await listItemsByTag(TOKEN, "ops");

    expect(item).toEqual({
      title: "Orphan",
      category: "LOGIN",
      vault: undefined,
      tags: undefined,
    });
  });

  it("sanitizes tag-filtered rows the same way", async () => {
    nextJson([
      {
        id: "item-2",
        title: "API key",
        category: "API_CREDENTIAL",
        vault: { id: "vault-abc", name: "Infra" },
        additional_information: "leaks a hostname",
      },
    ]);

    const items = await listItemsByTag(TOKEN, "ops", "vault-abc");

    expect(items[0]).not.toHaveProperty("id");
    expect(items[0]).not.toHaveProperty("additional_information");
    expect(items[0].vault).toEqual({ name: "Infra" });
  });
});

describe("getting one item", () => {
  it("asks for the item by id or title", async () => {
    nextJson({ id: "item-1" });
    await getItem(TOKEN, "Deploy key");

    expect(onlyCall().args).toEqual([
      "item",
      "get",
      "Deploy key",
      "--format",
      "json",
    ]);
  });

  it("narrows the lookup to a vault when one is given", async () => {
    nextJson({ id: "item-1" });
    await getItem(TOKEN, "Deploy key", "Infra");

    expect(onlyCall().args).toEqual([
      "item",
      "get",
      "Deploy key",
      "--vault",
      "Infra",
      "--format",
      "json",
    ]);
  });

  it("returns the CLI's item verbatim — details are not sanitized here", async () => {
    const details = {
      id: "item-1",
      title: "Deploy key",
      category: "LOGIN",
      vault: { id: "vault-abc", name: "Infra" },
      fields: [{ id: "password", type: "CONCEALED", label: "password" }],
    };
    nextJson(details);

    await expect(getItem(TOKEN, "Deploy key")).resolves.toEqual(details);
  });
});

describe("creating items", () => {
  it("builds a login out of field assignments", async () => {
    nextJson({ id: "item-1" });
    await createLogin(TOKEN, "vault-abc", "Example", "alice", "hunter2");

    expect(onlyCall().args).toEqual([
      "item",
      "create",
      "--category",
      "login",
      "--vault",
      "vault-abc",
      "--title",
      "Example",
      "username=alice",
      "password=hunter2",
      "--format",
      "json",
    ]);
  });

  it("appends the url and joins tags with commas", async () => {
    nextJson({ id: "item-1" });
    await createLogin(
      TOKEN,
      "vault-abc",
      "Example",
      "alice",
      "hunter2",
      "https://example.com",
      ["ops", "prod"],
    );

    const args = onlyCall().args;
    expect(args).toContain("url=https://example.com");
    expect(args.slice(-4)).toEqual(["--tags", "ops,prod", "--format", "json"]);
  });

  it("omits --tags entirely for an empty tag list", async () => {
    nextJson({ id: "item-1" });
    await createLogin(
      TOKEN,
      "vault-abc",
      "Example",
      "alice",
      "hunter2",
      undefined,
      [],
    );

    expect(onlyCall().args).not.toContain("--tags");
  });

  it("creates a secure note under the Secure Note category", async () => {
    nextJson({ id: "item-1" });
    await createSecureNote(TOKEN, "vault-abc", "Runbook", "step one", ["ops"]);

    expect(onlyCall().args).toEqual([
      "item",
      "create",
      "--category",
      "Secure Note",
      "--vault",
      "vault-abc",
      "--title",
      "Runbook",
      "notesPlain=step one",
      "--tags",
      "ops",
      "--format",
      "json",
    ]);
  });

  it("sends only the API-credential options it was given", async () => {
    nextJson({ id: "item-1" });
    await createApiCredential(TOKEN, "vault-abc", "Grafana", "abc123");

    expect(onlyCall().args).toEqual([
      "item",
      "create",
      "--category",
      "API Credential",
      "--vault",
      "vault-abc",
      "--title",
      "Grafana",
      "credential=abc123",
      "--format",
      "json",
    ]);
  });

  it("labels the API-credential validity field `valid from`, with the space", async () => {
    nextJson({ id: "item-1" });
    await createApiCredential(TOKEN, "vault-abc", "Grafana", "abc123", {
      username: "svc",
      hostname: "grafana.example.com",
      validFrom: "2026-01-01",
      expires: "2027-01-01",
      notes: "rotated quarterly",
      tags: ["ops", "prod"],
    });

    expect(onlyCall().args).toEqual([
      "item",
      "create",
      "--category",
      "API Credential",
      "--vault",
      "vault-abc",
      "--title",
      "Grafana",
      "credential=abc123",
      "username=svc",
      "hostname=grafana.example.com",
      "valid from=2026-01-01",
      "expires=2027-01-01",
      "notesPlain=rotated quarterly",
      "--tags",
      "ops,prod",
      "--format",
      "json",
    ]);
  });
});

describe("sharing an item", () => {
  it("builds the share flags and asks for JSON exactly once", async () => {
    nextRun({ stdout: '{"share_url":"https://share.1password.com/s/a"}', code: 0 });
    await shareItem(TOKEN, "Deploy key", "Infra", {
      expiresIn: "7d",
      emails: ["a@example.com", "b@example.com"],
      viewOnce: true,
    });

    expect(onlyCall().args).toEqual([
      "item",
      "share",
      "Deploy key",
      "--vault",
      "Infra",
      "--expires-in",
      "7d",
      "--emails",
      "a@example.com,b@example.com",
      "--view-once",
      "--format",
      "json",
    ]);
  });

  it("omits every optional flag when no options are given", async () => {
    nextRun({ stdout: '{"share_url":"https://share.1password.com/s/a"}', code: 0 });
    await shareItem(TOKEN, "Deploy key");

    expect(onlyCall().args).toEqual([
      "item",
      "share",
      "Deploy key",
      "--format",
      "json",
    ]);
  });

  it("reads share_url and the timestamps out of a JSON payload", async () => {
    nextJson({
      share_url: "https://share.1password.com/s/abc",
      expires_at: "2026-09-07T00:00:00Z",
      created_at: "2026-08-31T00:00:00Z",
    });

    await expect(shareItem(TOKEN, "Deploy key")).resolves.toEqual({
      share_url: "https://share.1password.com/s/abc",
      expires_at: "2026-09-07T00:00:00Z",
      created_at: "2026-08-31T00:00:00Z",
    });
  });

  it("leaves the timestamps undefined when the payload omits them", async () => {
    nextJson({ share_url: "https://share.1password.com/s/abc" });

    await expect(shareItem(TOKEN, "Deploy key")).resolves.toEqual({
      share_url: "https://share.1password.com/s/abc",
      expires_at: undefined,
      created_at: undefined,
    });
  });

  it("falls back to the url key when share_url is absent", async () => {
    nextJson({ url: "https://share.1password.com/s/from-url" });

    const result = await shareItem(TOKEN, "Deploy key");

    expect(result.share_url).toBe("https://share.1password.com/s/from-url");
  });

  it("falls back to the href key when share_url and url are both absent", async () => {
    nextJson({ href: "https://share.1password.com/s/from-href" });

    const result = await shareItem(TOKEN, "Deploy key");

    expect(result.share_url).toBe("https://share.1password.com/s/from-href");
  });

  it("prefers a share.1password.com URL in plain-text output", async () => {
    nextRun({
      stdout:
        "opening https://my.1password.com/home\nhttps://share.1password.com/s/plain\n",
      code: 0,
    });

    await expect(shareItem(TOKEN, "Deploy key")).resolves.toEqual({
      share_url: "https://share.1password.com/s/plain",
    });
  });

  it("takes the last URL when none of them is a share link", async () => {
    nextRun({ stdout: "https://example.com/a\nhttps://example.com/b\n", code: 0 });

    await expect(shareItem(TOKEN, "Deploy key")).resolves.toEqual({
      share_url: "https://example.com/b",
    });
  });

  it("ignores a non-string share_url and falls through to the text scan", async () => {
    nextRun({
      stdout:
        '{"share_url":42,"detail":"link https://share.1password.com/s/nested here"}',
      code: 0,
    });

    await expect(shareItem(TOKEN, "Deploy key")).resolves.toEqual({
      share_url: "https://share.1password.com/s/nested",
    });
  });

  it("throws when the output holds no URL at all", async () => {
    nextRun({ stdout: '{"ok":true}', code: 0 });

    await expect(shareItem(TOKEN, "Deploy key")).rejects.toThrow(
      OnePasswordCommandError,
    );
  });
});

describe("shaping a failure", () => {
  it.each([
    "no item found",
    '"Deploy key" isn\'t an item in the "Infra" vault',
    "vault not found",
  ])("reports %j as a not-found error", async (stderr) => {
    nextRun({ stderr, code: 1 });

    await expect(getItem(TOKEN, "Deploy key")).rejects.toBeInstanceOf(
      OnePasswordNotFoundError,
    );
  });

  it.each([
    "authentication required",
    "unauthorized",
    "invalid session token",
    "invalid token",
    "you are not signed in",
  ])("reports %j as an authentication error", async (stderr) => {
    nextRun({ stderr, code: 1 });

    await expect(getVaults(TOKEN)).rejects.toBeInstanceOf(
      OnePasswordAuthenticationError,
    );
  });

  it("reports anything else as a command error carrying the exit code", async () => {
    nextRun({ stderr: "connection reset by peer", code: 7 });

    const error = await getVaults(TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OnePasswordCommandError);
    expect((error as OnePasswordCommandError).message).toBe(
      "1Password CLI error (exit 7): connection reset by peer",
    );
    expect((error as OnePasswordCommandError).exitCode).toBe(7);
  });

  it("substitutes exit 1 when the CLI dies without an exit code", async () => {
    nextRun({ stderr: "boom", code: null });

    const error = await getVaults(TOKEN).catch((e: unknown) => e);

    expect((error as OnePasswordCommandError).exitCode).toBe(1);
  });

  it("reports stdout that is not JSON as a command error", async () => {
    nextRun({ stdout: "not json at all", code: 0 });

    const error = await getVaults(TOKEN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OnePasswordCommandError);
    expect((error as OnePasswordCommandError).message).toMatch(
      /^Failed to parse 1Password response:/,
    );
  });

  it("names the missing binary when `op` is not on PATH", async () => {
    const enoent = Object.assign(new Error("spawn op ENOENT"), {
      code: "ENOENT",
    });
    nextRun({ spawnError: enoent });

    await expect(getVaults(TOKEN)).rejects.toThrow(
      /1Password CLI \(op\) not found/,
    );
  });

  it("reports any other spawn failure as a command error", async () => {
    nextRun({ spawnError: Object.assign(new Error("EACCES"), { code: "EACCES" }) });

    await expect(getVaults(TOKEN)).rejects.toThrow(
      "Failed to execute command: EACCES",
    );
  });
});
