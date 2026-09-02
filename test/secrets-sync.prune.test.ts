import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * `secrets-sync.yml` destroys every superseded version of each secret it
 * writes (issue #240: Secret Manager bills every version that is not
 * DESTROYED, disabled ones included, and nothing else ever cleans one up).
 * The selection is the whole risk: a filter that picks the wrong version
 * destroys `latest`, and the next staging deploy renders without that
 * credential. So the shell in the workflow's `run:` block is exercised here,
 * against a stub `gcloud` on PATH that keeps secret state on disk and records
 * every `versions destroy`. No credential is involved and none could be.
 *
 * What is asserted: only the secret just written is touched; every version
 * but the one `versions add` returned is destroyed, whatever its state; an
 * already-DESTROYED version is left alone; a freshly created secret is not
 * pruned; nothing is destroyed on a secret whose add failed, whose listing
 * failed, or whose add returned something that is not a version name; a
 * destroy that fails is reported, the run continues, and it ends non-zero
 * naming the secret; and no secret VALUE reaches stdout, stderr or a gcloud
 * argument.
 */

const WORKFLOW = ".github/workflows/secrets-sync.yml";

/** The `run:` script of the upsert step, exactly as Actions would execute it. */
function upsertScript(): string {
  const wf = parse(readFileSync(WORKFLOW, "utf8")) as {
    jobs: { sync: { steps: { name?: string; run?: string }[] } };
  };
  const step = wf.jobs.sync.steps.find((s) =>
    s.name?.startsWith("Upsert strad-staging-"),
  );
  if (!step?.run) throw new Error("upsert step not found in " + WORKFLOW);
  return step.run;
}

/**
 * A stub `gcloud secrets …`. State: `$STUB_STATE/<secret>.versions`, one
 * `<n>\t<STATE>` line per version. Every call is appended to `$STUB_LOG`;
 * every destroy to `$STUB_DESTROYED`. `--data-file=-` is read and dropped —
 * a value never appears in any output, so a leak would be the workflow's.
 * Knobs: `STUB_FAIL_ADD=<secret>`, `STUB_FAIL_LIST=<secret>`,
 * `STUB_FAIL_DESTROY=<secret>:<n>`, `STUB_GARBAGE_ADD=<secret>` (prints the
 * human "Created version [n]…" line instead of a resource name),
 * `STUB_HIDE_NEWEST=<secret>` (the listing omits the newest version),
 * `STUB_FOREIGN_ADD=<secret>` (a second writer adds a version between this
 * run's add and its listing), `STUB_DESTROY_KEEP=<secret>` (that writer also
 * destroyed the version this run added).
 */
