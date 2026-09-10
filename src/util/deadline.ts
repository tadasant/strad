import type { SelfClassifyingError } from "../telemetry/redact.ts";

/**
 * The two deadline helpers, and the one difference between them.
 *
 * `withDeadline` bounds how long a CALLER waits and abandons the work. Some work
 * cannot be cancelled — an MCP `listTools()` over a live transport, a store read
 * mid-decode — so abandoning it is the honest thing that helper can offer.
 *
 * `withRequestDeadline` bounds a `fetch`, which CAN be cancelled, so it does
 * both: the caller stops waiting and the request stops running. Node's `fetch`
 * has no overall timeout of its own, so an upstream that accepts the connection
 * and then stalls holds a request for undici's 300s header timeout and forever
 * if it trickles bytes — an unbounded outbound call is a socket and an Express
 * handler parked for five minutes, per attempt.
 *
 * Everything below the split is shared: both REJECT on expiry, both leave what a
 * failure means to the caller's own catch, and neither logs.
 *
 * There were four private `withDeadline`s once, and they split two-and-two on
 * every axis: two rejected on expiry and two resolved a sentinel; two took an
 * already-started promise and two took a thunk; the two that rejected unref'd
 * their timer and the two that swallowed held the event loop open.
 *
 * The split that matters is a fourth one, and it is on none of those axes. Two
 * of the four carried a SECURITY defence in their catch — `errorSummary(err)`,
 * because a store read that fails can embed a rendered secret in the thrown
 * message — and nothing in any of the four said which kind a reader was looking
 * at, so a fifth copy taken from the shortest would omit it silently.
 *
 * So both helpers here deliberately do the least: they bound the wait and
 * REJECT when the bound wins. What a failure means, what gets logged, and
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

/**
 * Run `work` against a fresh `AbortSignal.timeout(timeoutMs)`, and turn the
 * expiry THAT signal caused into the error the caller's own module already
 * throws.
 *
 * The signal is the point: a `fetch` handed one is cancelled when the deadline
 * fires, so nothing is left running behind the caller that stopped waiting.
 * `AbortSignal.timeout` is the shape the bounded call sites in this repo already
 * use (`src/secrets/parameters/gcp.ts`, `src/deploy/imageTag.ts`); what this adds
 * is the mapping, because a bare abort is a `DOMException` — not an `Error`
 * subclass any module can name — and a caller that lets one escape has a failure
 * its own handlers do not recognise.
 *
 * `onExpiry` builds that error. It is a thunk rather than a value so the message
 * costs nothing on the path that does not time out, and each site keeps its own
 * error type: `AuthError` for the console handshake, `ConnectorError` for the
 * consent exchange, and so on.
 *
 * Nothing is cleared when the work wins the race, and nothing needs to be: Node
 * does not let the timer behind an `AbortSignal.timeout` hold the event loop
 * open, so a deadline that outlives its request costs one pending timer and
 * never a process that refuses to exit.
 *
 * ONLY OUR OWN EXPIRY IS MAPPED. `fetch` rejects with the aborting signal's own
 * `reason` object, so identity — not the error's name — says whose deadline
 * fired. A caller that joined a signal of its own (`probeWithDeadline` in
 * `src/secrets/parameters/capabilities.ts` does, and `createGcpParameterStore`
 * replaces this one outright) still gets ITS abort back unchanged, rather than a
 * sentence naming a bound that was not the one enforced.
 */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  onExpiry: () => Error,
): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    return await work(deadline);
  } catch (err) {
    // `aborted` is checked first because `reason` is `undefined` until the
    // signal fires, and `undefined === undefined` would map a thrown
    // `undefined` into an expiry that never happened.
    if (deadline.aborted && err === deadline.reason) throw onExpiry();
    throw err;
  }
}
