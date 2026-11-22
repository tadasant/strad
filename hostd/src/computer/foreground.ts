import { z } from "zod";

import type { Config } from "../config.js";
import type { Grant } from "../consent/grants.js";
import { defineTool, json, text, type Capability } from "../mcp/tool.js";
import type { HelperClient } from "../native/client.js";
import { parseChord } from "./keys.js";
import { helperPreflight, helperStatus } from "./shared.js";

const P = {
  x: "Horizontal position in screen POINTS, from the left edge of the main display — the coordinate space take_screenshot reports. Divide a screenshot pixel by its scale and add its origin.",
  y: "Vertical position in screen points, from the top edge of the main display.",
  modifiers:
    'Modifier keys held during the action, e.g. ["cmd"] or ["shift","alt"]. Names: cmd, shift, alt, ctrl, fn.',
} as const;

interface Shot {
  image_base64: string;
  mime_type: string;
  width: number;
  height: number;
  scale: number;
  origin: { x: number; y: number };
  display: number;
  display_size: { width: number; height: number };
  cursor: { x: number; y: number };
}

export function computerCapability(
  config: Config,
  helper: HelperClient,
): Capability {
  // A grant that held the keyboard lets go of it when it ends, however it ends.
  const watched = new WeakSet<Grant>();
  const watch = (grant: Grant) => {
    if (watched.has(grant)) return;
    watched.add(grant);
    grant.signal.addEventListener(
      "abort",
      () => void helper.call("input_release", {}, 3000).catch(() => undefined),
      { once: true },
    );
  };

  const takeScreenshot = defineTool({
    name: "take_screenshot",
    description: `Capture the owner's screen — the whole main display by default — as an image you can read coordinates off.

**Returns:** an image, plus {"width":1280,"height":800,"scale":0.5,"origin":{"x":0,"y":0},"display":0,"display_size":{"width":2560,"height":1600},"cursor":{"x":804,"y":233}}
The image is scaled to at most max_width pixels wide. A point in the image maps to the screen as x = origin.x + image_x / scale, y = origin.y + image_y / scale — those are the x and y click, drag and scroll take. With scale 1 (the default when the display fits) they are the same numbers.

**Use cases:**
- See what is on screen before acting, and after, to confirm an action landed
- Read something drawn as pixels (a canvas, a game, a chart) that the headless server's tree cannot see
- Zoom into a region for small text: x, y, width, height in points, with max_width raised

Screenshots cost tokens: prefer the headless server's read_ui_tree or read_text when the app exposes them, and capture a region rather than the display when you know where to look.`,
    schema: z.object({
      display: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          "Which display, by index from list_displays. Default 0, the main display.",
        ),
      x: z
        .number()
        .optional()
        .describe(
          "Region: left edge, in screen points. Give all four of x, y, width, height or none.",
        ),
      y: z.number().optional().describe("Region: top edge, in screen points."),
      width: z.number().min(1).optional().describe("Region: width in points."),
      height: z
        .number()
        .min(1)
        .optional()
        .describe("Region: height in points."),
      max_width: z
        .number()
        .int()
        .min(160)
        .max(4096)
        .optional()
        .describe(
          `Widest image to return, in pixels. Defaults to the machine's setting (${config.computer.maxScreenshotWidth}).`,
        ),
      format: z
        .enum(["jpeg", "png"])
        .default("jpeg")
        .describe(
          '"jpeg" (default, smaller) or "png" (exact pixels, for small text).',
        ),
    }),
    inputSchema: {
      type: "object",
      properties: {
        display: {
          type: "integer",
          default: 0,
          description:
            "Which display, by index from list_displays. Default 0, the main display.",
        },
        x: {
          type: "number",
          description:
            "Region: left edge, in screen points. Give all four of x, y, width, height or none.",
        },
        y: {
          type: "number",
          description: "Region: top edge, in screen points.",
        },
        width: { type: "number", description: "Region: width in points." },
        height: { type: "number", description: "Region: height in points." },
        max_width: {
          type: "integer",
          description: `Widest image to return, in pixels. Defaults to the machine's setting (${config.computer.maxScreenshotWidth}).`,
        },
        format: {
          type: "string",
          enum: ["jpeg", "png"],
          default: "jpeg",
          description:
            '"jpeg" (default, smaller) or "png" (exact pixels, for small text).',
        },
      },
    },
    annotations: { title: "Screenshot the screen", readOnlyHint: true },
    summarize: (a) =>
      `take_screenshot: display ${a.display}${a.width ? ` region ${a.x},${a.y} ${a.width}x${a.height}` : ""}`,
    handler: async (a, { grant }) => {
      watch(grant);
      const region = [a.x, a.y, a.width, a.height];
      const given = region.filter((v) => v !== undefined).length;
      if (given !== 0 && given !== 4)
        return text("A region needs all four of x, y, width and height.", true);
      const shot = await helper.call<Shot>("screen_capture", {
        display: a.display,
        ...(given === 4
          ? { x: a.x, y: a.y, width: a.width, height: a.height }
          : {}),
        max_width: Math.min(
          a.max_width ?? config.computer.maxScreenshotWidth,
          config.computer.maxScreenshotWidth,
        ),
        format: a.format,
      });
      const { image_base64, mime_type, ...info } = shot;
      return {
        content: [
          { type: "image", data: image_base64, mimeType: mime_type },
          { type: "text", text: JSON.stringify(info) },
        ],
      };
    },
  });

  const listDisplays = defineTool({
    name: "list_displays",
    description: `The displays attached to the Mac, the cursor's position and the frontmost app — the geometry the other tools work in, without a screenshot.

**Returns:** {"displays":[{"index":0,"id":1,"main":true,"x":0,"y":0,"width":1512,"height":982,"pixel_width":3024,"pixel_height":1964}],"cursor":{"x":804,"y":233},"frontmost_app":{"pid":512,"name":"Safari","bundle_id":"com.apple.Safari"}}

**Use cases:**
- Learn the screen size before planning clicks
- Check which app has focus before typing
- Find a second display's origin for a screenshot of it`,
    schema: z.object({}),
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List displays", readOnlyHint: true },
    handler: async (_a, { grant }) => {
      watch(grant);
      return json(await helper.call("displays"));
    },
  });

  const click = defineTool({
    name: "click",
    description: `Click at a point on the screen with the owner's REAL mouse. The cursor moves there and stays there.

**Returns:** {"clicked":true}

**Use cases:**
- Press a button or link you located on a screenshot
- Focus a field before type_text
- Double-click (count 2) to open, right-click (button "right") for a context menu, cmd-click (modifiers ["cmd"]) to multi-select

Take a screenshot afterwards if the result matters. If the target has an Accessibility element, the headless server's perform_action does the same thing without touching the mouse.`,
    schema: z.object({
      x: z.number().describe(P.x),
      y: z.number().describe(P.y),
      button: z.enum(["left", "right", "middle"]).default("left"),
      count: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(1)
        .describe("1 for a click, 2 for a double-click, 3 for a triple-click."),
      modifiers: z.array(z.string()).default([]).describe(P.modifiers),
    }),
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: P.x },
        y: { type: "number", description: P.y },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          default: "left",
        },
        count: {
          type: "integer",
          default: 1,
          description:
            "1 for a click, 2 for a double-click, 3 for a triple-click.",
        },
        modifiers: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: P.modifiers,
        },
      },
      required: ["x", "y"],
    },
    annotations: { title: "Click", readOnlyHint: false, destructiveHint: true },
    summarize: (a) =>
      `click: ${a.button} x${a.count} at ${a.x},${a.y}${a.modifiers.length ? ` +${a.modifiers.join("+")}` : ""}`,
    handler: async (a, { grant }) => {
      watch(grant);
      return json(await helper.call("click", a));
    },
  });

  const moveMouse = defineTool({
    name: "move_mouse",
    description: `Move the owner's real cursor to a point without clicking.

**Returns:** {"moved":true}

**Use cases:**
- Hover to reveal a tooltip or a hover-only control, then screenshot
- Park the cursor out of the way before a screenshot`,
    schema: z.object({
      x: z.number().describe(P.x),
      y: z.number().describe(P.y),
    }),
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: P.x },
        y: { type: "number", description: P.y },
      },
      required: ["x", "y"],
    },
    annotations: { title: "Move the mouse", readOnlyHint: false },
    summarize: (a) => `move_mouse: ${a.x},${a.y}`,
    handler: async (a, { grant }) => {
      watch(grant);
      return json(await helper.call("mouse_move", a));
    },
  });

  const drag = defineTool({
    name: "drag",
    description: `Press the left button at one point, move to another, release: a drag with the real mouse.

**Returns:** {"dragged":true}

**Use cases:**
- Move a file onto a folder, a window by its title bar, a slider's knob
- Select a range of text or cells
- Resize a window by its edge`,
    schema: z.object({
      from_x: z.number().describe("Start: " + P.x),
      from_y: z.number().describe("Start: " + P.y),
      to_x: z.number().describe("End: " + P.x),
      to_y: z.number().describe("End: " + P.y),
      modifiers: z.array(z.string()).default([]).describe(P.modifiers),
    }),
    inputSchema: {
      type: "object",
      properties: {
        from_x: { type: "number", description: "Start: " + P.x },
        from_y: { type: "number", description: "Start: " + P.y },
        to_x: { type: "number", description: "End: " + P.x },
        to_y: { type: "number", description: "End: " + P.y },
        modifiers: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: P.modifiers,
        },
      },
      required: ["from_x", "from_y", "to_x", "to_y"],
    },
    annotations: { title: "Drag", readOnlyHint: false, destructiveHint: true },
    summarize: (a) => `drag: ${a.from_x},${a.from_y} → ${a.to_x},${a.to_y}`,
    handler: async (a, { grant }) => {
      watch(grant);
      return json(await helper.call("drag", a));
    },
  });

  const scroll = defineTool({
    name: "scroll",
    description: `Scroll whatever is under a point, as a mouse wheel would. Positive delta_y scrolls DOWN (the content moves up), positive delta_x scrolls right. Units are pixels; 300 is about a third of a screen.

**Returns:** {"scrolled":true}

**Use cases:**
- Reveal more of a page or list before the next screenshot
- Scroll a sidebar or a pane without changing focus`,
    schema: z.object({
      x: z.number().describe(P.x),
      y: z.number().describe(P.y),
      delta_x: z.number().min(-10_000).max(10_000).default(0),
      delta_y: z.number().min(-10_000).max(10_000).default(300),
    }),
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: P.x },
        y: { type: "number", description: P.y },
        delta_x: { type: "number", default: 0 },
        delta_y: {
          type: "number",
          default: 300,
          description: "Positive scrolls down.",
        },
      },
      required: ["x", "y"],
    },
    annotations: { title: "Scroll", readOnlyHint: false },
    summarize: (a) => `scroll: ${a.delta_x},${a.delta_y} at ${a.x},${a.y}`,
    handler: async (a, { grant }) => {
      watch(grant);
      return json(
        await helper.call("scroll", {
          x: a.x,
          y: a.y,
          dx: a.delta_x,
          dy: a.delta_y,
        }),
      );
    },
  });

  const typeText = defineTool({
    name: "type_text",
    description: `Type text on the owner's real keyboard, into whatever has focus. Newlines press Return and tabs press Tab; everything else arrives as the exact characters, whatever the keyboard layout.

**Returns:** {"typed":true}

**Use cases:**
- Fill a field you clicked into
- Type a message, a search, a command in a terminal
- Enter text where the headless server's set_value was refused

Click into the field first, and screenshot afterwards if it matters. Keep it to what your purpose covers: this types into whatever the owner left focused.`,
    schema: z.object({
      text: z
        .string()
        .min(1)
        .max(20_000)
        .describe("The text to type, verbatim."),
    }),
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to type, verbatim." },
      },
      required: ["text"],
    },
    annotations: {
      title: "Type text",
      readOnlyHint: false,
      destructiveHint: true,
    },
    // What is typed may be a password: the record gets its length, never the text.
    summarize: (a) => `type_text: ${a.text.length} chars`,
    handler: async (a, { grant }) => {
      watch(grant);
      return json(
        await helper.call(
          "type_text",
          a,
          Math.max(config.native.requestTimeoutMs, a.text.length * 20 + 5000),
        ),
      );
    },
  });

  const pressKeys = defineTool({
    name: "press_keys",
    description: `Press one key, or a chord with modifiers, on the owner's real keyboard: "cmd+s", "cmd+shift+4", "return", "escape", "ctrl+c", "cmd+tab".

**Returns:** {"pressed":true}

**Use cases:**
- Keyboard shortcuts: save, copy, paste, undo, find, switch app
- Navigation keys: tab, return, escape, arrows, page_down, home, end
- Function keys: f1…f20

Names: letters, digits and punctuation as themselves; return (enter), tab, space, escape, backspace, delete, forward_delete, up, down, left, right, home, end, page_up, page_down, f1…f20. Modifiers: cmd, shift, alt, ctrl, fn. For a run of characters use type_text.`,
    schema: z.object({
      keys: z
        .string()
        .min(1)
        .describe('A key or chord, e.g. "cmd+s", "shift+tab", "escape".'),
    }),
    inputSchema: {
      type: "object",
      properties: {
        keys: {
          type: "string",
          description: 'A key or chord, e.g. "cmd+s", "shift+tab", "escape".',
        },
      },
      required: ["keys"],
    },
    annotations: {
      title: "Press keys",
      readOnlyHint: false,
      destructiveHint: true,
    },
    summarize: (a) => `press_keys: ${a.keys}`,
    handler: async (a, { grant }) => {
      watch(grant);
      const parsed = parseChord(a.keys);
      if (!parsed.ok) return text(parsed.reason, true);
      return json(await helper.call("press_keys", { ...parsed.chord }));
    },
  });

  return {
    tools: [
      takeScreenshot,
      listDisplays,
      click,
      moveMouse,
      drag,
      scroll,
      typeText,
      pressKeys,
    ],
    preflight: () => helperPreflight(helper, "computer"),
    status: () => helperStatus(helper),
  };
}