const STUB_GCLOUD = `#!/usr/bin/env bash
set -u
echo "gcloud $*" >> "$STUB_LOG"
[ "\${1:-}" = secrets ] || { echo "stub: unsupported \${1:-}" >&2; exit 2; }
shift; cmd="$1"; shift
proj=""; secret=""; fmt=""; positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project) proj="$2"; shift 2 ;;
    --secret) secret="$2"; shift 2 ;;
    --format=*) fmt="\${1#--format=}"; shift ;;
    --format) fmt="$2"; shift 2 ;;
    --data-file=-) cat >/dev/null; shift ;;
    --quiet|--replication-policy=automatic) shift ;;
    *) positional+=("$1"); shift ;;
  esac
done
[ "$proj" = test-project ] || { echo "stub: wrong --project '$proj'" >&2; exit 2; }
f() { echo "$STUB_STATE/$1.versions"; }
case "$cmd" in
  describe)
    [ -f "$(f "\${positional[0]}")" ] || { echo "ERROR: NOT_FOUND" >&2; exit 1; } ;;
  create)
    name="\${positional[0]}"
    [ -f "$(f "$name")" ] && { echo "ERROR: ALREADY_EXISTS" >&2; exit 1; }
    printf '1\\tENABLED\\n' > "$(f "$name")" ;;
  versions)
    vcmd="\${positional[0]}"; name="\${positional[1]:-}"
    case "$vcmd" in
      add)
        [ -f "$(f "$name")" ] || { echo "ERROR: NOT_FOUND" >&2; exit 1; }
        [ "\${STUB_FAIL_ADD:-}" = "$name" ] && { echo "ERROR: PERMISSION_DENIED (stub)" >&2; exit 1; }
        n=$(( $(cut -f1 "$(f "$name")" | sort -n | tail -1) + 1 ))
        printf '%s\\tENABLED\\n' "$n" >> "$(f "$name")"
        echo "Created version [$n] of the secret [$name]." >&2
        [ "$fmt" = "value(name)" ] || { echo "stub: unexpected add format '$fmt'" >&2; exit 2; }
        if [ "\${STUB_GARBAGE_ADD:-}" = "$name" ]; then echo "Created version [$n] of the secret [$name]."
        else echo "projects/123456789/secrets/$name/versions/$n"; fi ;;
      list)
        [ "$fmt" = "value(name.basename(),state)" ] || { echo "stub: unexpected list format '$fmt'" >&2; exit 2; }
        [ "\${STUB_FAIL_LIST:-}" = "$name" ] && { echo "ERROR: PERMISSION_DENIED (stub)" >&2; exit 1; }
        if [ "\${STUB_FOREIGN_ADD:-}" = "$name" ] && ! grep -q '^foreign' "$STUB_LOG"; then
          echo "foreign add on $name" >> "$STUB_LOG"
          n=$(( $(cut -f1 "$(f "$name")" | sort -n | tail -1) + 1 ))
          printf '%s\\tENABLED\\n' "$n" >> "$(f "$name")"
          if [ "\${STUB_DESTROY_KEEP:-}" = "$name" ]; then
            k=$((n - 1)); awk -v v="$k" -F'\t' -v OFS='\t' '$1==v{$2="DESTROYED"}1' "$(f "$name")" > "$(f "$name").tmp" && mv "$(f "$name").tmp" "$(f "$name")"
          fi
        fi
        if [ "\${STUB_HIDE_NEWEST:-}" = "$name" ]; then sort -rn "$(f "$name")" | tail -n +2; else sort -rn "$(f "$name")"; fi ;;
      destroy)
        v="\${positional[1]}"; name="$secret"
        [ "\${STUB_FAIL_DESTROY:-}" = "$name:$v" ] && { echo "ERROR: PERMISSION_DENIED (stub)" >&2; exit 1; }
        grep -q "^$v	" "$(f "$name")" || { echo "ERROR: NOT_FOUND" >&2; exit 1; }
        awk -v v="$v" -F'\t' -v OFS='\t' '$1==v{$2="DESTROYED"}1' "$(f "$name")" > "$(f "$name").tmp" && mv "$(f "$name").tmp" "$(f "$name")"
        echo "destroy $name $v" >> "$STUB_DESTROYED" ;;
      *) echo "stub: unsupported versions $vcmd" >&2; exit 2 ;;
    esac ;;
  *) echo "stub: unsupported secrets $cmd" >&2; exit 2 ;;
esac
`;

const VALUES = {
  STRAD_TOKENS: '[{"id":"t1","hash":"SECRET-VALUE-TOKENS"}]',
  ADMIN_BOOTSTRAP_TOKEN: "SECRET-VALUE-ADMIN",
  INTERNAL_TOKEN_IN: "SECRET-VALUE-INTERNAL",
};

type Versions = Record<string, string[]>; // "<n>\t<STATE>" lines, per secret

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  destroyed: string[];
  state: Versions;
}

function run(seed: Versions, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "secrets-sync-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "gcloud"), STUB_GCLOUD);
  chmodSync(join(bin, "gcloud"), 0o755);
  for (const [name, lines] of Object.entries(seed)) {
    writeFileSync(join(state, `${name}.versions`), lines.join("\n") + "\n");
  }
  const log = join(dir, "calls.log");
  const destroyed = join(dir, "destroyed.log");
  writeFileSync(log, "");
  writeFileSync(destroyed, "");
  const script = join(dir, "sync.sh");
  writeFileSync(script, upsertScript());
  const res = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_STATE: state,
      STUB_LOG: log,
      STUB_DESTROYED: destroyed,
      GCP_PROJECT_ID: "test-project",
      GOODEGGS_EMAIL: "",
      GOODEGGS_PASSWORD: "",
      ...VALUES,
      ...env,
    },
  });
  const finalState: Versions = {};
  for (const name of Object.keys({ ...seed, ...allSecrets(log) })) {
    try {
      finalState[name] = readFileSync(join(state, `${name}.versions`), "utf8")
        .trim()
        .split("\n");
    } catch {
      /* never created */
    }
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    destroyed: readFileSync(destroyed, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean),
    state: finalState,
  };
}

/** Every secret name any recorded call named, so a created one is read back. */
function allSecrets(log: string): Record<string, true> {
  const out: Record<string, true> = {};
  for (const m of readFileSync(log, "utf8").matchAll(
    /strad-staging-[A-Z_]+/g,
  )) {
    out[m[0]] = true;
  }
  return out;
}

const T = "strad-staging-STRAD_TOKENS";
const I = "strad-staging-STRAD_INTERNAL_TOKEN";
const A = "strad-staging-ADMIN_BOOTSTRAP_TOKEN";

/** The "SECRET-VALUE" marker must not appear anywhere but the `::add-mask::` line. */
function expectNoValueLeak(r: Run): void {
  const visible = [r.stdout, r.stderr, r.calls.join("\n")]
    .join("\n")
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
  expect(visible).not.toContain("SECRET-VALUE");
}

