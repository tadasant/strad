import { describe, expect, it, vi } from "vitest";
import { DeadlineError, withDeadline } from "../src/util/deadline.ts";

describe("withDeadline", () => {
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

  it("takes a THUNK, so the deadline covers starting the work", async () => {
    // The one behaviour that is not obvious from the signature, and the reason
    // for it: a caller that hands over an already-running promise measures its
    // deadline from wherever it happened to be. Here the timer is armed before
    // `work()` is called, so work that blocks on its way to returning a promise
    // is inside the bound rather than outside it.
    let armed = false;
    const spy = vi.spyOn(global, "setTimeout");
    await withDeadline(
      async () => {
        armed = spy.mock.calls.length > 0;
        return "ok";
      },
      1000,
      "the thing",
    );
    spy.mockRestore();
    expect(armed).toBe(true);
  });

  it("clears its timer on the way out, either way", async () => {
    // Without this a resolved call leaves a pending timer per invocation, and
    // `observe()` fans out one per secret on every console render.
    const cleared = vi.spyOn(global, "clearTimeout");
    const before = cleared.mock.calls.length;
    await withDeadline(async () => "ok", 1000, "the thing");
    await withDeadline(
      () => new Promise<never>(() => {}),
      10,
      "the thing",
    ).catch(() => {});
    expect(cleared.mock.calls.length).toBe(before + 2);
    cleared.mockRestore();
  });

  it("unrefs the timer, so a pending deadline never holds the process open", () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(global, "setTimeout")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    void withDeadline(() => new Promise<never>(() => {}), 1000, "the thing");
    spy.mockRestore();
    expect(unref).toHaveBeenCalledOnce();
  });
});
