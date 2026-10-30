import { writeFileSync } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ENFORCE_EVERY_MS,
  startDaemon,
  type RunningDaemon,
} from "../src/daemon.js";
import { esc } from "../src/control/page.js";
import { ScriptedPrompter, testConfig, tmpState } from "./helpers.js";

let daemon: RunningDaemon;
beforeAll(async () => {
  daemon = await startDaemon(testConfig(), {
    stateDir: tmpState(),
    prompter: new ScriptedPrompter("allowed"),
    ephemeralPorts: true,
  });
});
afterAll(() => daemon.stop());

/** Raw http, because fetch will not let a test forge `Host`. */
function request(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: daemon.controlPort,
        method,
        path,
        headers: { host: `127.0.0.1:${daemon.controlPort}`, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const form = (fields: Record<string, string>) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

const grant = async (
  purpose: string,
  capability: "shell" | "browser" = "shell",
) => {
  const d = await daemon.core.deps.gate.request({
    capability,
    server: `${capability}-test-mbp`,
    purpose,
  });
  if (!d.ok) throw new Error(d.reason);
  return d.grant;
};

describe("the control page", () => {
  it("shows a live grant with its purpose and a kill button, escaped", async () => {
    const g = await grant(
      'Tidy <script>alert("x")</script> the downloads folder.',
    );
    const page = await request("GET", "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Remote control is ON");
    expect(page.body).toContain("shell-test-mbp");
    expect(page.body).toContain(esc(g.id));
    expect(page.body).toContain(
      "Kill ends the grant and refuses that server's requests, with no dialog, for 60 seconds",
    );
    expect(page.body).not.toContain("<script>");
    expect(page.body).toContain("&#60;script&#62;");
    expect(page.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    daemon.core.deps.gate.grants.end(g.id, "ended");
  });

  it("answers only to a loopback Host — a rebound DNS name is refused", async () => {
    expect(
      (await request("GET", "/", { headers: { host: "evil.example.com" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await request("GET", "/state.json", {
          headers: { host: "mbp.tadasant.com" },
        })
      ).status,
    ).toBe(403);
  });

  it("refuses anything that arrived through a proxy or a tunnel", async () => {
    for (const h of ["cf-connecting-ip", "cf-ray", "x-forwarded-for"]) {
      expect(
        (await request("GET", "/", { headers: { [h]: "1.2.3.4" } })).status,
      ).toBe(403);
    }
  });

  it("refuses a write without the per-boot token — a web page cannot post a kill, or an ENABLE", async () => {
    const g = await grant("Hold a grant for the token test.");
    expect((await request("POST", "/kill", form({ grant: g.id }))).status).toBe(
      403,
    );
    expect(
      (await request("POST", "/kill", form({ grant: g.id, token: "guess" })))
        .status,
    ).toBe(403);
    expect((await request("POST", "/enable", form({}))).status).toBe(403);
    expect(daemon.core.deps.gate.grants.active().map((x) => x.id)).toContain(
      g.id,
    );
    daemon.core.deps.gate.grants.end(g.id, "ended");
  });

  it("kills one grant, its signal aborts, and THAT server cools down", async () => {
    // The browser server, so the shell tests below still get their grants.
    const g = await grant("Hold a grant for the kill test.", "browser");
    const res = await request(
      "POST",
      "/kill",
      form({ grant: g.id, token: daemon.controlToken }),
    );
    expect(res.status).toBe(303);
    expect(g.signal.aborted).toBe(true);
    expect(daemon.core.deps.gate.grants.active()).toEqual([]);
    await expect(
      grant("Ask again straight after the kill.", "browser"),
    ).rejects.toThrow(/ended this server's control/);
    const other = await grant("Another server still asks.");
    daemon.core.deps.gate.grants.end(other.id, "ended");
  });

  it("a hand-touched DISABLED file stops a RUNNING command within the enforce interval", async () => {
    const g = await grant("Run something for the touch test.");
    const shell = daemon.core.capabilities.shell as unknown as {
      processes: {
        start: (
          g: unknown,
          c: string,
        ) => { status: string; done: Promise<void> };
      };
    };
    const cmd = shell.processes.start(g, "sleep 60");
    expect(cmd.status).toBe("running");

    writeFileSync(daemon.core.deps.killSwitch.path, "touched by hand\n");
    await Promise.race([
      cmd.done,
      new Promise((r) => setTimeout(r, ENFORCE_EVERY_MS + 3000)),
    ]);
    expect(cmd.status).toBe("killed");
    expect(g.signal.aborted).toBe(true);
    daemon.core.deps.killSwitch.enable();
  });

  it("disable ends every grant, refuses new ones, survives in a file, and enable undoes it", async () => {
    const g = await grant("Hold a grant for the disable test.");
    expect(
      (await request("POST", "/disable", form({ token: daemon.controlToken })))
        .status,
    ).toBe(303);
    expect(g.signal.aborted).toBe(true);
    expect(daemon.core.deps.killSwitch.isDisabled()).toBe(true);
    expect((await request("GET", "/")).body).toContain("Remote control is OFF");
    const denied = await daemon.core.deps.gate.request({
      capability: "shell",
      server: "s",
      purpose: "Try while it is off, please.",
    });
    expect(denied).toMatchObject({ ok: false, code: "disabled" });

    expect(
      (await request("POST", "/enable", form({ token: daemon.controlToken })))
        .status,
    ).toBe(303);
    expect(daemon.core.deps.killSwitch.isDisabled()).toBe(false);
  });
});
