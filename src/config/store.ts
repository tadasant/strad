import {
  EMPTY_OVERLAY,
  MAX_OVERLAY_BYTES,
  overlayPath,
  parseOverlay,
  serialiseOverlay,
  type ServerOverlay,
} from "./overlay.ts";
import type { StradConfig } from "./schema.ts";
import {
  createGcpParameterStore,
  ParameterStoreError,
  type ParameterStore,
} from "../secrets/parameters/index.ts";
import { parseAdminAccount } from "../secrets/parameters/gcp.ts";
import { RESOLVER_ENV } from "../secrets/parameters/resolver.ts";
import { SECRETS_ENV } from "../ui/resolve.ts";

/**
 * Where the runtime server overlay is kept, and what it costs to get at it.
 *
 * ## One parameter, not a table
 *
 * The overlay is a single non-secret parameter — `/strad/{env}/gateway/config/
 * SERVERS` — holding the whole document. A row per server would be the obvious
 * shape and is the wrong one here: the roster's invariants are CROSS-ENTRY
 * (slugs are unique, a bundle is declared, two servers may not mint from one
 * refresh token), so a write has to be atomic across the whole thing or the
 * config can be observed in a state the schema forbids. One parameter, one
 * version, one write.
 *
 * ## Two credentials, one store
 *
 * Nothing new is provisioned for this. Reads go through whichever credential
 * the process already has — the RESOLVER key every store-backed container
 * carries. Writes need the console ADMIN key, which core already holds for the
 * secrets pages and which no other component is given. A deployment that has
 * the resolver key but not the admin key gets a read-only overlay and a console
 * that says so, which is the correct answer for a component that should not be
 * editing config anyway.
 *
 * That is also the whole of "what does a deployment do to adopt this": set
 * `gateway.configStore.enabled: true` and deploy once. No new secret, no new
 * IAM grant, no step performed by hand on a box.
 *
 * ## What a read costs
 *
 * `reveal()` on a non-secret parameter is two API calls — list the versions
 * (there is no `latest` alias in Parameter Manager) and get the ranked one. It
 * deliberately does NOT go through the process snapshot the secret provider
 * slices: that snapshot can be a day old by default, and a day-stale roster is
 * not a roster. Two calls per poll per core instance, at the interval
 * `gateway.configStore.pollSeconds` bounds.
 */
export interface ConfigStore {
  /** What this store is, for a log line and a console badge. */
  readonly backend: string;
  /** Whether `write` can succeed. False when the process holds no admin key. */
  readonly writable: boolean;
  /**
   * The stored overlay, or `EMPTY_OVERLAY` when nothing has ever been written.
   *
   * "Nothing written" and "empty" are deliberately the same answer. The overlay
   * is a diff, and the absence of a diff and a diff of nothing describe the
   * same roster.
   */
  read(): Promise<ServerOverlay>;
  /** Replace the overlay. Throws when the store is not writable. */
  write(overlay: ServerOverlay): Promise<void>;
}

export class ConfigStoreReadOnly extends Error {}
export class ConfigStoreTooLarge extends Error {}

/** In-memory, for tests and for `npm run dev`. Never durable, and says so. */
export class MemoryConfigStore implements ConfigStore {
  readonly backend = "memory";
  readonly writable = true;
  private overlay: ServerOverlay = EMPTY_OVERLAY;

  constructor(initial?: ServerOverlay) {
    if (initial) this.overlay = initial;
  }

  read(): Promise<ServerOverlay> {
    return Promise.resolve(this.overlay);
  }

  // `async` rather than `Promise.resolve()`, so an over-size document REJECTS
  // instead of throwing synchronously out of a function that declares a
  // Promise. A caller written against the interface awaits it; one that only
  // ever saw this implementation would not.
  async write(overlay: ServerOverlay): Promise<void> {
    await Promise.resolve();
    assertSize(overlay);
    this.overlay = overlay;
  }
}

function assertSize(overlay: ServerOverlay): void {
  const bytes = Buffer.byteLength(serialiseOverlay(overlay), "utf8");
  if (bytes > MAX_OVERLAY_BYTES) {
    throw new ConfigStoreTooLarge(
      `The server overlay is ${bytes} bytes, over the ${MAX_OVERLAY_BYTES}-byte ` +
        `ceiling. A roster this large belongs in the checked-in config.`,
    );
  }
}

