/**
 * Inject GHCR pull credentials into a rendered App Platform spec.
 *
 * App Platform pulls a private ghcr image on every restart and scale event, so
 * it needs a durable credential stored on the app — the job's GITHUB_TOKEN dies
 * with the job and would leave the app unable to re-pull. This adds
 * `registry_credentials` to every component whose image is GHCR.
 *
 *   node scripts/attach-registry-creds.mjs <spec.json> "<user>:<token>"
 *
 * The spec is rewritten in place. It already contains secret values (this is
 * the file the deploy sends to the API), so it must never be logged.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , specPath, cred] = process.argv;
if (!specPath || !cred || !cred.includes(":")) {
  console.error('usage: attach-registry-creds <spec.json> "<user>:<token>"');
  process.exit(1);
}

const doc = JSON.parse(readFileSync(specPath, "utf8"));
const spec = doc.spec ?? doc;

let touched = 0;
for (const svc of spec.services ?? []) {
  if (svc.image?.registry_type === "GHCR") {
    svc.image.registry_credentials = cred;
    touched++;
  }
}

writeFileSync(specPath, JSON.stringify(doc, null, 2));
console.error(`attached GHCR pull credential to ${touched} component(s).`);
