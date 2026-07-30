import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PROBE_PERMISSIONS } from "../src/secrets/parameters/capabilities.ts";

/**
 * Every Google IAM identifier this repo's PROSE names, checked against the real ones.
 *
 * The sibling suite (`parameters.capabilities.test.ts`) pins the strings the CODE
 * sends. This pins the strings the DOCS tell a human to type, and that is the
 * surface that actually failed: `operate/secrets-iam.md` documented a custom role
 * containing `parametermanager.parameterVersions.access`, which Parameter Manager
 * does not define, so `gcloud iam roles create` refused the role and the whole
 * write-without-read downgrade could not be applied. The same page documented
 * `gcloud projects test-iam-permissions`, which is not a gcloud subcommand at all.
 * Neither is reachable from a unit test of the product code, because neither was
 * ever IN the product code.
 *
 * A permission name is not spell-checkable and not type-checkable. It is a string
 * a human copies out of a doc into a shell, where the only feedback is a Google
 * error — or, worse, silence. So the valid names live here, from
 * https://cloud.google.com/iam/docs/roles-permissions/parametermanager and
 * https://cloud.google.com/iam/docs/roles-permissions/secretmanager, and prose
 * that invents one fails the build.
 *
 * ## The half that was missing, and the failure that proved it
 *
 * Checking permission SPELLING catches three of the four identifiers this repo
 * has got wrong. It does not catch the fourth, which is worse, because every
 * string in it is real: the resolver's grant was specified as
 * `roles/parametermanager.parameterViewer` + `roles/secretmanager.secretAccessor`,
 * both genuine roles, for an operation (`resolve()` → `:render`) whose permission
 * neither of them contains. `gcloud` accepts it, the binding lands, the audit
 * assertion passes, and the resolver renders nothing. A spelling checker cannot
 * see that; only a checker that knows what a role CONTAINS can.
 *
 * So the second half of this file closes the loop end to end:
 *
 *   docs name a role  →  the role's real permissions  →  the permissions the
 *   code's API calls need  →  do the first cover the last?
 *
 * `PREDEFINED_ROLES` is Google's published role→permission mapping. `OPERATIONS`
 * is strad's call sites, one entry per method in `src/secrets/parameters/gcp.ts`.
 * `IDENTITIES` says which operations each service account performs, and the grant
 * side is READ OUT OF THE DOCS rather than restated here — so the test fails when
 * the page is wrong, not when this file disagrees with itself.
 */

const REPO = new URL("..", import.meta.url).pathname;

/**
 * Parameter Manager. Note `parameterVersions.get` — there is no `.access`.
 *
 * A transcription of Google's page, so it ages: a permission added upstream is
 * absent here, and the first doc that legitimately names one fails the "never
 * names a permission Google does not define" test. That failure means "add it to
 * this list", not "the doc is wrong" — check the page before assuming otherwise.
 */
const PARAMETER_MANAGER = new Set([
  "parametermanager.locations.get",
  "parametermanager.locations.list",
  "parametermanager.operations.get",
  "parametermanager.operations.list",
  "parametermanager.parameters.create",
  "parametermanager.parameters.delete",
  "parametermanager.parameters.get",
  "parametermanager.parameters.list",
  "parametermanager.parameters.update",
  "parametermanager.parameterVersions.create",
  "parametermanager.parameterVersions.delete",
  "parametermanager.parameterVersions.get",
  "parametermanager.parameterVersions.list",
  "parametermanager.parameterVersions.render",
  "parametermanager.parameterVersions.update",
]);

/** Secret Manager. `versions.access` is real here — that is where the verb comes from. */
const SECRET_MANAGER = new Set([
  "secretmanager.locations.get",
  "secretmanager.locations.list",
  "secretmanager.secrets.create",
  "secretmanager.secrets.delete",
  "secretmanager.secrets.get",
  "secretmanager.secrets.getIamPolicy",
  "secretmanager.secrets.list",
  "secretmanager.secrets.setIamPolicy",
  "secretmanager.secrets.update",
  "secretmanager.versions.access",
  "secretmanager.versions.add",
  "secretmanager.versions.destroy",
  "secretmanager.versions.disable",
  "secretmanager.versions.enable",
  "secretmanager.versions.get",
  "secretmanager.versions.list",
]);

