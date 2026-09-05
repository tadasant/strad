import type { SelfClassifyingError } from "../telemetry/redact.ts";

/**
 * The one deadline helper, with one contract.
 *
 * There were four, privately defined, and they split two-and-two on every axis:
 * two rejected on expiry and two resolved a sentinel; two took an
 * already-started promise and two took a thunk; the two that rejected unref'd
 * their timer and the two that swallowed held the event loop open.
 *
 * The split that matters is a fourth one, and it is on none of those axes. Two
 * of the four carried a SECURITY defence in their catch — `errorSummary(err)`,
 * because a store read that fails can embed a rendered secret in the thrown
 * message — and nothing in any of the four said which kind a reader was looking
 * at, so a fifth copy taken from the shortest would omit it silently.
 *
 * So this module deliberately does the least: it races the work against a timer
 * and REJECTS when the timer wins. What a failure means, what gets logged, and
 * what is safe to show a human all stay in the caller's own catch, where the
 * defence is visible at the site that needs it. See `src/ui/secret-status.ts`
 * and `src/secrets/store-diagnostics.ts` for the two catches that must
 * summarise by class rather than by message.
 */

/**
 * The deadline expired — as opposed to the work itself failing.
 *
 * A class rather than a message match because a caller acts on the difference:
 * `reachability.ts` calls a local-tunnel that accepted a connection and then
 * went quiet `offline` rather than `unreachable`, and a message it has to
 * parse would be a worse test than an `instanceof`.
 */
export class DeadlineError extends Error implements SelfClassifyingError {
  // An error strad CONSTRUCTS knows its own kind, and redact.ts says to declare
  // it rather than leave `errorKind()` matching on prose. The message here
  // matches none of its patterns, so without this an expiry would export as
  // `unknown` — which is where a fault nobody classified lands.
  readonly telemetryKind = "timeout";
}

/**
 * Run `work` under `timeoutMs`, rejecting with a `DeadlineError` if it expires.
 *
 * `work` is a THUNK, not a promise: the timer is armed before the work starts,
 * so a deadline covers building the request as well as waiting for the answer.
 * A caller that hands over an already-running promise measures from wherever it
 * happened to be, which is the kind of difference nobody writes down.
 *
 * `label` names the thing that did not answer, and is the whole of the message:
 * `${label} did not answer within ${timeoutMs}ms`. Keep it a noun phrase the
 * message reads with — "tools/list", "the machine".
 *
 * The timer is unref'd. A deadline still pending is a thing this process is
 * waiting on, never a reason for it to stay alive.
 *
 * The expiry ABANDONS the work rather than cancelling it: there is no
 * `AbortSignal` here, so a timed-out `listTools()` leaves a request in flight
 * and a timed-out store read still costs its connection. Every caller's bound
 * is about how long IT waits, not about what the upstream stops doing.
 */
export async function withDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // The rejector is FIRST in the array so its executor — which arms the timer
    // — runs before `work()` is called. That ordering is the thunk's whole
    // point; swapping these two lines would quietly start the clock late.
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DeadlineError(
                `${label} did not answer within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
      work(),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
