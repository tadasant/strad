import { z } from 'zod';

/**
 * Show as Free / Busy — the Calendar API's event `transparency` field. A strad
 * delta on the vendored tree (`../../README.md`).
 *
 * `"opaque"` blocks time on the calendar (Busy); `"transparent"` does not
 * (Free). Google's default is `"opaque"`, and it omits the field from an event
 * resource that carries the default, so an absent `transparency` reads as Busy.
 */

export const TRANSPARENCY_VALUES = ['opaque', 'transparent'] as const;
export const SHOW_AS_VALUES = ['free', 'busy'] as const;

export type Transparency = (typeof TRANSPARENCY_VALUES)[number];
export type ShowAs = (typeof SHOW_AS_VALUES)[number];

export const transparencyField = z
  .enum(TRANSPARENCY_VALUES)
  .optional()
  .describe(
    'Whether the event blocks time on the calendar (Google Calendar\'s "Show as"). ' +
      '"opaque" shows the event as Busy; "transparent" shows it as Free, so it does not block time in free/busy lookups. ' +
      'Same setting as show_as; pass one or the other. ' +
      'Omitted: a new event is Busy (Google\'s default) and an update leaves the setting unchanged.'
  );

export const showAsField = z
  .enum(SHOW_AS_VALUES)
  .optional()
  .describe(
    'Show the event as "free" or "busy" (Google Calendar\'s "Show as"). ' +
      '"free" is transparency "transparent"; "busy" is transparency "opaque". ' +
      'Pass this or transparency, not both with different values.'
  );

const SHOW_AS_TO_TRANSPARENCY: Record<ShowAs, Transparency> = {
  free: 'transparent',
  busy: 'opaque',
};

/**
 * The one `transparency` value to send, or `undefined` to send none. Throws when
 * `transparency` and `show_as` disagree, so a contradictory call writes nothing.
 */
export function resolveTransparency(args: {
  transparency?: Transparency;
  show_as?: ShowAs;
}): Transparency | undefined {
  const fromShowAs = args.show_as ? SHOW_AS_TO_TRANSPARENCY[args.show_as] : undefined;
  if (args.transparency && fromShowAs && args.transparency !== fromShowAs) {
    throw new Error(
      `transparency "${args.transparency}" and show_as "${args.show_as}" disagree; pass one of them`
    );
  }
  return args.transparency ?? fromShowAs;
}

/**
 * The `**Show as:**` line for an event: `Free` or `Busy` with the raw API value
 * beside it, an absent field read as Google's default, Busy. A cancelled event
 * blocks no time and Google returns it with almost no fields, so it gets no
 * line at all rather than an inferred Busy.
 */
export function showAsLine(event: { transparency?: string; status?: string }): string {
  if (event.status === 'cancelled') {
    return '';
  }
  return `**Show as:** ${formatShowAs(event.transparency)}\n`;
}

function formatShowAs(transparency: string | undefined): string {
  if (transparency === 'transparent') {
    return 'Free (transparent)';
  }
  if (transparency === undefined || transparency === 'opaque') {
    return 'Busy (opaque)';
  }
  return `Unknown (${transparency})`;
}