const VALID = new Set([...PARAMETER_MANAGER, ...SECRET_MANAGER]);

/**
 * Google's predefined roles, and what each one CONTAINS.
 *
 * Transcribed from the same two pages as the permission lists above. Only the
 * `parametermanager.*` and `secretmanager.*` permissions of each role are listed —
 * `roles/*.admin` also carries a couple of `resourcemanager.projects.*` reads,
 * which no strad operation needs and which would only add noise here.
 *
 * The entry that matters is `parameterAccessor`: render, and nothing else. It
 * cannot even list, which is why the resolver needs the viewer role TOO and why
 * "just swap one role for the other" would have been the next wrong fix.
 */
const PREDEFINED_ROLES: Record<string, readonly string[]> = {
  "roles/parametermanager.admin": [...PARAMETER_MANAGER],
  "roles/parametermanager.editor": [
    "parametermanager.locations.get",
    "parametermanager.locations.list",
    "parametermanager.parameters.create",
    "parametermanager.parameters.delete",
    "parametermanager.parameters.get",
    "parametermanager.parameters.list",
    "parametermanager.parameters.update",
    "parametermanager.parameterVersions.create",
    "parametermanager.parameterVersions.delete",
    "parametermanager.parameterVersions.get",
    "parametermanager.parameterVersions.list",
    "parametermanager.parameterVersions.update",
  ],
  // Render access. NOT a superset of the viewer: it holds no list and no get.
  "roles/parametermanager.parameterAccessor": [
    "parametermanager.locations.get",
    "parametermanager.locations.list",
    "parametermanager.parameterVersions.render",
  ],
  "roles/parametermanager.parameterVersionAdder": [
    "parametermanager.locations.get",
    "parametermanager.locations.list",
    "parametermanager.parameters.get",
    "parametermanager.parameters.list",
    "parametermanager.parameterVersions.create",
  ],
  "roles/parametermanager.parameterVersionManager": [
    "parametermanager.locations.get",
    "parametermanager.locations.list",
    "parametermanager.parameters.get",
    "parametermanager.parameters.list",
    "parametermanager.parameterVersions.create",
    "parametermanager.parameterVersions.delete",
    "parametermanager.parameterVersions.get",
    "parametermanager.parameterVersions.list",
    "parametermanager.parameterVersions.update",
  ],
  // Read access to parameters and their versions. NO render — this is the one
  // the resolver's grant stopped at.
  "roles/parametermanager.parameterViewer": [
    "parametermanager.locations.get",
    "parametermanager.locations.list",
    "parametermanager.parameters.get",
    "parametermanager.parameters.list",
    "parametermanager.parameterVersions.get",
    "parametermanager.parameterVersions.list",
  ],
  "roles/parametermanager.viewer": [
    "parametermanager.locations.get",
    "parametermanager.locations.list",
    "parametermanager.parameters.get",
    "parametermanager.parameters.list",
    "parametermanager.parameterVersions.get",
    "parametermanager.parameterVersions.list",
  ],
  "roles/secretmanager.admin": [...SECRET_MANAGER],
  "roles/secretmanager.editor": [
    "secretmanager.locations.get",
    "secretmanager.locations.list",
    "secretmanager.secrets.create",
    "secretmanager.secrets.delete",
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.list",
    "secretmanager.secrets.update",
    "secretmanager.versions.add",
    "secretmanager.versions.destroy",
    "secretmanager.versions.disable",
    "secretmanager.versions.enable",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ],
  // One permission. This is the entire role, and it is why granting it to the
  // resolver could never have made `:render` work.
  "roles/secretmanager.secretAccessor": ["secretmanager.versions.access"],
  "roles/secretmanager.secretVersionAdder": ["secretmanager.versions.add"],
  "roles/secretmanager.secretVersionManager": [
    "secretmanager.versions.add",
    "secretmanager.versions.destroy",
    "secretmanager.versions.disable",
    "secretmanager.versions.enable",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ],
  "roles/secretmanager.viewer": [
    "secretmanager.locations.get",
    "secretmanager.locations.list",
    "secretmanager.secrets.get",
    "secretmanager.secrets.getIamPolicy",
    "secretmanager.secrets.list",
    "secretmanager.versions.get",
    "secretmanager.versions.list",
  ],
};

