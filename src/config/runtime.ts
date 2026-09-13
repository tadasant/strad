import {
  EMPTY_OVERLAY,
  assertCreatable,
  assertEditable,
  assertNoAccessControlChange,
  assertWithinReach,
  ReachExceeded,
  fileSlugs,
  mergeOverlay,
  sourcesFor,
  validateMerged,
  type EntrySource,
  type ServerOverlay,
  type WritingPrincipal,
} from "./overlay.ts";
import { assertSecretsByReference, changedUpserts } from "./secret-position.ts";
import { bundleUrlEnvName } from "../gateway/registry.ts";
import type { StradConfig } from "./schema.ts";
import type { ConfigStore } from "./store.ts";
import { event } from "../telemetry/index.ts";

/**
 * The config this process is serving, and the one seam that can change it.
 *
 * ## Why there is a holder at all
 *
 * Until now the config was a `const` in `main()` handed to eight call sites, and
 * that was the right shape for a value that never changed. It changes now, so
 * somebody has to own the question "what is the config, right now" and the
 * answer has to be the same for every reader at every instant. This is that
 * owner. Nothing else re-reads the store, nothing else merges, and nothing else
 * decides that a candidate config is good enough to serve.
 *
 * ## Apply is all-or-nothing
 *
 * `apply()` validates the merged document BEFORE it stores anything and rebuilds
 * the gateway BEFORE it keeps the new overlay. A refusal at either step leaves
 * the process serving exactly what it was serving, with the old overlay still in
 * the store — so the failure mode of a bad edit is "the console says no", never
 * "the gateway is down and the config that took it down is now persistent".
 *
 * The ordering that makes that true is: validate, rebuild, store, adopt. The
 * store write is second-to-last on purpose. Storing first and failing to rebuild
 * would leave a document that the NEXT boot picks up and dies on — a config
 * change that works until you restart is the worst of the available failures.
 */
export interface RuntimeConfigOptions {
  /** The checked-in document, pre-schema. Never mutated. */
  baseDocument: unknown;
  /** The config the process booted with, already merged with any overlay. */
  config: StradConfig;
  /** The overlay that produced it. `EMPTY_OVERLAY` when there was none. */
  overlay: ServerOverlay;
  store: ConfigStore | null;
  /**
   * Rebuild everything that depends on the config.
   *
   * Throwing rejects the change — see the ordering note above. Called with a
   * config that has already passed the full schema, so a throw here is a
   * RUNTIME refusal (an adapter that cannot be built, a bundle that is not
   * reachable), not a validation one.
   */
  rebuild: (config: StradConfig) => Promise<void>;
  /**
   * The process environment, for the one rule that is about the DEPLOYMENT
   * rather than the document: whether a supplementary entry's component is
   * actually reachable from here (`STRAD_BUNDLE_URL_<BUNDLE>`).
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The checked-in document, PARSED — what the deploy authorised, before any
   * overlay. Boot already has it (`loadConfigDocument` in src/index.ts), so
   * handing it over keeps the reach bound off a second run of the schema.
   * Omitted, it is parsed on first use.
   */
  baseConfig?: StradConfig;
}

export class ConfigRejected extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigRejected";
  }
}

export class RuntimeConfig {
  private currentConfig: StradConfig;
  private currentOverlay: ServerOverlay;
  private readonly base: unknown;
  /**
   * The CHECKED-IN config, parsed once. Seeded by boot, which already has it.
   * `undefined` until first asked; `null` if the base document does not parse,
   * which fails a principal-carrying write closed rather than unbounded.
   */
  private baseConfigCache: StradConfig | null | undefined;
  private readonly rebuild: (config: StradConfig) => Promise<void>;
  /** Serialises apply/poll, so two console tabs cannot interleave a rebuild. */
  private queue: Promise<unknown> = Promise.resolve();

