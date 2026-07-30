import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

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
 */

const REPO = new URL("..", import.meta.url).pathname;

/** Parameter Manager, in full. Note `parameterVersions.get` — there is no `.access`. */
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
 * `service.collection.verb`. Two-segment names (`roles/parametermanager.admin`,
 * `secretmanager.secretAccessor`) are ROLES, not permissions, and are not checked
 * here. API hostnames (`secretmanager.googleapis.com`) match the shape and are not
 * identifiers at all.
 */
const PERMISSION =
  /\b(?:parametermanager|secretmanager)\.[A-Za-z]+\.[A-Za-z]+\b/g;

/** Every place this repo writes prose a human copies commands out of. */
const ROOTS = [
  "docs/src/content/docs",
  "infra",
  "servers/secrets/README.md",
  "servers/bundle/README.md",
  "strad.config.example.yaml",
  "HACKS.md",
  "README.md",
  "AGENTS.md",
];

const EXTENSIONS = [".md", ".mdx", ".yaml", ".yml"];

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
