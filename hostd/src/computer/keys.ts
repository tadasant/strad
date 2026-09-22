/**
 * "cmd+shift+4" → what the helper posts. Parsed here, in the daemon, so a
 * malformed chord is refused with a message before anything reaches the
 * keyboard; the virtual key codes themselves live in the helper, which is the
 * only place that knows the layout.
 */
export const MODIFIERS = new Set([
  "cmd",
  "command",
  "meta",
  "super",
  "shift",
  "alt",
  "option",
  "opt",
  "ctrl",
  "control",
  "fn",
  "function",
]);

const ALIASES: Record<string, string> = {
  "⌘": "cmd",
  "⇧": "shift",
  "⌥": "alt",
  "⌃": "ctrl",
  win: "cmd",
  enter: "return",
  esc: "escape",
  del: "delete",
  bksp: "backspace",
  pgup: "page_up",
  pgdn: "page_down",
  pageup: "page_up",
  pagedown: "page_down",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  plus: "=",
  minus: "-",
};

export interface Chord {
  key: string;
  modifiers: string[];
}

export function parseChord(
  raw: string,
): { ok: true; chord: Chord } | { ok: false; reason: string } {
  const parts = raw
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0)
    return {
      ok: false,
      reason:
        'keys is empty; give a key or a chord like "cmd+s" (for the + key itself use "shift+=")',
    };
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const named = ALIASES[part.toLowerCase()] ?? part.toLowerCase();
    if (!MODIFIERS.has(named))
      return {
        ok: false,
        reason: `"${part}" is not a modifier; modifiers are cmd, shift, alt, ctrl and fn, and the key comes last`,
      };
    if (!modifiers.includes(named)) modifiers.push(named);
  }
  const last = parts[parts.length - 1]!;
  const key = ALIASES[last.toLowerCase()] ?? last.toLowerCase();
  if (MODIFIERS.has(key))
    return {
      ok: false,
      reason: `"${raw}" ends in a modifier; a chord needs a key after it, e.g. ${key}+c`,
    };
  return { ok: true, chord: { key, modifiers } };
}
