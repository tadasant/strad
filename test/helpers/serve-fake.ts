import type { Server } from "node:http";
import express from "express";
import type { createFakeGcp } from "../../src/secrets/parameters/fake.ts";

/**
 * Put the in-memory GCP fake behind an HTTP server so a SUBPROCESS can reach it.
 *
 * The fake is a `fetch` stub keyed on its own base URLs; this rewrites an
 * incoming request back onto those bases and hands it to the stub. That keeps one
 * implementation of the store's behaviour instead of two that drift — which
 * matters because two scripts now talk to a store (`render-spec` and
 * `check-store`), and both are exercised as real subprocesses.
 */
export interface ServedFake {
  base: string;
  close: () => Promise<void>;
}

export function serveFake(
  fake: ReturnType<typeof createFakeGcp>,
): Promise<ServedFake> {
  const app = express();
  app.use(express.raw({ type: () => true }));

  app.all(/.*/, (req, res) => {
    void (async () => {
      // /pm/... -> the fake's PM base, /sm/... -> its SM base, /token -> its token URL.
      const path = req.originalUrl;
      let target: string;
      if (path.startsWith("/token")) target = fake.endpoints.tokenUrl;
      else if (path.startsWith("/pm/"))
        target = `${fake.endpoints.pmApiBase}${path.slice("/pm".length)}`;
      else if (path.startsWith("/sm/"))
        target = `${fake.endpoints.smApiBase}${path.slice("/sm".length)}`;
      else {
        res.status(404).end();
        return;
      }

      const body =
        Buffer.isBuffer(req.body) && req.body.length > 0
          ? req.body.toString("utf8")
          : undefined;
      const upstream = await fake.fetchImpl(target, {
        method: req.method,
        body,
      });
      res
        .status(upstream.status)
        .type("application/json")
        .send(
          // The fake's Response is a duck type; text() is the honest accessor.
          await upstream.text(),
        );
    })();
  });

  return new Promise((resolve) => {
    const s: Server = app.listen(0, () => {
      const addr = s.address();
      if (typeof addr === "string" || !addr) throw new Error("no port");
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            s.closeAllConnections();
            s.close(() => r());
          }),
      });
    });
  });
}