/**
 * What each store operation CALLS, one entry per method in
 * `src/secrets/parameters/gcp.ts`. This is the same derivation the table at the
 * top of `operate/secrets-iam.md` states in prose.
 *
 * `list` is implicit in every other operation — the console reads before it
 * writes, and `resolve()` opens with one — so `permissionsFor()` folds it in
 * rather than repeating it per entry.
 */
const OPERATIONS = {
  /** `list()`: parameters page, versions page, version GET. */
  list: [
    "parametermanager.parameters.list",
    "parametermanager.parameterVersions.list",
    "parametermanager.parameterVersions.get",
  ],
  /** `create()`, non-secret half: the parameter and its first version. */
  createParameter: [
    PROBE_PERMISSIONS.createParameter,
    PROBE_PERMISSIONS.writeParameter,
  ],
  /** `create()`, secret half: the Secret Manager secret and its first version. */
  createSecret: [
    PROBE_PERMISSIONS.createSecret,
    PROBE_PERMISSIONS.writeSecretValue,
  ],
  /** `rotate()` / `setNote()`: a new version on one side or the other. */
  write: [PROBE_PERMISSIONS.writeParameter, PROBE_PERMISSIONS.writeSecretValue],
  /** `reveal()` of a SECRET: `versions/latest:access`. The console's alone. */
  reveal: [PROBE_PERMISSIONS.readSecretValue],
  /** `destroy()`: every version, the parameter, and the backing secret. */
  destroy: [
    "parametermanager.parameters.get",
    PROBE_PERMISSIONS.deleteParameter,
    "parametermanager.parameterVersions.delete",
    "secretmanager.secrets.delete",
  ],
  /** `resolve()`: one `:render` per parameter. The resolver's whole job. */
  resolve: [PROBE_PERMISSIONS.renderParameter],
} as const;

type Operation = keyof typeof OPERATIONS;

/**
 * The three service accounts, by what they DO — not by what they are granted.
 * The grant is the docs' claim, and the point of this file is to check it.
 *
 * `mustNotHold` is the other half of each identity's contract, and it is a
 * security property rather than a typo check: a viewer that could render is the
 * `/mcp` channel reading a secret value, and a resolver that could write is a
 * compromised gateway rewriting the store.
 */
const IDENTITIES: Record<
  string,
  { does: readonly Operation[]; mustNotHold: readonly string[] }
> = {
  // servers/secrets, on the bundle: list and read NON-secret values.
  //
  // `mustNotHold` here is not defence in depth. `render` is a live read path —
  // the parameter's own principal must hold `secretAccessor` for resolution to
  // work at all — so this role split is the whole fence. See the dedicated test.
  viewer: {
    does: ["list"],
    mustNotHold: [
      PROBE_PERMISSIONS.readSecretValue,
      PROBE_PERMISSIONS.renderParameter,
    ],
  },
  // The SSO-gated console: everything, reveal included.
  admin: {
    does: [
      "list",
      "createParameter",
      "createSecret",
      "write",
      "reveal",
      "destroy",
    ],
    mustNotHold: [],
  },
  // The gateway container and render-spec: resolve, and write nothing.
  resolver: {
    does: ["list", "resolve"],
    mustNotHold: [
      PROBE_PERMISSIONS.writeParameter,
      PROBE_PERMISSIONS.writeSecretValue,
      PROBE_PERMISSIONS.deleteParameter,
      PROBE_PERMISSIONS.createParameter,
      PROBE_PERMISSIONS.createSecret,
    ],
  },
};

