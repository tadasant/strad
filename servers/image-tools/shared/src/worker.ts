/**
 * The worker entry `jobs.ts` spawns: one job in, one reply out, then exit.
 */
import { parentPort } from "node:worker_threads";

import { executeJob, type Job } from "./jobs.js";

if (!parentPort) throw new Error("worker.ts runs only as a worker thread");
const port = parentPort;

port.once("message", (job: Job) => {
  executeJob(job).then(
    (output) => port.postMessage({ ok: true, output }),
    (err: unknown) =>
      port.postMessage({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
  );
});