describe("secrets-sync.yml prunes superseded versions", () => {
  it("destroys every other version of the secret it wrote — enabled or disabled — and keeps the one it added", () => {
    const r = run({
      [T]: [
        "1\tENABLED",
        "2\tDISABLED",
        "3\tENABLED",
        "4\tDISABLED",
        "5\tENABLED",
      ],
      [I]: ["1\tDESTROYED", "2\tENABLED"],
      // ADMIN_BOOTSTRAP_TOKEN does not exist yet: created, one version.
    });
    expect(r.status).toBe(0);
    expect([...r.destroyed].sort()).toEqual(
      [
        `destroy ${T} 5`,
        `destroy ${T} 4`,
        `destroy ${T} 3`,
        `destroy ${T} 2`,
        `destroy ${T} 1`,
        `destroy ${I} 2`,
      ].sort(),
    );
    expect(r.state[T]).toEqual([
      "1\tDESTROYED",
      "2\tDESTROYED",
      "3\tDESTROYED",
      "4\tDESTROYED",
      "5\tDESTROYED",
      "6\tENABLED",
    ]);
    // The already-destroyed version is skipped, not destroyed again.
    expect(r.state[I]).toEqual(["1\tDESTROYED", "2\tDESTROYED", "3\tENABLED"]);
    expect(r.calls.filter((c) => c.includes(`--secret ${I}`))).toHaveLength(1);
    // A fresh secret has one version and sees no list and no destroy.
    expect(r.state[A]).toEqual(["1\tENABLED"]);
    expect(
      r.calls.filter((c) => c.includes(A) && /versions (list|destroy)/.test(c)),
    ).toEqual([]);
    expect(r.stdout).toContain(
      `pruned ${T}: kept version 6, destroyed 5, failed 0`,
    );
    expect(r.stdout).toContain(
      `pruned ${I}: kept version 3, destroyed 1, failed 0`,
    );
    expect(r.stdout).toContain(`created ${A}`);
    expect(r.stdout).toContain("Done.");
    expectNoValueLeak(r);
  });

  it("destroys nothing on a secret whose `versions add` failed, and the run stops there", () => {
    const r = run(
      {
        [T]: ["1\tENABLED", "2\tENABLED"],
        [I]: ["1\tENABLED", "2\tDISABLED", "3\tENABLED"],
        [A]: ["1\tENABLED"],
      },
      { STUB_FAIL_ADD: I },
    );
    expect(r.status).not.toBe(0);
    // The secret before it was written and pruned; the failed one is untouched.
    expect([...r.destroyed].sort()).toEqual([
      `destroy ${T} 1`,
      `destroy ${T} 2`,
    ]);
    expect(r.state[I]).toEqual(["1\tENABLED", "2\tDISABLED", "3\tENABLED"]);
    expect(r.state[A]).toEqual(["1\tENABLED"]);
    expect(r.stdout).not.toContain("Done.");
    expectNoValueLeak(r);
  });

  it("reports a destroy that fails, keeps going, and ends non-zero naming the secret", () => {
    const r = run(
      {
        [T]: ["1\tENABLED", "2\tENABLED", "3\tENABLED"],
        [I]: ["1\tENABLED"],
        [A]: ["1\tENABLED", "2\tDISABLED"],
      },
      { STUB_FAIL_DESTROY: `${T}:2` },
    );
    expect(r.status).toBe(1);
    expect(r.state[T]).toEqual([
      "1\tDESTROYED",
      "2\tENABLED",
      "3\tDESTROYED",
      "4\tENABLED",
    ]);
    // The later secrets were still written and pruned.
    expect(r.state[I]).toEqual(["1\tDESTROYED", "2\tENABLED"]);
    expect(r.state[A]).toEqual(["1\tDESTROYED", "2\tDESTROYED", "3\tENABLED"]);
    expect(r.stdout).toContain(
      `::error::${T}: could not destroy version 2 (was ENABLED); version 4 is live`,
    );
    expect(r.stdout).toContain(
      `pruned ${T}: kept version 4, destroyed 2, failed 1`,
    );
    expect(r.stdout).toMatch(
      new RegExp(
        `::error::every value above is live, but superseded versions remain on: ${T} `,
      ),
    );
    expect(r.stdout).not.toContain("Done.");
    expectNoValueLeak(r);
  });

  it("destroys nothing when `versions add` did not return a version resource name", () => {
    const r = run(
      {
        [T]: ["1\tENABLED", "2\tENABLED"],
        [I]: ["1\tENABLED"],
        [A]: ["1\tENABLED"],
      },
      { STUB_GARBAGE_ADD: T },
    );
    expect(r.status).toBe(1);
    expect(r.state[T]).toEqual(["1\tENABLED", "2\tENABLED", "3\tENABLED"]);
    expect(r.calls.filter((c) => c.includes(`--secret ${T}`))).toEqual([]);
    expect(r.stdout).toContain(`::error::${T}: 'versions add' printed `);
    expect(r.stdout).not.toContain("Created version [3]");
    expect(r.stdout).toMatch(
      /superseded versions remain on: strad-staging-STRAD_TOKENS /,
    );
    expectNoValueLeak(r);
  });

  it("destroys nothing when the listing fails", () => {
    const r = run(
      {
        [T]: ["1\tENABLED", "2\tENABLED"],
        [I]: ["1\tENABLED"],
        [A]: ["1\tENABLED"],
      },
      { STUB_FAIL_LIST: T },
    );
    expect(r.status).toBe(1);
    expect(r.state[T]).toEqual(["1\tENABLED", "2\tENABLED", "3\tENABLED"]);
    expect(r.calls.filter((c) => c.includes(`--secret ${T}`))).toEqual([]);
    expect(r.stdout).toContain(
      `::error::${T}: could not list versions; version 3 is live, no version destroyed`,
    );
    expectNoValueLeak(r);
  });

  it("destroys nothing when the version it would keep is not in the listing", () => {
    // A stub whose `list` omits the newest version: the workflow must refuse.
    const r = run(
      {
        [T]: ["1\tENABLED", "2\tENABLED"],
        [I]: ["1\tENABLED"],
        [A]: ["1\tENABLED"],
      },
      { STUB_HIDE_NEWEST: T },
    );
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c.includes(`--secret ${T}`))).toEqual([]);
    expect(r.stdout).toContain(
      `::error::${T}: version 3 from 'versions add' is not in the listing, not ENABLED; no version destroyed`,
    );
    expectNoValueLeak(r);
  });

  it("never destroys a version newer than the one it added — another writer's `latest`", () => {
    // Run A adds 3; run B adds 4 before A lists. A must leave 4 alone; it may
    // still destroy the versions it superseded, and ends red naming the secret.
    const r = run(
      {
        [T]: ["1\tENABLED", "2\tENABLED"],
        [I]: ["1\tENABLED"],
        [A]: ["1\tENABLED"],
      },
      { STUB_FOREIGN_ADD: T },
    );
    expect(r.status).toBe(1);
    expect(r.state[T]).toEqual([
      "1\tDESTROYED",
      "2\tDESTROYED",
      "3\tENABLED",
      "4\tENABLED",
    ]);
    expect(r.stdout).toContain(
      `::error::${T}: version 4 is newer than the 3 this run added`,
    );
    expect(r.stdout).toMatch(
      /superseded versions remain on: strad-staging-STRAD_TOKENS /,
    );
    expectNoValueLeak(r);
  });

  it("destroys nothing when the version it added is no longer ENABLED", () => {
    // Run B added 4 and destroyed A's 3 before A listed: A's keep is gone, so
    // A must not touch anything — least of all B's 4.
    const r = run(
      {
        [T]: ["1\tENABLED", "2\tENABLED"],
        [I]: ["1\tENABLED"],
        [A]: ["1\tENABLED"],
      },
      { STUB_FOREIGN_ADD: T, STUB_DESTROY_KEEP: T },
    );
    expect(r.status).toBe(1);
    expect(r.state[T]).toEqual([
      "1\tENABLED",
      "2\tENABLED",
      "3\tDESTROYED",
      "4\tENABLED",
    ]);
    expect(r.calls.filter((c) => c.includes(`--secret ${T}`))).toEqual([]);
    expect(r.stdout).toContain(
      `::error::${T}: version 3 from 'versions add' is DESTROYED, not ENABLED; no version destroyed`,
    );
    expectNoValueLeak(r);
  });

  it("does not destroy a listed version whose id is not a number", () => {
    const r = run({
      [T]: ["1\tENABLED", "latest\tENABLED"],
      [I]: ["1\tENABLED"],
      [A]: ["1\tENABLED"],
    });
    expect(r.status).toBe(1);
    expect(r.state[T]).toEqual([
      "1\tDESTROYED",
      "2\tENABLED",
      "latest\tENABLED",
    ]);
    expect(r.calls.filter((c) => c.includes("destroy latest"))).toEqual([]);
    expect(r.stdout).toContain(
      `::error::${T}: a listed version id is not a number; not destroyed`,
    );
    expectNoValueLeak(r);
  });

  it("never runs `secrets delete`", () => {
    const r = run({ [T]: ["1\tENABLED", "2\tENABLED"], [I]: ["1\tENABLED"] });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => /secrets delete/.test(c))).toBe(false);
  });
});
