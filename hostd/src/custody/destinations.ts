import type { Config } from "../config.js";

/**
 * Where a deposit may go: the default strad (`custody.stradUrl`, whose bearer
 * is derived from the custody slug's own key) and each named entry in
 * `custody.destinations` (whose bearer is derived from that entry's key).
 *
 * The `deposit` tool takes a NAME and this is the only place a name becomes a
 * URL, so the set of hosts a held secret can be sent to is exactly the set
 * this machine's config file lists — a prompt cannot add one.
 */
export interface Destination {
  name: string;
  /** Who runs it, for a description or a refusal. */
  title: string;
  url: string;
  /** The key the deposit bearer is derived from (`depositToken(key)`). */
  key: string;
  default: boolean;
}

export type DestinationLookup =
  { ok: true; destination: Destination } | { ok: false; message: string };

/**
 * Every destination name a caller may give, the default's first. The rest in
 * code-unit order, which is the order the tool description lists them in.
 */
export function destinationNames(config: Config): string[] {
  return [
    config.custody.stradName,
    ...Object.keys(config.custody.destinations).sort(),
  ];
}

/**
 * The destination `name` names, or why there is none. `name` omitted is the
 * default destination: `stradUrl`, with the custody slug key's bearer.
 */
export function resolveDestination(
  config: Config,
  name?: string,
): DestinationLookup {
  const { stradUrl, stradName, destinations } = config.custody;
  if (name === undefined || name === stradName) {
    const key = config.capabilities.custody.key;
    if (!stradUrl || !key)
      return {
        ok: false,
        message: `This machine is not set up to deposit into its default strad ("${stradName}"): custody.stradUrl is unset in its config.`,
      };
    return {
      ok: true,
      destination: {
        name: stradName,
        title: new URL(stradUrl).host,
        url: stradUrl,
        key,
        default: true,
      },
    };
  }
  const named = Object.hasOwn(destinations, name)
    ? destinations[name]
    : undefined;
  if (!named)
    return {
      ok: false,
      message: `No deposit destination named ${JSON.stringify(name)} on this machine. It may deposit into: ${destinationNames(config).join(", ")}. A destination is added in the machine's own config, never by a caller.`,
    };
  return {
    ok: true,
    destination: {
      name,
      title: named.title ?? new URL(named.url).host,
      url: named.url,
      key: named.key,
      default: false,
    },
  };
}
