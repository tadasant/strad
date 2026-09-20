/**
 * The six tools that drive the phone.
 *
 * ONE MODULE, SIX TOOLS, and the grouping is deliberate: they share the driver
 * pool, the session resolution, the locator grammar and the coordinate rule,
 * and splitting them into six files would put one shared concept in six places.
 * Everything else in this server is one tool per concern.
 *
 * THE LOCATOR GRAMMAR IS `label`, AND IT IS WHAT AN AGENT ALREADY HAS.
 * `read_screen` returns elements with a `label` and a `name`; every tool here
 * that takes a `label` matches EITHER, exactly, through an iOS predicate. No
 * XPath, no class chain, no CSS — a locator dialect is a thing to get wrong,
 * and the one string the agent just read back is not.
 */

import { InputError } from "../errors.js";
import { parseScreen } from "../screen.js";
import {
  args,
  boundedInt,
  COORDINATE_NOTE,
  guard,
  ok,
  optionalBool,
  optionalString,
  requiredNumber,
  requiredString,
  SESSION_ARN_DESCRIPTION,
  type DepsFactory,
  type ToolDefinition,
  type ToolResult,
} from "./shared.js";
import type { WebDriverSession } from "../webdriver.js";

const MAX_ELEMENTS = 200;
const DEFAULT_ELEMENTS = 60;

const SESSION_ARN_PARAM = {
  type: "string" as const,
  description: SESSION_ARN_DESCRIPTION,
};

/** An iOS predicate matching an element by either of the two strings a caller sees. */
function labelPredicate(label: string): string {
  // Quotes are escaped rather than rejected: a button labelled `Don't` is
  // ordinary, and a predicate broken by its apostrophe would read as "no such
  // element" — the most misleading failure this file can produce.
  const escaped = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `name == "${escaped}" OR label == "${escaped}"`;
}

async function findByLabel(
  driver: WebDriverSession,
  label: string,
): Promise<string> {
  const found = await driver.findElements("-ios predicate string", labelPredicate(label));
  if (found.length === 0) {
    throw new InputError(
      `No element is labelled "${label}" on the screen right now. Call ` +
        `read_screen to see what is there — the label has to match a ` +
        `\`label\` or \`name\` exactly, and a screen that is still animating ` +
        `often has neither yet.`,
    );
  }
  return found[0]!;
}

/**
 * The assertion channel.
 *
 * A screenshot proves a screen was drawn. This is what lets a caller say
 * `label == "0:42"` — and reading it twice, a second apart, is how "the timer
 * doesn't move" stops being an opinion.
 */
