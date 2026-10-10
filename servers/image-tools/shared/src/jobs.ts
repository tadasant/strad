/**
 * The CPU work, off the event loop.
 *
 * A pixel diff, a connected-component pass, a template search and potrace are
 * all plain JavaScript loops, seconds long on a large image. In the bundle,
 * this process is also every other mount's server, and the health check App
 * Platform polls — so the work runs in a WORKER THREAD, one per job. That buys
 * the one thing a timer around an `await` cannot: a job past its deadline is
 * TERMINATED, not merely abandoned while it keeps the CPU.
 *
 * Jobs are also admitted one at a time per process (`maxConcurrentJobs`),
 * across both servers, because a diff at the pixel limit holds a few hundred
 * MB and the container is shared with a Chromium.
 */
import { Worker } from "node:worker_threads";

import {
  diffImages,
  type ImageDiffOptions,
  type ImageDiffResult,
} from "./diff/index.js";
import type { Limits } from "./limits.js";
import {
  traceToSvg,
  type TraceOptions,
  type TraceResult,
} from "./trace/index.js";

export type Job =
  | {
      kind: "diff";
      source: Uint8Array;
      target: Uint8Array;
      options: ImageDiffOptions;
    }
  | { kind: "trace"; input: Uint8Array; options: TraceOptions };

export type JobOutput =
  | { kind: "diff"; result: ImageDiffResult; pngs: Uint8Array[] }
  | { kind: "trace"; result: TraceResult };

/** Thrown when a job cannot start or finish in time. The message is for the caller. */
export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

/** The job itself. Runs inside the worker; exported so tests can run it inline. */
export async function executeJob(job: Job): Promise<JobOutput> {
  if (job.kind === "diff") {
    const { result, pngs } = await diffImages(
      job.source,
      job.target,
      job.options,
    );
    return { kind: "diff", result, pngs };
  }
  return { kind: "trace", result: await traceToSvg(job.input, job.options) };
}

/** Run one job. `signal` is the caller's cancellation: it leaves the queue or stops the worker. */
export type RunJob = (job: Job, signal?: AbortSignal) => Promise<JobOutput>;

/**
 * A counting semaphore with a BOUNDED queue. A caller queues holding its
 * already-fetched image bytes, so an unbounded queue is N callers × 50MB in
 * this process — the very peak the gate exists to prevent. Past `maxQueued`
 * the caller is refused at once; in the queue, it gives up after `timeoutMs`
 * or when its own call is cancelled.
 */
class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly size: number,
    private readonly maxQueued: number,
  ) {}

  async acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new JobError("The call was cancelled.");
    if (this.active < this.size) {
      this.active++;
      return this.releaser();
    }
    if (this.waiting.length >= this.maxQueued) {
      throw new JobError(
        `Busy: an image job is running and ${this.waiting.length} more are waiting. Retry shortly.`,
      );
    }
    return new Promise((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
      };
      const grant = () => {
        leave();
        this.active++;
        resolve(this.releaser());
      };
      const onAbort = () => {
        leave();
        reject(new JobError("The call was cancelled."));
      };
      const timer = setTimeout(() => {
        leave();
        reject(
          new JobError(
            `Busy: another image job has held the worker for ${Math.round(timeoutMs / 1000)}s. Retry shortly.`,
          ),
        );
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting[0]?.();
    };
  }
}

export interface WorkerRunnerOptions {
  limits: Pick<
    Limits,
    "jobTimeoutMs" | "queueTimeoutMs" | "maxConcurrentJobs" | "maxQueuedJobs"
  >;
  /** The built worker entry. Defaults to `worker.js` beside this module. */
  workerUrl?: URL;
}

/**
 * Run each job in a fresh worker. ONE runner per process is the point — it is
 * the gate — so both servers' factories share the default one.
 */
export function createWorkerRunner(options: WorkerRunnerOptions): RunJob {
  const { limits } = options;
  const workerUrl =
    options.workerUrl ?? new URL("./worker.js", import.meta.url);
  const gate = new Gate(limits.maxConcurrentJobs, limits.maxQueuedJobs);

  return async (job, signal) => {
    const release = await gate.acquire(limits.queueTimeoutMs, signal);
    try {
      return await runInWorker(workerUrl, job, limits.jobTimeoutMs, signal);
    } finally {
      release();
    }
  };
}

type WorkerReply =
  { ok: true; output: JobOutput } | { ok: false; message: string };

/**
 * Settles only once the worker has EXITED, so the gate is released after the
 * worker's memory is gone rather than while a terminated one is still tearing
 * down beside the next job.
 */
function runInWorker(
  workerUrl: URL,
  job: Job,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JobOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      // The JS heap only: pixel buffers are off-heap and bounded by maxPixels.
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().finally(fn);
    };
    const onAbort = () =>
      finish(() => reject(new JobError("The call was cancelled.")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new JobError(
              `The image job took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. ` +
                "Try a smaller or cropped image.",
            ),
          ),
        ),
      timeoutMs,
    );
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (reply: WorkerReply) =>
      finish(() =>
        reply.ok ? resolve(reply.output) : reject(new JobError(reply.message)),
      ),
    );
    worker.once("error", (err) =>
      finish(() =>
        reject(new JobError(`The image job failed: ${err.message}`)),
      ),
    );
    worker.once("exit", (code) =>
      finish(() =>
        reject(
          new JobError(
            `The image job's worker exited (code ${code}) without an answer.`,
          ),
        ),
      ),
    );
    // COPIED, not transferred. A small Buffer is a view on Node's shared pool,
    // and transferring its ArrayBuffer would detach every other view on it.
    worker.postMessage(job);
  });
}
