import { describe, expect, it } from "vitest";

import { parseChord } from "../src/computer/keys.js";

describe("key chords", () => {
  it("parses modifiers and a key, in any spelling", () => {
    expect(parseChord("cmd+shift+4")).toEqual({
      ok: true,
      chord: { key: "4", modifiers: ["cmd", "shift"] },
    });
    expect(parseChord("Command+S")).toEqual({
      ok: true,
      chord: { key: "s", modifiers: ["command"] },
    });
    expect(parseChord("⌘+⌥+Esc")).toEqual({
      ok: true,
      chord: { key: "escape", modifiers: ["cmd", "alt"] },
    });
    expect(parseChord("Enter")).toEqual({
      ok: true,
      chord: { key: "return", modifiers: [] },
    });
    expect(parseChord("shift+=")).toEqual({
      ok: true,
      chord: { key: "=", modifiers: ["shift"] },
    });
    expect(parseChord("ctrl + c")).toEqual({
      ok: true,
      chord: { key: "c", modifiers: ["ctrl"] },
    });
  });

  it("refuses what it cannot post rather than guessing", () => {
    expect(parseChord("")).toMatchObject({ ok: false });
    expect(parseChord("cmd+")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ends in a modifier/),
    });
    expect(parseChord("s+cmd")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a modifier/),
    });
  });
});