/** Everything an identity's API calls need, `list` folded into each. */
function permissionsFor(identity: keyof typeof IDENTITIES): string[] {
  const out = new Set<string>(OPERATIONS.list);
  for (const op of IDENTITIES[identity]!.does) {
    for (const p of OPERATIONS[op]) out.add(p);
  }
  return [...out].sort();
}

/** Everything a set of roles grants, unioned. Unknown role => grants nothing. */
function grantedBy(roles: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const role of roles) {
    for (const p of PREDEFINED_ROLES[role] ?? []) out.add(p);
  }
  return out;
}

/**
 * A role name, in either spelling the docs use: `roles/parametermanager.admin`
 * in a `gcloud` line, bare `parametermanager.parameterViewer` in a table cell.
 *
 * Two segments exactly. The trailing lookahead is what keeps a PERMISSION
 * (`secretmanager.versions.access`) and an API hostname
 * (`secretmanager.googleapis.com`) from matching their own first two segments.
 */
const ROLE =
  /\b(?:roles\/)?(?:parametermanager|secretmanager)\.[a-zA-Z]+(?![.\w])/g;

/**
 * The SHORT name of every role whose short name is unambiguous, mapped to the
 * full one — `parameterAccessor` -> `roles/parametermanager.parameterAccessor`.
 *
 * Prose writes both forms, often in one sentence ("`parameterViewer` is the read
 * role; `parameterAccessor` is the deref"), and a parser that saw only the
 * qualified form would read a cell granting bare `parameterAccessor` as granting
 * nothing — silently, on the one row where that is a production read path.
 *
 * `admin`, `editor` and `viewer` are deliberately absent: both services define
 * them, so a bare one names no particular role.
 */
const SHORT_ROLE_NAMES = (() => {
  const seen = new Map<string, string[]>();
  for (const full of Object.keys(PREDEFINED_ROLES)) {
    const short = full.slice(full.lastIndexOf(".") + 1);
    seen.set(short, [...(seen.get(short) ?? []), full]);
  }
  const unique = new Map<string, string>();
  for (const [short, fulls] of seen) {
    if (fulls.length === 1) unique.set(short, fulls[0]!);
  }
  return unique;
})();

const SHORT_ROLE = new RegExp(
  `\\b(?:${[...SHORT_ROLE_NAMES.keys()].join("|")})\\b`,
  "g",
);

/** `parametermanager.admin` and `roles/parametermanager.admin` are one role. */
function normalizeRole(token: string): string {
  if (SHORT_ROLE_NAMES.has(token)) return SHORT_ROLE_NAMES.get(token)!;
  return token.startsWith("roles/") ? token : `roles/${token}`;
}