  readonly store: ConfigStore | null;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: RuntimeConfigOptions) {
    this.base = opts.baseDocument;
    this.baseConfigCache = opts.baseConfig;
    this.currentConfig = opts.config;
    this.currentOverlay = opts.overlay;
    this.store = opts.store;
    this.rebuild = opts.rebuild;
    this.env = opts.env ?? process.env;
  }

  /**
   * Refuse an entry this process could not actually serve — the ONE answer to
   * that question, for both doors.
   *
   * The console form and the `connectors` builtin both call it. Two copies of
   * this check would be two answers to "may I add this", and the one a human
   * saw and the one an agent saw would eventually differ on a Tuesday. The
   * rules themselves live in src/config/overlay.ts next to their reasoning;
   * this is what supplies the deployment-shaped half of the context.
   *
   * `before` present means an EDIT, and an edit is judged on what moved rather
   * than on what it is — `assertEditable`. Absent means a create.
   *
   * `principal` is who is making the write, threaded from whichever door called
   * (the console session, or the `connectors` MCP caller). It is what the reach
   * bound needs and the one thing `assertAcceptable` did not have — see
   * `assertWithinReach`. Both doors supply it — `src/ui/servers.ts` hands over
   * the signed-in console session, `src/servers/connectors.ts` the principal
   * that authenticated the `/mcp` request — so an absent one is a caller that
   * is neither door.
   */
  assertAcceptable(
    entry: Record<string, unknown>,
    before?: Record<string, unknown>,
    principal?: WritingPrincipal,
  ): void {
    // Before anything else, and on BOTH paths: a runtime write never moves the
    // access control of a server the checked-in document declares. Keyed on the
    // base document rather than on edit-vs-create, because remove-then-recreate
    // is structurally a create and would otherwise walk around it.
    assertNoAccessControlChange(this.base, entry);

    // And on both paths: a runtime write names a credential, it never carries
    // one. `apply` repeats this over everything a write would newly store —
    // see the note there — but doing it here is what attaches the refusal to
    // the entry the human is looking at, before anything else is judged.
    assertSecretsByReference(entry);

    // And a runtime write may not reach a credential its author cannot already
    // reach — the bound that lets the write tools be granted to a role narrower
    // than the one that reaches everything. Keyed on the checked-in config for
    // the same reason as access control: an overlay slug's own entitlements
    // cannot vouch for reach.
    if (principal) {
      const baseConfig = this.baseConfig();
      // FAIL CLOSED. A booted process's checked-in document parses — boot reads
      // it through `loadConfigDocument` and dies otherwise (src/index.ts) — so
      // this is unreachable rather than merely unlikely. Refusing anyway is the
      // difference between a bound with no off switch and one with a silent one.
      if (!baseConfig) {
        throw new ReachExceeded(
          "This write cannot be judged: the checked-in config does not parse, " +
            "so there is no record of what the deploy authorised you to reach. " +
            "Fix the checked-in config and deploy.",
        );
      }
      assertWithinReach(baseConfig, entry, principal, before);
    }

    if (before) {
      assertEditable(before, entry);
      return;
    }
    assertCreatable(entry, {
      config: this.currentConfig,
      env: this.env,
      bundleUrl: (bundle) => this.env[bundleUrlEnvName(bundle)],
    });
  }

  /** Whether this process can change the roster at all. */
  get editable(): boolean {
    return this.store !== null;
  }

  /** Whether a change made here would survive a restart. */
  get writable(): boolean {
    return this.store?.writable === true;
  }

  config(): StradConfig {
    return this.currentConfig;
  }

  overlay(): ServerOverlay {
    return this.currentOverlay;
  }

  baseDocument(): unknown {
    return this.base;
  }

  /**
   * The checked-in config, PARSED — what the deploy authorised, with none of the
   * overlay on top of it.
   *
   * `config()` is the merged roster and is the wrong document to measure reach
   * against: an overlay entry's own `entitlements:` were written by a runtime
   * write, so letting them vouch for what a writer reaches would be circular.
   * Parsed lazily and once, non-strictly (the same leniency boot uses — an
   * unknown key in the file must not fail a write any more than it fails a
   * boot), and cached because a write path should not re-run the schema.
   */
  private baseConfig(): StradConfig | null {
    if (this.baseConfigCache === undefined) {
      const result = validateMerged(this.base, { strict: false });
      this.baseConfigCache = result.ok ? result.config : null;
    }
    return this.baseConfigCache;
  }

  /** The slugs the checked-in document declares. */
  fileSlugs(): Set<string> {
    return fileSlugs(this.base);
  }

  /** Where each slug in the served roster came from. */
  sources(): Map<string, EntrySource> {
    return sourcesFor(this.base, this.currentOverlay);
  }

  /** The merged DOCUMENT this process is serving, pre-schema. */
  document(): unknown {
    return mergeOverlay(this.base, this.currentOverlay);
  }

  /**
   * Merge, validate strictly, and say what is wrong — without changing
   * anything. What the console calls to preview a candidate.
   */
  evaluate(overlay: ServerOverlay): ReturnType<typeof validateMerged> {
    return validateMerged(mergeOverlay(this.base, overlay), { strict: true });
  }

  /**
   * Adopt an overlay: validate it, rebuild on it, store it, serve it.
   *
   * Serialised against every other `apply` and `poll` in this process, so a
   * rebuild is never racing another rebuild. Across processes the store's own
   * lack of compare-and-swap is the remaining gap, and `revision` is what the
   * console checks to catch the case a human can actually cause.
   */
  apply(overlay: ServerOverlay, by?: string): Promise<void> {
    return this.serialise(async () => {
      // The store never gains a credential VALUE, whatever route the write
      // arrived by. `assertAcceptable` covers the entry a caller composed; this
      // covers the ones it did not — `toggle` and `set_connector_enabled`
      // re-upsert an entry read straight out of the merged document, so a
      // literal in a checked-in `headers:` would otherwise be copied into the
      // overlay by a button that only meant to disable something.
      //
      // Scoped to what this write CHANGES, so a literal already in the stored
      // overlay refuses the next write that touches its entry rather than
      // freezing the whole roster. src/config/secret-position.ts argues it.
      for (const entry of changedUpserts(
        this.currentOverlay.servers.upserts,
        overlay.servers.upserts,
      )) {
        assertSecretsByReference(entry);
      }

      const result = this.evaluate(overlay);
      if (!result.ok) throw new ConfigRejected(result.problems);

      if (!this.store) {
        throw new ConfigRejected([
          "This gateway has no config store, so a roster change cannot be kept.",
        ]);
      }

      // PUBLISHED BEFORE THE REBUILD, and this ordering is load-bearing.
      //
      // The rebuild reads `sources()` to learn which slugs the overlay authored,
      // because those resolve their `${NAME}` refs against their own namespace
      // and nothing else (src/gateway/registry.ts). Publishing afterwards would
      // mean the rebuild for the write that ADDS a slug still sees the previous
      // overlay — so the new entry would not be in the runtime-authored set,
      // and would be built with the full provider chain down to the process
      // environment. That is the exfiltration path, reopened by an ordering.
      //
      // Everything below restores both fields on any failure, so a refusal
      // still leaves the holder reporting exactly what it is serving.
      const previousConfig = this.currentConfig;
      const previousOverlay = this.currentOverlay;
      this.currentConfig = result.config;
      this.currentOverlay = overlay;

      const restore = () => {
        this.currentConfig = previousConfig;
        this.currentOverlay = previousOverlay;
      };

      try {
        await this.rebuild(result.config);
      } catch (err) {
        restore();
        throw err;
      }

      try {
        await this.store.write(overlay);
      } catch (err) {
        // The gateway is already serving the new roster and the store does not
        // have it. Leaving it there is the worst of the outcomes available: the
        // process serves something no restart would reproduce, and the poll
        // cannot correct it, because the store's revision never moved. Put the
        // gateway back on what is still persisted, then report the failure.
        //
        // Same rollback discipline as the parameter store's own create/rotate
        // (src/secrets/parameters/gcp.ts): a write that half-fails must be
        // visible rather than plausible. `restore()` runs FIRST so the rebuild
        // below reads the old sources, for the same reason the publish above
        // runs first.
        restore();
        await this.rebuild(previousConfig).catch(() => {
          // The rollback failed too, so the process is serving a roster that is
          // not in the store and not what this holder reports. Nothing here can
          // fix that; saying so is the most this path can do.
          event({
            evt: "strad.config_reload_failed",
            reason: "rebuild_failed",
            revision: overlay.revision,
          });
        });
        throw err;
      }

      // `by` is deliberately NOT on this record. It is a console identity — a
      // person's email — and the stored overlay already carries it for the
      // console to show. Telemetry gets the shape of the change, not who.
      void by;
      event({
        evt: "strad.config_applied",
        revision: overlay.revision,
        servers: result.config.servers.map((s) => s.slug),
        upserts: overlay.servers.upserts.length,
        removals: overlay.servers.removals.length,
      });
    });
  }

  /**
   * Re-read the store and adopt what it says, if it has moved.
   *
   * This is the path that carries a change written by ANOTHER core instance, or
   * by another console process, into this one. It never writes, so a poll that
   * finds a broken overlay does not have a "refuse the write" option — it keeps
   * serving what it has and says so. A roster that stops being valid because of
   * an image rollback must not take the gateway down, which is the same
   * argument `src/config/strict.ts` makes about boot.
   *
   * Returns whether anything changed.
   */
  poll(): Promise<boolean> {
    return this.serialise(async () => {
      if (!this.store) return false;

      let next: ServerOverlay;
      try {
        next = await this.store.read();
      } catch {
        // A store that will not answer, or a payload that will not parse. The
        // process keeps serving what it has; the message stays on stderr,
        // because a store client's exception can quote a rendered value.
        event({ evt: "strad.config_reload_failed", reason: "unreadable" });
        return false;
      }

      if (next.revision === this.currentOverlay.revision) return false;

      const result = validateMerged(mergeOverlay(this.base, next), {
        strict: false,
      });
      if (!result.ok) {
        event({
          evt: "strad.config_reload_failed",
          reason: "invalid",
          revision: next.revision,
        });
        return false;
      }

      // Published before the rebuild, for the reason `apply` spells out: the
      // rebuild reads `sources()`, and a slug this poll is adopting has to be
      // in the runtime-authored set while its adapter is built.
      const previousConfig = this.currentConfig;
      const previousOverlay = this.currentOverlay;
      this.currentConfig = result.config;
      this.currentOverlay = next;

      try {
        await this.rebuild(result.config);
      } catch {
        this.currentConfig = previousConfig;
        this.currentOverlay = previousOverlay;
        event({
          evt: "strad.config_reload_failed",
          reason: "rebuild_failed",
          revision: next.revision,
        });
        return false;
      }
      event({
        evt: "strad.config_reloaded",
        revision: next.revision,
        servers: result.config.servers.map((s) => s.slug),
      });
      return true;
    });
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    // Swallow on the CHAIN only. `run` still rejects for the caller; this keeps
    // one failed apply from poisoning every apply that queues behind it.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * The boot-time read of the overlay.
 *
 * Deliberately forgiving in both directions a boot can be surprised. A store
 * that will not answer, a payload that will not parse, and a merge that no
 * longer validates all produce the SAME outcome: boot on the checked-in
 * document, say so loudly, and carry on. A gateway that refuses to start
 * because of something a console wrote is a gateway one bad edit can take down
 * permanently, and the whole point of keeping the file authoritative is that it
 * is always there to fall back to.
 *
 * The poll picks up a store that recovers, so this is a delay rather than a
 * dead end.
 */
export async function readOverlayAtBoot(
  store: ConfigStore | null,
  baseDocument: unknown,
): Promise<{ overlay: ServerOverlay; config: StradConfig | null }> {
  if (!store) return { overlay: EMPTY_OVERLAY, config: null };

  let overlay: ServerOverlay;
  try {
    overlay = await store.read();
  } catch {
    event({ evt: "strad.config_reload_failed", reason: "unreadable" });
    return { overlay: EMPTY_OVERLAY, config: null };
  }

  // Both lists, not just upserts: an overlay that only REMOVES is still an
  // overlay, and skipping it here would serve the checked-in roster whole.
  if (
    overlay.servers.upserts.length === 0 &&
    overlay.servers.removals.length === 0
  ) {
    return { overlay, config: null };
  }

  const result = validateMerged(mergeOverlay(baseDocument, overlay), {
    strict: false,
  });
  if (!result.ok) {
    event({
      evt: "strad.config_reload_failed",
      reason: "invalid",
      revision: overlay.revision,
    });
    return { overlay: EMPTY_OVERLAY, config: null };
  }

  return { overlay, config: result.config };
}

/**
 * The interval that carries another process's write into this one.
 *
 * Unref'd, because a poll pending at shutdown must not hold the process open —
 * App Platform sends SIGTERM and does not wait long.
 */
export class ConfigPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly runtime: RuntimeConfig,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runtime.poll();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
