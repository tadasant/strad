/**
 * A REAL Postgres, with TLS on, for the suite.
 *
 * The repository has no Postgres service in CI, so the suite starts its own:
 * the official `postgres` image, with `ssl=on` and the self-signed certificate
 * the Debian image already carries. Every hosted Ubuntu runner has Docker, and
 * so does a developer machine; nothing else is needed.
 *
 * `POSTGRES_TEST_ADMIN_URL` skips the container and uses a server you started
 * yourself — a superuser URI, without sslmode, on a server with TLS on. The
 * suite creates its own role, schema and tables in it.
 *
 * There is no "skip if Docker is missing". A security suite that passes because
 * it never ran is the failure it exists to prevent.
 */
import { execFileSync } from "node:child_process";

import pg from "pg";
import type { TestProject } from "vitest/node";

const IMAGE = "postgres:17";
const ADMIN_PASSWORD = "admin-pw-7c1f0e";

declare module "vitest" {
  export interface ProvidedContext {
    pg: { adminUrl: string; host: string; port: number; ca: string };
  }
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitFor(url: string, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  let last: unknown;
  while (Date.now() < until) {
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      last = error;
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres never became ready: ${String(last)}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const given = process.env.POSTGRES_TEST_ADMIN_URL;
  if (given) {
    const u = new URL(given);
    await waitFor(given, 10_000);
    project.provide("pg", {
      adminUrl: given,
      host: u.hostname,
      port: Number(u.port || 5432),
      ca: process.env.POSTGRES_TEST_CA ?? "",
    });
    return async () => {};
  }

  const id = docker(
    "run", "-d", "--rm",
    "-e", `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    "-p", "127.0.0.1::5432",
    IMAGE,
    "-c", "ssl=on",
    "-c", "ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem",
    "-c", "ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key",
  );
  try {
    const mapped = docker("port", id, "5432/tcp").split("\n")[0]!;
    const port = Number(mapped.slice(mapped.lastIndexOf(":") + 1));
    const adminUrl = `postgres://postgres:${ADMIN_PASSWORD}@127.0.0.1:${port}/postgres`;
    await waitFor(adminUrl, 60_000);
    const ca = docker("exec", id, "cat", "/etc/ssl/certs/ssl-cert-snakeoil.pem");
    project.provide("pg", { adminUrl, host: "127.0.0.1", port, ca });
  } catch (error) {
    docker("rm", "-f", id);
    throw error;
  }
  return async () => {
    try {
      docker("rm", "-f", id);
    } catch {
      // Already gone.
    }
  };
}
