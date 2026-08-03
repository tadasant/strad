import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the TS program.
import { drifted, SOURCE, TARGETS } from "../scripts/sync-parameter-wire.mjs";

/**
 * Vendored copies rot. This is the thing that notices.
 *
 * `servers/secrets` is its own npm project with its own lockfile and its own
 * compiler settings, so it cannot import `src/secrets/parameters/wire.ts`. The id
 * fold, the value encoding and the two pointer predicates have to exist in both
 * trees, and the only thing standing between that and two slowly-diverging
 * encodings is this test.
 *
 * The failure it prevents is the one this subsystem otherwise does not have.
 * Everything else here fails loudly; a drift on this seam does not. Both halves
 * address the SAME GCP parameter, so an id fold that folds one character
 * differently addresses a resource the other half cannot see, and a reader that
 * does not know the `encoding` field exists hands a child process base64url TEXT
 * as its credential and reports success. See `HACKS.md` #33.
 *
 * If it fails: edit `src/secrets/parameters/wire.ts` (never the copy), run
 * `npm run wire:sync`, and commit both.
 */
describe("the vendored parameter wire encoding", () => {
  it("is byte-identical in every tree that writes to the store", () => {
    expect(drifted()).toEqual([]);
  });

  it("covers every tree that addresses a strad parameter", () => {
    // Naming it here means a fourth tree that reaches the store is a deliberate
    // act, not something that silently ships with its own copy of the fold.
    expect(TARGETS).toEqual(["servers/secrets/shared/src/parameter-wire.ts"]);
  });
});

/**
 * A byte comparison fails OPEN. A vendored copy nothing imports is in sync with
 * its source forever, and the tree can quietly keep a second implementation
 * beside it — which is exactly the state this change replaced. So the copy being
 * identical is only half the check: the tree also has to be USING it.
 */
describe("the secrets tree has no second implementation", () => {
  const dir = "servers/secrets/shared/src";
  const vendored = "parameter-wire.ts";

  /**
   * Every hand-written source file in the tree — the vendored copy excluded.
   *
   * Recursive, though the tree is flat today: a scan that only reads the top
   * level would pass over a second implementation parked one directory down,
   * which is the same fail-open this whole describe exists to close.
   */
  const sources = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts") && name !== vendored)
    .map((name) => [name, readFileSync(join(dir, name), "utf8")] as const);

  /**
   * The same file with every `… from "…"` statement stripped out.
   *
   * The strip is what makes the declaration scan mean something. A re-export list
   * spells a type as `type ParameterEnvelope,` and an import block spells it the
   * same way, so a scan over the raw text would call every CONSUMER of the wire a
   * second implementation of it. `[^;]*` cannot run past the end of a statement,
   * so a multi-line braced import goes and an `export function foo() {` stays.
   */
  const withoutImports = (text: string) =>
    text.replace(/^(?:import|export)\b[^;]*?from\s+"[^"]*";/gm, "");

  /** Every name the wire owns. Re-declaring one is how the two halves split. */
  const OWNED = [
    "ValueEncoding",
    "SECRET_VALUE_ENCODING",
    "ParameterEnvelope",
    "RENDER_UNSAFE",
    "isRenderSafe",
    "encodeSecretValue",
    "secretRef",
    "isSecretRef",
    "ValueEncodingError",
    "decodeStoredValue",
    "parameterId",
    "variableOf",
  ];

  it("owns every name the wire declares", () => {
    // The list above is a list, and a list goes stale. Adding a symbol to
    // `wire.ts` without adding it here would leave that symbol unguarded — the
    // copy would still be byte-identical, and the secrets tree could declare its
    // own beside it. So the list is pinned AND derived: column-0 anchored, so a
    // `const` inside a function body is not a declaration of anything.
    const declared = [
      ...readFileSync(SOURCE, "utf8").matchAll(
        /^(?:export )?(?:declare )?(?:async )?(?:function|const|let|var|class|interface|type|enum) (\w+)/gm,
      ),
    ].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...OWNED].sort());
  });

  it.each(OWNED)("declares %s nowhere but the vendored copy", (name) => {
    const declaration = new RegExp(
      `^\\s*(export\\s+)?(async\\s+)?(function|const|let|var|class|interface|type|enum)\\s+${name}\\b`,
      "m",
    );
    const offenders = sources
      .filter(([, text]) => declaration.test(withoutImports(text)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("imports the vendored copy rather than shipping without it", () => {
    // The failure this catches: someone deletes the last import, the copy stays
    // byte-identical, and every test above keeps passing over dead code.
    const importers = sources
      .filter(([, text]) => /from "\.\/parameter-wire\.js"/.test(text))
      .map(([file]) => file);
    expect(importers.length).toBeGreaterThan(0);
  });
});