export function readScreenTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "read_screen",
    description:
      "What is on the phone right now, as a list of accessibility elements " +
      "with their labels, values, enabled state and position. THIS IS THE " +
      "TOOL TO ASSERT ON — a screenshot shows a screen, this one lets you " +
      "check that a label reads \"0:42\" or that a button is enabled.\n\n" +
      'Example: {"elements":[{"type":"Button","label":"Play","name":"play-button",' +
      '"enabled":true,"visible":true,"rect":{"x":167,"y":612,"width":80,' +
      '"height":80},"center":{"x":207,"y":652}},{"type":"StaticText",' +
      '"label":"0:42","enabled":true,"center":{"x":196,"y":540}}],' +
      '"matched":2,"total":184}\n\n' +
      "By default it returns only what is visible and meaningful — a phone's " +
      "hierarchy is mostly layout containers, and `total` says how many there " +
      "were. `query` narrows further; `include_all` returns the scaffolding " +
      "too.\n\n" +
      "`center` is where to tap to hit the element. " + COORDINATE_NOTE + "\n\n" +
      "TO CHECK SOMETHING IS PROGRESSING, call this twice a few seconds apart " +
      "and compare a label or a value — a timer, a progress figure, a state " +
      "word. That is the only way to verify motion, and it works for playback " +
      "state where audio itself cannot be heard.\n\n" +
      "Use cases: confirming a screen rendered; reading an error message the " +
      "app shows; checking a button is enabled before tapping it; asserting a " +
      "timer advances.",
    inputSchema: {
      type: "object",
      properties: {
        session_arn: SESSION_ARN_PARAM,
        query: {
          type: "string",
          description:
            'Case-insensitive substring matched against label, name, value ' +
            'and type, e.g. "play" or "0:".',
        },
        include_all: {
          type: "boolean",
          description:
            "Include layout containers and off-screen nodes. Default: false. " +
            "Expensive — a phone's full hierarchy is hundreds of elements.",
        },
        limit: {
          type: "integer",
          description: `How many elements to return (1-${MAX_ELEMENTS}). Default: ${DEFAULT_ELEMENTS}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { pool } = await deps();
        const arn = await pool.resolve(optionalString(input, "session_arn"));
        const query = optionalString(input, "query");
        const xml = await pool.with(arn, (driver) => driver.source());
        const parsed = parseScreen(xml, {
          ...(query === undefined ? {} : { query }),
          include_all: optionalBool(input, "include_all") ?? false,
          limit: boundedInt(input, "limit", DEFAULT_ELEMENTS, MAX_ELEMENTS),
        });
        return ok({ session_arn: arn, ...parsed });
      }),
  };
}

/** The width and height in an already-decoded PNG header, if it is one. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The picture, for the cases a hierarchy cannot answer.
 *
 * Returned as an MCP image so the agent SEES it. It is the right tool for
 * layout, for anything drawn rather than labelled, and for handing a human
 * evidence — and the wrong one for an assertion, which `read_screen` makes
 * checkable.
 */
export function takeScreenshotTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "take_screenshot",
    description:
      "A PNG of the phone's screen right now, returned as an image you can " +
      "look at. Use it for what is DRAWN rather than labelled — layout, a " +
      "chart, a video frame, a blank screen — and use read_screen when the " +
      "answer is a value you want to assert on.\n\n" +
      "Example: the image, plus one line of metadata — " +
      '{"width_px":1179,"height_px":2556,"bytes":412887}.\n\n' +
      "⚠️ " + COORDINATE_NOTE + "\n\n" +
      "Use cases: seeing what an app actually looks like when read_screen " +
      "reports nothing useful; capturing evidence for a human; confirming a " +
      "screen is blank rather than slow.",
    inputSchema: {
      type: "object",
      properties: { session_arn: SESSION_ARN_PARAM },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async (): Promise<ToolResult> => {
        const input = args(raw);
        const { pool } = await deps();
        const arn = await pool.resolve(optionalString(input, "session_arn"));
        const base64 = await pool.with(arn, (driver) => driver.screenshot());
        const bytes = Buffer.from(base64, "base64");
        const size = pngSize(bytes);
        return {
          content: [
            { type: "image", data: base64, mimeType: "image/png" },
            {
              type: "text",
              text: JSON.stringify({
                session_arn: arn,
                ...(size ? { width_px: size.width, height_px: size.height } : {}),
                bytes: bytes.byteLength,
                note: COORDINATE_NOTE,
              }),
            },
          ],
        };
      }),
  };
}

/** A tap, by label or by coordinate. */
export function tapScreenTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "tap_screen",
    description:
      "Tap the phone — either an element by its label, or a coordinate. " +
      "PREFER THE LABEL: it is the string read_screen just returned, it " +
      "survives a layout change, and it fails loudly when the element is not " +
      "there instead of tapping empty space.\n\n" +
      'Example: {"tapped":"label","label":"Play","session_arn":"arn:aws:devicefarm:...' +
      ':session:.../ef56"}\n\n' +
      "⚠️ " + COORDINATE_NOTE + " Use an element's `center` from read_screen.\n\n" +
      "A tap returns as soon as the phone accepts it, NOT when the app has " +
      "finished reacting. Call read_screen afterwards to see what happened — " +
      "and if the screen has not changed yet, call it again rather than " +
      "tapping twice.\n\n" +
      "Use cases: pressing Play; opening a tab; dismissing a dialog; " +
      "following a flow a bug report describes.",
    inputSchema: {
      type: "object",
      properties: {
        session_arn: SESSION_ARN_PARAM,
        label: {
          type: "string",
          description:
            'The element to tap, matching a `label` or `name` from ' +
            'read_screen EXACTLY, e.g. "Play". Preferred over coordinates.',
        },
        x: { type: "number", description: "Tap point, in points. Requires `y`." },
        y: { type: "number", description: "Tap point, in points. Requires `x`." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { pool } = await deps();
        const arn = await pool.resolve(optionalString(input, "session_arn"));
        const label = optionalString(input, "label");
        const hasPoint = input.x !== undefined || input.y !== undefined;
        if (!label && !hasPoint) {
          throw new InputError(
            "Pass either `label` (preferred — the string read_screen " +
              "returned) or both `x` and `y`.",
          );
        }
        if (label && hasPoint) {
          throw new InputError(
            "Pass `label` or `x`/`y`, not both: two targets in one tap is a " +
              "question about which one was meant.",
          );
        }
        if (label) {
          await pool.with(arn, async (driver) => {
            await driver.click(await findByLabel(driver, label));
          });
          return ok({ tapped: "label", label, session_arn: arn });
        }
        const x = requiredNumber(input, "x");
        const y = requiredNumber(input, "y");
        await pool.with(arn, (driver) => driver.tap({ x, y }));
        return ok({ tapped: "point", x, y, session_arn: arn });
      }),
  };
}

/** Typing, into a field named or into whatever the keyboard is attached to. */
export function typeTextTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "type_text",
    description:
      "Type into a text field on the phone. Name the field with `label`, or " +
      "tap it first with `x`/`y` and this types into whatever then has " +
      "keyboard focus.\n\n" +
      'Example: {"typed":true,"characters":19,"target":"label",' +
      '"label":"Email","cleared":true}\n\n' +
      "`clear_first` (default true) empties the field before typing, which is " +
      "almost always what is wanted — a field that already holds a draft " +
      "otherwise ends up with both strings concatenated and the failure looks " +
      "like the app mangled the input.\n\n" +
      "The text is NEVER logged by this server. It is still typed into a " +
      "phone in a rack whose session Device Farm records on video, so do not " +
      "type a real password or a real account number: use a test account.\n\n" +
      "Use cases: filling a login form on a staging build; entering a search " +
      "term; putting a known fixture value into a field a test asserts on.",
    inputSchema: {
      type: "object",
      properties: {
        session_arn: SESSION_ARN_PARAM,
        text: { type: "string", description: "The text to type." },
        label: {
          type: "string",
          description:
            'The field, matching a `label` or `name` from read_screen ' +
            'EXACTLY, e.g. "Email".',
        },
        x: {
          type: "number",
          description:
            "Tap here first, then type into whatever takes keyboard focus. " +
            "Requires `y`. Points, not pixels.",
        },
        y: { type: "number", description: "See `x`." },
        clear_first: {
          type: "boolean",
          description: "Empty the field before typing. Default: true.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { pool } = await deps();
        const arn = await pool.resolve(optionalString(input, "session_arn"));
        const text = requiredString(input, "text");
        const label = optionalString(input, "label");
        const hasPoint = input.x !== undefined || input.y !== undefined;
        if (!label && !hasPoint) {
          throw new InputError(
            "Pass either `label` (the field's label from read_screen) or " +
              "both `x` and `y` to tap the field first.",
          );
        }
        const clearFirst = optionalBool(input, "clear_first") ?? true;

        const cleared = await pool.with(arn, async (driver) => {
          let elementId: string;
          if (label) {
            elementId = await findByLabel(driver, label);
            await driver.click(elementId);
          } else {
            await driver.tap({
              x: requiredNumber(input, "x"),
              y: requiredNumber(input, "y"),
            });
            // Whatever the tap gave the keyboard to. `hasKeyboardFocus` is an
            // XCUITest predicate attribute, and it is the only way to name a
            // field that carries no label of its own.
            const focused = await driver.findElements(
              "-ios predicate string",
              "hasKeyboardFocus == 1",
            );
            if (focused.length === 0) {
              throw new InputError(
                "Tapping there did not put the keyboard anywhere, so there is " +
                  "nothing to type into. Check with read_screen that the tap " +
                  "landed on a text field — the coordinates are POINTS from " +
                  "read_screen, not screenshot pixels.",
              );
            }
            elementId = focused[0]!;
          }
          if (clearFirst) {
            // Best effort, and the W3C `clear` rather than a `mobile:` verb: a
            // field that refuses to be cleared — a search bar with its own
            // clear button, most often — should still be typed into.
            await driver.clear(elementId).catch(() => undefined);
          }
          await driver.sendKeys(elementId, text);
          return clearFirst;
        });

        return ok({
          typed: true,
          characters: text.length,
          target: label ? "label" : "point",
          ...(label ? { label } : {}),
          cleared,
          session_arn: arn,
        });
      }),
  };
}

/** A drag from one point to another. */
export function swipeScreenTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "swipe_screen",
    description:
      "Swipe or drag on the phone, from one point to another. Scrolling a " +
      "list, moving a slider, dismissing a sheet.\n\n" +
      'Example: {"swiped":true,"from":{"x":196,"y":1400},"to":{"x":196,"y":600},' +
      '"duration_ms":400}\n\n' +
      "⚠️ " + COORDINATE_NOTE + "\n\n" +
      "To SCROLL a list, swipe from low on the screen to high — the content " +
      "follows the finger, so an upward swipe moves down the list. " +
      "`duration_ms` under about 200 reads as a flick with momentum; 400 and " +
      "up is a controlled drag, which is what a slider wants.\n\n" +
      "Use cases: scrolling to an element read_screen cannot see; dragging a " +
      "playback scrubber to a position; pulling to refresh; dismissing a " +
      "modal sheet.",
    inputSchema: {
      type: "object",
      properties: {
        session_arn: SESSION_ARN_PARAM,
        from_x: { type: "number", description: "Where the finger lands, in points." },
        from_y: { type: "number", description: "Where the finger lands, in points." },
        to_x: { type: "number", description: "Where it lifts, in points." },
        to_y: { type: "number", description: "Where it lifts, in points." },
        duration_ms: {
          type: "integer",
          description:
            "How long the drag takes (50-5000). Default: 400 — a controlled " +
            "drag. Under ~200 is a flick.",
        },
      },
      required: ["from_x", "from_y", "to_x", "to_y"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { pool } = await deps();
        const arn = await pool.resolve(optionalString(input, "session_arn"));
        const from = {
          x: requiredNumber(input, "from_x"),
          y: requiredNumber(input, "from_y"),
        };
        const to = { x: requiredNumber(input, "to_x"), y: requiredNumber(input, "to_y") };
        const duration = boundedInt(input, "duration_ms", 400, 5000, 50);
        await pool.with(arn, (driver) => driver.swipe(from, to, duration));
        return ok({ swiped: true, from, to, duration_ms: duration, session_arn: arn });
      }),
  };
}

/**
 * The escape hatch, and the shape of its bound.
 *
 * Appium's `mobile:` namespace is where the platform-specific verbs live —
 * pressing the home button, backgrounding the app, relaunching it, reading its
 * state, handling an alert. There are dozens, they change with the driver, and
 * wrapping each as a tool would be a tool list nobody can read.
 *
 * SO THE BOUND IS THE NAMESPACE, NOT A LIST. Only `mobile:` commands are
 * accepted: this is not a general WebDriver pipe, and a caller cannot reach
 * `/session/:id/url` or anything else outside the phone's own verbs through it.
 */
export function runMobileCommandTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "run_mobile_command",
    description:
      "Run one Appium `mobile:` command on the phone — the platform verbs " +
      "that have no tool of their own. Only the `mobile:` namespace is " +
      "accepted; this is not a general WebDriver pipe.\n\n" +
      "The ones worth knowing on iOS:\n" +
      '- `pressButton` with {"name":"home"} — send the app to the background\n' +
      '- `launchApp` / `terminateApp` / `activateApp` with {"bundleId":"..."} ' +
      "— relaunch or kill the app under test\n" +
      '- `queryAppState` with {"bundleId":"..."} — 1 not installed, 2 not ' +
      "running, 3 background suspended, 4 background running, 4+ foreground\n" +
      '- `scroll` with {"direction":"down"} — a scroll the OS drives\n' +
      '- `alert` with {"action":"accept"} — a system dialog\n' +
      '- `getDeviceTime`, `deviceInfo`, `batteryInfo`\n\n' +
      'Example: run_mobile_command(command:"queryAppState", ' +
      'args:{"bundleId":"com.tadasant.motet"}) -> {"result":4}\n\n' +
      "BACKGROUNDING AND RELAUNCHING IS THE INTERESTING ONE for audio and " +
      "playback bugs: `pressButton` home, wait, `activateApp`, then " +
      "read_screen — that is the sequence a \"playback stops when I switch " +
      "apps\" report describes.\n\n" +
      "Use cases: checking the app is actually in the foreground; " +
      "backgrounding and restoring; dismissing a system permission dialog; " +
      "reading device time to line a log up against.",
    inputSchema: {
      type: "object",
      properties: {
        session_arn: SESSION_ARN_PARAM,
        command: {
          type: "string",
          description:
            'The command, with or without the prefix — "pressButton" and ' +
            '"mobile: pressButton" are the same. Anything outside the ' +
            "`mobile:` namespace is refused.",
        },
        args: {
          type: "object",
          description:
            'The command\'s arguments, e.g. {"name":"home"} or ' +
            '{"bundleId":"com.tadasant.motet"}. Omit for a command that takes ' +
            "none.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { pool } = await deps();
        const arn = await pool.resolve(optionalString(input, "session_arn"));
        const requested = requiredString(input, "command");
        const bare = requested.replace(/^mobile:\s*/i, "");
        if (bare.includes(":") || bare.includes("/") || bare.includes(" ")) {
          throw new InputError(
            `\`command\`="${requested}" is not a \`mobile:\` command. This ` +
              `tool runs exactly one namespace — pass a name like ` +
              `"pressButton" or "mobile: pressButton" — and nothing else is ` +
              `reachable through it.`,
          );
        }
        const commandArgs = input.args;
        if (
          commandArgs !== undefined &&
          (typeof commandArgs !== "object" || commandArgs === null || Array.isArray(commandArgs))
        ) {
          throw new InputError("`args` must be an object.");
        }
        const result = await pool.with(arn, (driver) =>
          driver.execute(`mobile: ${bare}`, [commandArgs ?? {}]),
        );
        return ok({ command: `mobile: ${bare}`, result, session_arn: arn });
      }),
  };
}