/**
 * The parameter-store backend.
 *
 * `reader` is required; `writer` is the admin-credentialed store, and its
 * absence is what makes the overlay read-only rather than an error. They are
 * usually two clients over two credentials, and are allowed to be the same one.
 */
export class ParameterConfigStore implements ConfigStore {
  readonly backend = "gcp-parameter-store";

  constructor(
    private readonly reader: Pick<ParameterStore, "reveal">,
    private readonly writer: Pick<ParameterStore, "create" | "rotate"> | null,
    private readonly path: string,
  ) {}

  get writable(): boolean {
    return this.writer !== null;
  }

  async read(): Promise<ServerOverlay> {
    let payload: string;
    try {
      payload = await this.reader.reveal(this.path);
    } catch (err) {
      // 404 is the ordinary state of a deployment that has never used the
      // console editor, so it is not an error — it is an empty overlay. Every
      // other failure is a store that could not answer, and the caller decides
      // whether to keep serving what it already has.
      if (err instanceof ParameterStoreError && err.status === 404) {
        return EMPTY_OVERLAY;
      }
      throw err;
    }
    return parseOverlay(payload);
  }

  async write(overlay: ServerOverlay): Promise<void> {
    if (!this.writer) {
      throw new ConfigStoreReadOnly(
        `This gateway has no writable parameter credential ` +
          `(${SECRETS_ENV.adminKeyJson} is not set on it), so the server ` +
          `overlay is read-only here.`,
      );
    }
    assertSize(overlay);
    const value = serialiseOverlay(overlay);
    try {
      await this.writer.rotate(this.path, value);
    } catch (err) {
      if (err instanceof ParameterStoreError && err.status === 404) {
        await this.writer.create({
          path: this.path,
          secret: false,
          value,
          note: "strad runtime server overlay — written by the console",
        });
        return;
      }
      throw err;
    }
  }
}

export interface ConfigStoreDeps {
  config: StradConfig;
  env: NodeJS.ProcessEnv;
  /** The store client this process already built, reused as the reader. */
  resolver: ParameterStore | null;
}

/**
 * The overlay store for this process, or null when the config does not ask for
 * one.
 *
 * Null is not a failure and never logs like one: `gateway.configStore.enabled`
 * is off by default, and a deployment that has not turned it on wants exactly
 * today's behaviour. What IS a failure is asking for an overlay with no store
 * client to read it through — the schema already refuses that combination for
 * the `env` provider, and this catches the case where the provider is right and
 * the credential is missing.
 */
export function configStoreFrom(deps: ConfigStoreDeps): ConfigStore | null {
  if (!deps.config.gateway.configStore.enabled) return null;

  const reader = deps.resolver;
  if (!reader) {
    throw new Error(
      `gateway.configStore.enabled is set but this process has no parameter ` +
        `store client: ${RESOLVER_ENV.projectId} and ` +
        `${RESOLVER_ENV.keyJson} must both be set.`,
    );
  }

  return new ParameterConfigStore(
    reader,
    adminStore(deps.env),
    overlayPath(deps.config.gateway.env),
  );
}

/**
 * The admin-credentialed client, built from the SAME env var the console's
 * secrets pages already use, or null when this process was not given it.
 *
 * Reusing that name is the point. A second admin credential would be a second
 * key to seed, a second IAM grant to keep current, and a second thing to get
 * wrong — for a principal that needs exactly the permissions the first one
 * already holds. `consoleEnv:` puts it on core and nowhere else, which is also
 * precisely the set of components that should be writing config.
 */
function adminStore(env: NodeJS.ProcessEnv): ParameterStore | null {
  const projectId = env[RESOLVER_ENV.projectId];
  if (!projectId) return null;

  const { account } = parseAdminAccount(env[SECRETS_ENV.adminKeyJson]);
  if (!account) return null;

  return createGcpParameterStore({
    projectId,
    location: env[RESOLVER_ENV.location],
    account,
    pmApiBase: env[SECRETS_ENV.pmApiBase] ?? env[RESOLVER_ENV.pmApiBase],
    smApiBase: env[SECRETS_ENV.smApiBase] ?? env[RESOLVER_ENV.smApiBase],
    tokenUrl: env[SECRETS_ENV.tokenUrl] ?? env[RESOLVER_ENV.tokenUrl],
  });
}
