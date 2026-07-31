import { randomUUID } from "node:crypto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import type { Resource } from "@opentelemetry/resources";

/**
 * Who is emitting this telemetry?
 *
 * strad deploys several App Platform components (staging: core, bundle and
 * bundle-zimmer-secrets), and the whole question we are trying to answer —
 * "which one is dying, and of what" — is unanswerable if they all report as
 * "strad". So the resource has to say precisely which component this is.
 * (Nothing here assumes a count: a config with more bundles gets more
 * components, and each names itself the same way.)
 *
 * The one attribute that matters most now that everything shares one bundle
 * is `service.instance.id`: it is regenerated on every process start, so
 * `count(distinct service.instance.id)` over a window IS the restart count. App
 * Platform restarts a component on OOM and tells you almost nothing; a new
 * instance id appearing, with `strad.container.memory.utilization` pinned near
 * 1.0 in the seconds before it, is the OOM fingerprint.
 */

export interface ResourceIdentity {
  mode: "core" | "bundle";
  /** Component name: "core", or the bundle name ("bundle-fetchpet"). */
  component: string;
  version: string;
  /** staging | prod | dev */
  environment: string;
}

/**
 * Derive this process's identity from the environment.
 *
 * `STRAD_COMPONENT` is set per-component by the app spec (see deploy/appspec.ts).
 * It is deliberately not inferred from STRAD_BUNDLE alone, because a
 * supplementary image (fetchpet, bundle-google) does not run strad's code and
 * has no STRAD_BUNDLE — it still needs to say which component it is.
 */
export function identityFromEnv(
  env: NodeJS.ProcessEnv,
  fallback: Partial<ResourceIdentity> = {},
): ResourceIdentity {
  const mode = (env.STRAD_MODE ?? fallback.mode ?? "core") as "core" | "bundle";
  const component =
    env.STRAD_COMPONENT ??
    fallback.component ??
    (mode === "bundle" ? (env.STRAD_BUNDLE ?? "bundle") : "core");

  return {
    mode,
    component,
    version: env.STRAD_VERSION ?? fallback.version ?? "0.0.0",
    environment: env.STRAD_ENV ?? fallback.environment ?? "dev",
  };
}

/**
 * The service name.
 *
 * `OTEL_SERVICE_NAME` wins when the operator sets it — that is the standard
 * knob and we do not get to override it. Otherwise we derive one PER COMPONENT
 * (`strad-core`, `strad-bundle`), because the core and the bundle sharing one
 * service name would average their way out of exactly the signal we need.
 */
export function serviceName(
  env: NodeJS.ProcessEnv,
  identity: ResourceIdentity,
): string {
  const explicit = env.OTEL_SERVICE_NAME?.trim();
  if (explicit) return explicit;
  return identity.component === "core"
    ? "strad-core"
    : `strad-${identity.component}`;
}

export function buildResource(
  env: NodeJS.ProcessEnv,
  identity: ResourceIdentity,
): Resource {
  return defaultResource().merge(
    resourceFromAttributes({
      "service.name": serviceName(env, identity),
      "service.version": identity.version,
      "service.namespace": "strad",
      // Regenerated on every process start. This is the restart signal — see above.
      "service.instance.id": randomUUID(),
      // Both spellings: `deployment.environment` is the long-standing key most
      // backends' dashboards key off, `deployment.environment.name` is where
      // semconv landed. Emitting one and not the other silently breaks whichever
      // the ingestor happens to expect, and this costs 40 bytes.
      "deployment.environment": identity.environment,
      "deployment.environment.name": identity.environment,
      "strad.mode": identity.mode,
      "strad.component": identity.component,
    }),
  );
}
