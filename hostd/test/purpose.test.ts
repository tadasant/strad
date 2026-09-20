import { describe, expect, it } from "vitest";

import { dialogText } from "../src/consent/prompter.js";
import { countSentences, normalizePurpose } from "../src/consent/purpose.js";

describe("the purpose a dialog will show", () => {
  it("accepts one or two sentences", () => {
    expect(normalizePurpose("Find the Q3 invoices in ~/Documents.")).toEqual({
      ok: true,
      purpose: "Find the Q3 invoices in ~/Documents.",
    });
    expect(
      normalizePurpose(
        "List the repos in ~/code. Report which have uncommitted changes.",
      ).ok,
    ).toBe(true);
  });

  it("refuses a third sentence rather than trimming it off", () => {
    const r = normalizePurpose(
      "Read a file. Then another one. Then delete everything.",
    );
    expect(r).toEqual({
      ok: false,
      reason: "purpose is 3 sentences; the limit is 2",
    });
  });

  it("does not count a dot inside a token as a sentence", () => {
    expect(
      countSentences("Check node v22.4.1 is installed at ~/.nvm/versions."),
    ).toBe(1);
  });

  it("refuses a missing, empty, or non-string purpose", () => {
    for (const bad of [undefined, null, 7, "", "   ", "ok"])
      expect(normalizePurpose(bad).ok).toBe(false);
  });

  it("refuses more than 280 characters", () => {
    expect(normalizePurpose("a".repeat(281)).ok).toBe(false);
  });

  it("strips newlines, control characters and bidi overrides before display", () => {
    const r = normalizePurpose(
      "Harmless\n\n\n\nlooking\u202e text\u0007 here ok",
    );
    expect(r).toEqual({ ok: true, purpose: "Harmless looking text here ok" });
  });

  it("words the dialog the way its owner asked for it, and says what silence means", () => {
    const base = {
      server: "shell-tadas-mbp",
      purpose: "Find a file.",
      seconds: 5,
    };
    expect(dialogText({ ...base, onTimeout: "deny" })).toBe(
      "Remote control requested by shell-tadas-mbp MCP server for purpose: Find a file.\n\nDenied automatically in 5 seconds unless you allow it.",
    );
    expect(dialogText({ ...base, onTimeout: "allow" })).toContain(
      "Allowed automatically in 5 seconds unless you reject it.",
    );
  });
});
