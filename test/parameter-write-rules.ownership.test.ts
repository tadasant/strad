import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the TS program.
import { repoPath, VENDORED } from "../scripts/sync-vendored.mjs";

/** Taken from the manifest so this test follows the source if it moves. */
const SOURCE: string = repoPath(
  VENDORED.find((entry: { id: string }) => entry.id === "writerules").source,
);

/**
 * A byte comparison fails OPEN. A vendored copy nothing imports is in sync with
 * its source forever, and the tree can quietly keep a second implementation
 * beside it — which is exactly the state this seam replaced: three hand-written
 * rankings of a parameter's versions, two hand-written mints of the next version
 * id, and two hand-written edits of the IAM policy that decides whether a secret
 * parameter renders at all. So the copy being identical is only half the check:
 * the tree also has to be USING it.
 *
 * The other half — that the copy is byte-identical at all — is one entry in the
 * manifest and is checked in `test/vendored.sync.test.ts`. This file owns what is
 * true of THIS seam and of no other. It is the same shape as
 * `test/parameter-wire.ownership.test.ts`, deliberately: the two seams cross the
 * same boundary, address the same GCP parameter, and fail the same silent way.
 */
describe("the secrets tree has no second implementation of the write rules", () => {
  const dir = "servers/secrets/shared/src";
  const vendored = "parameter-write-rules.ts";

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
   * The strip is what makes the declaration scan mean something: an import block
   * spells `type IamPolicy,` exactly as a re-export list does, so a scan over the
   * raw text would call every CONSUMER of these rules a second implementation of
   * them. `[^;]*` cannot run past the end of a statement, so a multi-line braced
   * import goes and an `export function foo() {` stays.
   */
  const withoutImports = (text: string) =>
    text.replace(/^(?:import|export)\b[^;]*?from\s+"[^"]*";/gm, "");

  /** Every name the write rules own. Re-declaring one is how the halves split. */
  const OWNED = [
    "ListedVersion",
    "versionIdOf",
    "versionNumber",
    "rankVersions",
    "nextVersionId",
    "SECRET_ACCESSOR_ROLE",
    "IamBinding",
    "IamPolicy",
    "withSecretAccessor",
  ];

  it("owns every name the write rules declare", () => {
    // The list above is a list, and a list goes stale. Adding a symbol to
    // `src/secrets/parameters/write-rules.ts` without adding it here would leave
    // that symbol unguarded — the copy would still be byte-identical, and the
    // secrets tree could declare its own beside it. So the list is pinned AND
    // derived: column-0 anchored, so a `const` inside a function body is not a
    // declaration of anything.
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

  it("is imported by both the reader and the writer, not just one", () => {
    // The failure this catches: someone deletes the last import, the copy stays
    // byte-identical, and every test above keeps passing over dead code. BOTH
    // named, because the halves fail differently — a reader that ranks its own
    // way skips the version the writer wrote, and a writer that mints its own way
    // writes a version every reader skips.
    const importers = sources
      .filter(([, text]) => /from "\.\/parameter-write-rules\.js"/.test(text))
      .map(([file]) => file)
      .sort();
    expect(importers).toEqual(["parameter-manager.ts", "write-client.ts"]);
  });
});
