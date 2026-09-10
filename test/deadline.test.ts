import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeadlineError,
  withDeadline,
  withRequestDeadline,
} from "../src/util/deadline.ts";
import { errorKind } from "../src/telemetry/redact.ts";

describe("withDeadline", () => {
  // A spy that leaked out of a failing test would be asserted against by the
  // next one, which is the shape of a green suite that checked nothing.
  afterEach(() => vi.restoreAllMocks());

  it("resolves the work's value when it beats the clock", async () => {
    await expect(withDeadline(async () => 42, 1000, "the thing")).resolves.toBe(
      42,
    );
  });

  it("rejects with a DeadlineError naming the label and the bound", async () => {
    // A class rather than a message match, because reachability.ts acts on the
    // difference between "the deadline expired" and "the work failed" — it is
    // what makes a wedged local-tunnel `offline` rather than `unreachable`.
    const err = await withDeadline(
      () => new Promise<never>(() => {}),
      20,
      "tools/list",
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeadlineError);
    expect((err as Error).message).toBe(
      "tools/list did not answer within 20ms",
    );
    // Declared rather than pattern-matched: the message matches none of
    // errorKind's timeout patterns, so an expiry would export as `unknown`.
    expect(errorKind(err)).toBe("timeout");
  });

  it("lets the work's own failure through unchanged", async () => {
    // The whole contract: this wrapper decides nothing about what a failure
    // means. Each caller's catch does — including the two whose catch is a
    // secret-leak defence.
    const boom = new SyntaxError("Unexpected token @");
    await expect(
      withDeadline(() => Promise.reject(boom), 1000, "the store"),
    ).rejects.toBe(boom);
  });

  it("lets a SYNCHRONOUS throw from the thunk through, without leaking a timer", async () => {
    // reachability.ts depends on this: `ServerUnconfiguredError` is raised
    // inside the endpoint thunk before any transport work happens, and it has
    // to reach the caller's catch as itself.
    const boom = new Error("raised before any await");
    const { armed, cleared } = spyOnTimers();
    await expect(
      withDeadline(
        () => {
          throw boom;
        },
        1000,
        "the thing",
      ),
    ).rejects.toBe(boom);
    expect(armed).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(armed[0]);
  });

  it("takes a THUNK, so the deadline covers starting the work", async () => {
    // The one behaviour that is not obvious from the signature, and the reason
    // for it: a caller that hands over an already-running promise measures its
    // deadline from wherever it happened to be. Here the timer is armed before
    // `work()` is called, so work that blocks on its way to returning a promise
    // is inside the bound rather than outside it.
    const { armed } = spyOnTimers();
    let armedWhenWorkRan = false;
    await withDeadline(
      async () => {
        armedWhenWorkRan = armed.length === 1;
        return "ok";
      },
      1000,
      "the thing",
    );
    expect(armedWhenWorkRan).toBe(true);
  });

  it.each([
    ["the work resolves", () => Promise.resolve("ok"), 1000],
    ["the work rejects", () => Promise.reject(new Error("nope")), 1000],
    ["the deadline expires", () => new Promise<never>(() => {}), 10],
  ] as const)(
    "clears ITS OWN timer when %s",
    async (_case, work, timeoutMs) => {
      // All three exits, and by HANDLE rather than by call count: two clears on
      // one path and none on another would total the same, and an unrelated
      // clearTimeout in the same window would flake a count red. Without this a
      // resolved call leaves a pending timer per invocation, and `observe()` fans
      // one out per secret on every console render.
      const { armed, cleared } = spyOnTimers();
      await withDeadline(work, timeoutMs, "the thing").catch(() => {});
      expect(armed).toHaveLength(1);
      expect(cleared).toHaveBeenCalledWith(armed[0]);
    },
  );

  it("unrefs the timer, so a pending deadline never holds the process open", () => {
    const unref = vi.fn();
    vi.spyOn(global, "setTimeout").mockReturnValue({
      unref,
    } as unknown as NodeJS.Timeout);
    void withDeadline(() => new Promise<never>(() => {}), 1000, "the thing");
    expect(unref).toHaveBeenCalledOnce();
  });
});

/** Record the handles `withDeadline` arms, and watch what it clears. */
function spyOnTimers() {
  const real = global.setTimeout;
  const armed: NodeJS.Timeout[] = [];
  vi.spyOn(global, "setTimeout").mockImplementation(((
    fn: Parameters<typeof setTimeout>[0],
    ms?: number,
  ) => {
    const handle = real(fn, ms);
    armed.push(handle);
    return handle;
  }) as unknown as typeof setTimeout);
  return { armed, cleared: vi.spyOn(global, "clearTimeout") };
}

describe("withRequestDeadline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the work's value when it beats the clock", async () => {
    await expect(
      withRequestDeadline(
        1000,
        async () => "listed",
        () => new Error("unreachable"),
      ),
    ).resolves.toBe("listed");
  });

  it("hands the work a signal that is live, and aborts it at the deadline", async () => {
    // The signal is the difference between this helper and `withDeadline`: a
    // `fetch` handed one is CANCELLED at the bound, so nothing is left running
    // behind a caller that stopped waiting.
    let seen: AbortSignal | undefined;
    await withRequestDeadline(
      10,
      (signal) => {
        seen = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      },
      () => new Error("expired"),
    ).catch(() => {});
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
    // undici's own name for the reason an `AbortSignal.timeout` gives.
    expect((seen?.reason as Error).name).toBe("TimeoutError");
  });

  it("maps ITS OWN expiry onto the caller's error", async () => {
    // The reason the mapping is here at all: an abort is a `DOMException`, not
    // an `Error` subclass a module can name, so a caller that let one escape
    // would hand its own handlers a class they do not recognise.
    const mapped = new Error("google timed out");
    await expect(
      withRequestDeadline(
        10,
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
        () => mapped,
      ),
    ).rejects.toBe(mapped);
  });

  it("lets the work's own failure through unchanged", async () => {
    const boom = new SyntaxError("Unexpected token @");
    await expect(
      withRequestDeadline(
        1000,
        () => Promise.reject(boom),
        () => new Error("unreachable"),
      ),
    ).rejects.toBe(boom);
  });

  it("does NOT claim an abort that a different signal caused", async () => {
    // The guard that keeps a bound honest. `probeCapabilities` joins a signal
    // of its own and `createGcpParameterStore` replaces this one outright, so
    // an abort can arrive from a deadline that is not this one — and reporting
    // it as "timed out after 10000ms" would name a bound nobody enforced.
    const caller = new AbortController();
    const err = await withRequestDeadline(
      5,
      async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
        caller.abort(
          new DOMException("the caller stopped waiting", "AbortError"),
        );
        throw caller.signal.reason;
      },
      () => new Error("mapped, and wrongly so"),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(caller.signal.reason);
  });

  it("does not build the error on the path that does not expire", async () => {
    // `onExpiry` is a thunk so a message — several of which interpolate a
    // constant into a sentence — costs nothing on every successful call.
    const onExpiry = vi.fn(() => new Error("expired"));
    await withRequestDeadline(1000, async () => "ok", onExpiry);
    expect(onExpiry).not.toHaveBeenCalled();
  });
});