/** Every role a fragment names, qualified or bare, with where it was named. */
function roleTokensIn(text: string): { role: string; at: number }[] {
  const out: { role: string; at: number }[] = [];
  for (const pattern of [ROLE, SHORT_ROLE]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // A short name inside a qualified one is the same mention twice.
      if (pattern === SHORT_ROLE && /[./]$/.test(text.slice(0, match.index))) {
        continue;
      }
      out.push({ role: normalizeRole(match[0]), at: match.index });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const SECRETS_MD = join(REPO, "docs/src/content/docs/operate/secrets.md");
const SECRETS_IAM_MD = join(
  REPO,
  "docs/src/content/docs/operate/secrets-iam.md",
);

/**
 * The roles `operate/secrets.md`'s identity table recommends, per identity.
 *
 * Parsed rather than restated, so that editing the table is what this test
 * checks. A row that stops matching is a failure, not a silent skip: the
 * assertion below pins the identity set, so deleting or renaming a row fails
 * here rather than quietly checking nothing.
 */
/**
 * Split a cell into the roles it GRANTS and the roles it FORBIDS.
 *
 * A cell may name a role in order to forbid it — the viewer row's
 * "`parameterViewer`, and **never** `parameterAccessor`" is the load-bearing
 * example, and reading that as a grant would invert the security property this
 * file exists to protect.
 *
 * The scope of a "never" is the role it introduces, within its own clause. Two
 * cheaper rules were tried and both are wrong in a way an editor cannot see:
 *
 *   - "everything after the first never is forbidden" reads
 *     "never `parameterAccessor`, only `parameterViewer`" as granting nothing,
 *     failing on a correct doc, and word order silently becomes load-bearing;
 *   - "the first role after a never is forbidden" reads
 *     "`parameterViewer` — never a write role; staging adds `parameterAccessor`"
 *     as forbidding the accessor it in fact grants.
 *
 * Clause boundaries cap the negation, and inside a clause it reaches the next
 * role and stops. Both of the above then come out right.
 */
function classifyRoles(cell: string): {
  granted: string[];
  forbidden: string[];
} {
  const granted: string[] = [];
  const forbidden: string[] = [];
  // `;`, `|`, and a period that ENDS A SENTENCE. Not every period: a role name
  // is full of them, and splitting on those would cut `parametermanager.admin`
  // into two fragments that name nothing.
  for (const clause of cell.split(/[;|]|\.(?=\s|$)/)) {
    const marker = /\b(?:never|not)\b/i.exec(clause);
    let negated = marker !== null;
    for (const { role, at } of roleTokensIn(clause)) {
      if (negated && marker && at > marker.index) {
        forbidden.push(role);
        negated = false; // the negation covers one role, then it is spent
      } else {
        granted.push(role);
      }
    }
  }
  return { granted, forbidden };
}

function grantedRolesIn(cell: string): string[] {
  return classifyRoles(cell).granted;
}

function documentedGrants(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of readFileSync(SECRETS_MD, "utf8").split("\n")) {
    const row = /^\|\s*\*\*(viewer|admin|resolver)\*\*\s*\|([^|]*)\|/.exec(
      line,
    );
    if (!row) continue;
    out[row[1]!] = grantedRolesIn(row[2]!);
  }
  return out;
}

/**
 * The `includedPermissions:` of every custom role `operate/secrets-iam.md`
 * tells a human to create, unioned. They are inside heredocs in a bash block,
 * so this reads the lines rather than parsing YAML.
 *
 * A `#` comment between two items does NOT end the list — the roles here are
 * commented inline to explain why each permission is present, and a collector
 * that stopped at the first comment would silently check only the permissions
 * above it and report the rest as missing from a role that grants them.
 */
function customRolePermissions(): string[] {
  const out = new Set<string>();
  let collecting = false;
  for (const line of readFileSync(SECRETS_IAM_MD, "utf8").split("\n")) {
    if (/^includedPermissions:\s*$/.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    const item = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (item) out.add(item[1]!);
    else if (!/^\s*(#.*)?$/.test(line)) collecting = false;
  }
  return [...out].sort();
}

/**
 * `service.collection.verb`. Two-segment names (`roles/parametermanager.admin`,
 * `secretmanager.secretAccessor`) are ROLES, not permissions, and are not checked
 * here. API hostnames (`secretmanager.googleapis.com`) match the shape and are not
 * identifiers at all.
 */
const PERMISSION =
  /\b(?:parametermanager|secretmanager)\.[A-Za-z]+\.[A-Za-z]+\b/g;

/**
 * Every place this repo names an identifier a human reads and acts on.
 *
 * `scripts/` and `src/` are in scope, and not as an afterthought: `check-store`
 * prints `roles/parametermanager.parameterAccessor` straight at an operator's
 * terminal when a render fails, and the header comments in `store.ts` and
 * `render-spec.ts` are where the next reader learns which identity the gateway
 * holds. A wrong role name is exactly as costly there as on a docs page.
 */
const ROOTS = [
  "docs/src/content/docs",
  "infra",
  "scripts",
  "src",
  "servers/secrets/README.md",
  "servers/bundle/README.md",
  "strad.config.example.yaml",
  "HACKS.md",
  "README.md",
  "AGENTS.md",
];

const EXTENSIONS = [".md", ".mdx", ".yaml", ".yml", ".ts"];

function walk(path: string, out: string[] = []): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return out;
  if (stat.isFile()) {
    if (EXTENSIONS.some((ext) => path.endsWith(ext))) out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) walk(join(path, entry), out);
  return out;
}

const FILES = ROOTS.flatMap((root) => walk(join(REPO, root)));

describe("IAM identifiers in prose", () => {
  it("scans the files it thinks it scans", () => {
    // A walk that silently found nothing would make every assertion below vacuous.
    expect(FILES.length).toBeGreaterThan(15);
    expect(FILES.map((f) => relative(REPO, f))).toContain(
      "docs/src/content/docs/operate/secrets-iam.md",
    );
  });

  it("never names a permission Google does not define", () => {
    const bad: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // A doc may name a WRONG identifier in order to warn about it — that is
        // what the note in secrets-iam.md does. Saying "there is no X" is the
        // only licence to write X, and it has to be on the same line.
        if (/there is no/i.test(line)) return;
        for (const match of line.match(PERMISSION) ?? []) {
          if (match.includes(".googleapis.")) continue;
          if (!VALID.has(match)) {
            bad.push(`${relative(REPO, file)}:${i + 1}  ${match}`);
          }
        }
      });
    }
    expect(bad).toStrictEqual([]);
  });

  it("never names a ROLE Google does not define", () => {
    // `roles/parametermanager.parameterAdmin` was the first of these. It is a
    // plausible name, it is not a real one, and `gcloud` answers with a 400 that
    // reads like a typo in the command rather than in the doc.
    const bad: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/there is no/i.test(line)) return;
        for (const match of line.match(ROLE) ?? []) {
          const role = normalizeRole(match);
          if (!(role in PREDEFINED_ROLES)) {
            bad.push(`${relative(REPO, file)}:${i + 1}  ${role}`);
          }
        }
      });
    }
    expect(bad).toStrictEqual([]);
  });

  it("scans the identity table it thinks it scans", () => {
    // Every assertion below reads this table. A renamed row, a reformatted cell
    // or a deleted section would otherwise turn them all into vacuous passes.
    const grants = documentedGrants();
    expect(Object.keys(grants).sort()).toStrictEqual([
      "admin",
      "resolver",
      "viewer",
    ]);
    for (const [identity, roles] of Object.entries(grants)) {
      expect(roles.length, `${identity} names no role`).toBeGreaterThan(0);
    }
  });
});

/**
 * The check the spelling test cannot make: does the role we recommend actually
 * CONTAIN the permission the code's calls need?
 *
 * This is the assertion that fails on the resolver grant as it was written — both
 * role names real, neither carrying `parameterVersions.render` — and it is the
 * reason this file exists in the shape it does.
 */
describe("documented grants vs. what the code calls", () => {
  it("gives every identity the permissions its own API calls need", () => {
    const grants = documentedGrants();
    const shortfall: string[] = [];
    for (const identity of Object.keys(IDENTITIES)) {
      const granted = grantedBy(grants[identity] ?? []);
      for (const needed of permissionsFor(identity)) {
        if (!granted.has(needed)) {
          shortfall.push(
            `${identity}: documented roles [${(grants[identity] ?? []).join(", ")}] ` +
              `do not grant ${needed}`,
          );
        }
      }
    }
    expect(shortfall).toStrictEqual([]);
  });

  it("gives no identity a permission its contract says it must not hold", () => {
    const grants = documentedGrants();
    const excess: string[] = [];
    for (const [identity, contract] of Object.entries(IDENTITIES)) {
      const granted = grantedBy(grants[identity] ?? []);
      for (const forbidden of contract.mustNotHold) {
        if (granted.has(forbidden)) {
          excess.push(`${identity}: documented roles grant ${forbidden}`);
        }
      }
    }
    expect(excess).toStrictEqual([]);
  });

  it("never lets prod's MCP credential hold a role that carries `render`", () => {
    // THE security invariant on this page, and the one with the least margin.
    //
    // `:render` returns a secret VALUE, and it dereferences as the parameter's
    // OWN principal rather than the caller's. That principal must hold
    // `secretmanager.secretAccessor` on the secret or nothing resolves at all
    // (issue #49), so `render` is a live read path and withholding
    // `secretmanager.versions.access` from the `secrets` MCP server does not
    // close it. What keeps the `/mcp` channel away from a production secret
    // value is one thing only: prod's viewer credential holds `parameterViewer`
    // (get/list) and NOT `parameterAccessor` (which carries `render`).
    //
    // And the trap is that widening it looks reasonable: the credential exists
    // to READ PARAMETERS, and `parameterAccessor` is named as though it is the
    // role for that. It is not. Several of this repo's own documents have
    // misstated exactly that distinction, so assume the next reader will too.
    const why =
      "The `secrets` MCP credential must never be documented as holding a role " +
      "that carries parametermanager.parameterVersions.render. `:render` " +
      "returns a secret VALUE and derefs as the parameter's own principal, " +
      "which strad grants secretAccessor — so withholding " +
      "secretmanager.versions.access is NOT sufficient. This role split is the " +
      "single remaining barrier between /mcp and production secret values " +
      "(tadasant-internal#202), not a stylistic preference. `parameterViewer` " +
      "is the read role; `parameterAccessor` is the deref, despite the names.";

    const viewer = documentedGrants().viewer ?? [];
    const carriesRender = viewer.filter((role) =>
      (PREDEFINED_ROLES[role] ?? []).includes(
        PROBE_PERMISSIONS.renderParameter,
      ),
    );
    expect(carriesRender, why).toStrictEqual([]);

    // Belt and braces: the same claim by PERMISSION, so a future role that
    // happens to include `render` is caught even if nobody adds it to the list
    // above by name.
    const granted = grantedBy(viewer);
    expect(granted.has(PROBE_PERMISSIONS.renderParameter), why).toBe(false);
    expect(granted.has(PROBE_PERMISSIONS.readSecretValue), why).toBe(false);
  });

  it("requires the viewer row to FORBID the accessor role, not merely omit it", () => {
    // Omission is indistinguishable from an oversight, and it survives the one
    // edit most likely to erode this: a merge resolution that takes the older
    // side of the identity table. A row that has to SAY "never" cannot be
    // reverted to a row that does not without failing here.
    const row = readFileSync(SECRETS_MD, "utf8")
      .split("\n")
      .find((line) => /^\|\s*\*\*viewer\*\*/.test(line));
    expect(row, "the identity table has no viewer row").toBeDefined();
    expect(
      row,
      "the viewer row must say explicitly that this credential never holds " +
        "parameterAccessor. Omitting the role reads as an oversight; saying " +
        "'never' is what stops the next reader from 'fixing' the viewer by " +
        "granting it the role that renders.",
    ).toMatch(/never[^|]*parameterAccessor/i);
  });

  it("reads a role named to FORBID it as forbidden, not as granted", () => {
    // A parser that took every role token in a cell would read the prohibition
    // above as a grant and fail the invariant — turning the doc's clearest
    // statement of the boundary into a CI failure.
    const cell =
      "`parametermanager.parameterViewer`, and **never** `parametermanager.parameterAccessor`";
    expect(classifyRoles(cell)).toStrictEqual({
      granted: ["roles/parametermanager.parameterViewer"],
      forbidden: ["roles/parametermanager.parameterAccessor"],
    });
    // Negative control: the naive parse this replaced DID see two grants, so
    // this test fails if the negation handling is ever dropped.
    expect([...(cell.match(ROLE) ?? [])].map(normalizeRole)).toContain(
      "roles/parametermanager.parameterAccessor",
    );
  });

  it("reads the SHORT form of a role name too", () => {
    // Prose writes `parameterAccessor` as often as the qualified name, and a
    // parser blind to the short form would read a cell granting it as granting
    // nothing at all — on the one row where that is a production read path.
    expect(grantedRolesIn("`parameterViewer` + `parameterAccessor`")).toContain(
      "roles/parametermanager.parameterAccessor",
    );
    expect(
      classifyRoles("`parameterViewer`, never `parameterAccessor`"),
    ).toStrictEqual({
      granted: ["roles/parametermanager.parameterViewer"],
      forbidden: ["roles/parametermanager.parameterAccessor"],
    });
    // A bare `admin` names no role: both services define one.
    expect(grantedRolesIn("the `admin` identity")).toStrictEqual([]);
  });

  it("does not let a grant hide behind an unrelated `never`", () => {
    // "…never a write role; staging adds `parameterAccessor`" grants the
    // accessor, and a negation that swallowed the rest of the cell would report
    // it as forbidden — a false pass on exactly the edit that matters.
    expect(
      grantedRolesIn(
        "`parametermanager.parameterViewer` — never a write role; staging adds `parametermanager.parameterAccessor`",
      ),
    ).toContain("roles/parametermanager.parameterAccessor");
    // …and the reverse order still reads correctly.
    expect(
      grantedRolesIn(
        "never `parametermanager.parameterAccessor`, only `parametermanager.parameterViewer`",
      ),
    ).toStrictEqual(["roles/parametermanager.parameterViewer"]);
  });

  it("keeps the resolver's two Parameter Manager roles BOTH load-bearing", () => {
    // The narrow reading of the bug is "one role name was wrong". The narrow fix
    // — swap viewer for accessor — is also broken, because the accessor role
    // cannot list. Pin both directions so neither half can be dropped as
    // redundant later.
    const resolver = documentedGrants().resolver ?? [];
    expect(resolver).toContain("roles/parametermanager.parameterViewer");
    expect(resolver).toContain("roles/parametermanager.parameterAccessor");

    const viewerOnly = grantedBy(["roles/parametermanager.parameterViewer"]);
    const accessorOnly = grantedBy([
      "roles/parametermanager.parameterAccessor",
    ]);
    expect(viewerOnly.has(PROBE_PERMISSIONS.renderParameter)).toBe(false);
    expect(accessorOnly.has("parametermanager.parameters.list")).toBe(false);
  });

  it("keeps the console's custom roles able to do everything but reveal", () => {
    // The custom roles in this page are hand-written permission lists, so they
    // can lose a line the way a role name can be wrong: drop
    // `parameterVersions.create` and the console silently cannot rotate.
    const granted = new Set(customRolePermissions());
    expect(granted.size).toBeGreaterThan(10);

    // Deliberately withheld, and the whole point of the downgrade: neither read
    // path to a secret VALUE.
    const withheld = [
      PROBE_PERMISSIONS.readSecretValue,
      PROBE_PERMISSIONS.renderParameter,
    ];
    for (const permission of withheld) {
      expect(granted.has(permission)).toBe(false);
    }

    const missing = permissionsFor("admin")
      .filter((p) => !withheld.includes(p as never))
      .filter((p) => !granted.has(p));
    expect(missing).toStrictEqual([]);
  });

  it("builds its role table out of permissions Google defines", () => {
    // The role table is transcription, and a typo in it would make every
    // assertion above wrong in the safe-looking direction.
    const bad: string[] = [];
    for (const [role, permissions] of Object.entries(PREDEFINED_ROLES)) {
      for (const permission of permissions) {
        if (!VALID.has(permission)) bad.push(`${role}: ${permission}`);
      }
    }
    for (const [operation, permissions] of Object.entries(OPERATIONS)) {
      for (const permission of permissions) {
        if (!VALID.has(permission)) bad.push(`${operation}(): ${permission}`);
      }
    }
    expect(bad).toStrictEqual([]);
  });
});

describe("IAM identifiers in prose (cont.)", () => {
  it("never tells a human to run a gcloud subcommand that does not exist", () => {
    // `testIamPermissions` is a method on the resource, not a CLI verb. The audit
    // in secrets-iam.md is a REST call for exactly this reason.
    const bad: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/there is no/i.test(line)) return;
        if (/gcloud\s+projects\s+test-iam-permissions/.test(line)) {
          bad.push(`${relative(REPO, file)}:${i + 1}`);
        }
      });
    }
    expect(bad).toStrictEqual([]);
  });
});
