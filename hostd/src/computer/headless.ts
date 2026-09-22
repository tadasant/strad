import { z } from "zod";

import type { Config } from "../config.js";
import { defineTool, json, text, type Capability } from "../mcp/tool.js";
import type { HelperClient } from "../native/client.js";
import { clip } from "../shell/output.js";
import { helperPreflight, helperStatus } from "./shared.js";

const P = {
  app: 'The app, by name ("Notes"), bundle id ("com.apple.Notes") or pid — as listed by list_apps. A unique substring of the name works too.',
  window:
    "Which window: an index from read_ui_tree's windows list, or a substring of its title. Defaults to the app's focused window, then its main window.",
  scope:
    '"window" (default): the chosen window. "menu_bar": the app\'s menu bar, for finding menu items. "app": everything the app exposes.',
  element:
    'An element id from read_ui_tree or find_elements, e.g. "e42". Ids are stable while the element exists.',
  max_depth:
    "How deep to descend. Default 8; the tree is cut there and children_omitted marks the cut.",
  max_nodes:
    "Cap on elements returned. Default 400, max 5000. truncated is true when it bit.",
} as const;

interface Node {
  id: string;
  role: string;
  subrole?: string;
  title?: string;
  value?: string;
  description?: string;
  placeholder?: string;
  identifier?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  frame?: { x: number; y: number; w: number; h: number };
  actions?: string[];
  children?: Node[];
  children_omitted?: boolean;
}

interface TreeResult {
  app?: { pid: number; name: string; bundle_id: string };
  windows?: { index: number; id: string; title: string; main?: boolean }[];
  tree: Node;
  truncated: boolean;
}

/** One line per element: id, role, what it says, what it does. */
export function outline(node: Node, depth = 0, out: string[] = []): string[] {
  const bits: string[] = [
    `${"  ".repeat(depth)}${node.id} ${node.role.replace(/^AX/, "")}`,
  ];
  if (node.subrole) bits.push(`(${node.subrole.replace(/^AX/, "")})`);
  if (node.title) bits.push(JSON.stringify(node.title));
  if (node.value !== undefined && node.value !== node.title)
    bits.push(`= ${JSON.stringify(node.value)}`);
  if (node.description && node.description !== node.title)
    bits.push(`· ${node.description}`);
  if (node.placeholder)
    bits.push(`placeholder ${JSON.stringify(node.placeholder)}`);
  if (node.enabled === false) bits.push("[disabled]");
  if (node.focused) bits.push("[focused]");
  if (node.selected) bits.push("[selected]");
  const acts = (node.actions ?? [])
    .filter((a) => a !== "AXScrollToVisible")
    .map((a) => a.replace(/^AX/, "").toLowerCase());
  if (acts.length) bits.push(`{${acts.join(" ")}}`);
  if (node.children_omitted) bits.push("…");
  out.push(bits.join(" "));
  for (const c of node.children ?? []) outline(c, depth + 1, out);
  return out;
}

export function computerHeadlessCapability(
  config: Config,
  helper: HelperClient,
): Capability {
  const listApps = defineTool({
    name: "list_apps",
    description: `List the apps running on the owner's Mac, with the names and ids the other tools take.

**Returns:** {"apps":[{"pid":512,"name":"Notes","bundle_id":"com.apple.Notes","frontmost":false,"hidden":false}]}

**Use cases:**
- Find the app you were asked to operate, and its exact name
- Check whether it is running before reading its window
- See what the owner is in front of right now (frontmost)`,
    schema: z.object({}),
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List running apps", readOnlyHint: true },
    handler: async () => json(await helper.call("list_apps")),
  });

  const readUiTree = defineTool({
    name: "read_ui_tree",
    description: `Read an app window's Accessibility tree: every element with its id, role, text, state and the actions it offers. This is how you SEE an app without a screenshot, and it works on windows behind other windows — the owner is not interrupted.

**Returns** an outline, one element per line, indented by nesting:
e12 Button "Send" {press}
e13 TextField placeholder "To" = "" [focused]
followed by a JSON footer {"app":{…},"windows":[{"index":0,"title":"Untitled"}],"truncated":false}.
Roles are macOS Accessibility roles without the AX prefix. {…} lists what perform_action accepts for that element.

**Use cases:**
- Find the button, field or menu item to act on, then perform_action or set_value with its id
- Read a window's contents as structure rather than pixels (tables, lists, forms)
- Check state after an action (a checkbox ticked, a field filled, a sheet opened)

Native Mac apps expose full trees. Electron apps expose one after the first read (it is switched on for them). Games, canvases and some cross-platform toolkits expose nothing: use the foreground server's screenshot for those. Password fields never show their value. Large windows: raise max_nodes, narrow with scope, or use find_elements.`,
    schema: z.object({
      app: z.string().min(1).describe(P.app),
      window: z
        .union([z.number().int().min(0), z.string().min(1)])
        .optional()
        .describe(P.window),
      scope: z
        .enum(["window", "menu_bar", "app"])
        .default("window")
        .describe(P.scope),
      element: z
        .string()
        .min(1)
        .optional()
        .describe("Start at this element instead of a window: a subtree read."),
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(40)
        .default(8)
        .describe(P.max_depth),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(400)
        .describe(P.max_nodes),
      interactive_only: z
        .boolean()
        .default(false)
        .describe(
          "Only elements you can act on (and their containers): a shorter tree for finding controls.",
        ),
    }),
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: P.app },
        window: { type: ["integer", "string"], description: P.window },
        scope: {
          type: "string",
          enum: ["window", "menu_bar", "app"],
          default: "window",
          description: P.scope,
        },
        element: {
          type: "string",
          description:
            "Start at this element instead of a window: a subtree read.",
        },
        max_depth: { type: "integer", default: 8, description: P.max_depth },
        max_nodes: { type: "integer", default: 400, description: P.max_nodes },
        interactive_only: {
          type: "boolean",
          default: false,
          description:
            "Only elements you can act on (and their containers): a shorter tree for finding controls.",
        },
      },
      required: ["app"],
    },
    annotations: { title: "Read an app's UI tree", readOnlyHint: true },
    summarize: (a) =>
      `read_ui_tree: ${a.app}${a.window !== undefined ? ` window ${a.window}` : ""}`,
    handler: async (a) => {
      const r = await helper.call<TreeResult>("ax_tree", {
        app: a.app,
        ...(a.window !== undefined ? { window: a.window } : {}),
        scope: a.scope,
        ...(a.element ? { element: a.element } : {}),
        max_depth: a.max_depth,
        max_nodes: a.max_nodes,
        interactive_only: a.interactive_only,
      });
      const { tree, ...footer } = r;
      const lines =
        tree && tree.id
          ? outline(tree)
          : ["(nothing — the app exposes no elements here)"];
      return text(`${lines.join("\n")}\n\n${JSON.stringify(footer)}`);
    },
  });

  const findElements = defineTool({
    name: "find_elements",
    description: `Search an app's Accessibility tree for elements by role and/or text, without reading the whole tree.

**Returns:** {"elements":[{"id":"e12","role":"AXButton","title":"Send","frame":{"x":812,"y":140,"w":60,"h":24},"actions":["AXPress"]}],"visited":318}

**Use cases:**
- "the Send button": role "button", text "send"
- Every text field in a form: role "textfield"
- Anything mentioning an order number: text "1234"

Text matches title, value, description, placeholder and identifier, case-insensitively. Role is matched with or without the AX prefix.`,
    schema: z.object({
      app: z.string().min(1).describe(P.app),
      window: z
        .union([z.number().int().min(0), z.string().min(1)])
        .optional()
        .describe(P.window),
      scope: z
        .enum(["window", "menu_bar", "app"])
        .default("window")
        .describe(P.scope),
      role: z
        .string()
        .min(1)
        .optional()
        .describe(
          'An Accessibility role, e.g. "button", "textfield", "menuitem", "staticText".',
        ),
      text: z
        .string()
        .min(1)
        .optional()
        .describe("A substring to look for in the element's text."),
      max_results: z.number().int().min(1).max(200).default(25),
    }),
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: P.app },
        window: { type: ["integer", "string"], description: P.window },
        scope: {
          type: "string",
          enum: ["window", "menu_bar", "app"],
          default: "window",
          description: P.scope,
        },
        role: {
          type: "string",
          description:
            'An Accessibility role, e.g. "button", "textfield", "menuitem", "staticText".',
        },
        text: {
          type: "string",
          description: "A substring to look for in the element's text.",
        },
        max_results: { type: "integer", default: 25 },
      },
      required: ["app"],
    },
    annotations: { title: "Find elements", readOnlyHint: true },
    summarize: (a) =>
      `find_elements: ${a.app} ${a.role ?? ""} ${a.text ? JSON.stringify(a.text) : ""}`.trim(),
    handler: async (a) => {
      if (!a.role && !a.text)
        return text(
          "Give a role, a text, or both; with neither this is read_ui_tree.",
          true,
        );
      return json(
        await helper.call("ax_find", {
          app: a.app,
          ...(a.window !== undefined ? { window: a.window } : {}),
          scope: a.scope,
          ...(a.role ? { role: a.role } : {}),
          ...(a.text ? { text: a.text } : {}),
          max_results: a.max_results,
        }),
      );
    },
  });

  const getElement = defineTool({
    name: "get_element",
    description: `Read everything one element exposes: its role, text, state, frame, actions, every readable attribute, its parent id and child count.

**Returns:** {"id":"e12","role":"AXTextField","value":"hello","frame":{…},"actions":[…],"attributes":{"AXRoleDescription":"text field",…},"attribute_names":[…],"parent":"e9","child_count":0}

**Use cases:**
- Re-read a field after set_value to confirm it took
- See an element's full text when the tree clipped it
- Inspect an unfamiliar control before acting on it`,
    schema: z.object({ element: z.string().min(1).describe(P.element) }),
    inputSchema: {
      type: "object",
      properties: { element: { type: "string", description: P.element } },
      required: ["element"],
    },
    annotations: { title: "Get an element", readOnlyHint: true },
    handler: async (a) =>
      json(await helper.call("ax_get", { element: a.element })),
  });

  const performAction = defineTool({
    name: "perform_action",
    description: `Perform an Accessibility action on an element: press a button, open a menu, tick a checkbox, pick a menu item, focus a field. The app does the work itself, in the background, so the owner's mouse and focus are untouched.

**Returns:** {"performed":"AXPress","element":{…the element after the action…}}

**Actions:** press (buttons, checkboxes, menu items, links), show_menu, pick, confirm, cancel, raise (bring a window forward — this one IS visible to the owner), increment, decrement, focus, or any raw "AX…" name the element lists. read_ui_tree shows each element's actions in {…}.

**Use cases:**
- Click "Save" without moving the mouse: press on the button's id
- Choose a menu item: read_ui_tree with scope "menu_bar", then press it
- Tick a checkbox, expand a disclosure triangle, focus a field before set_value

Some apps only honour menus and drags when they are frontmost. If press does nothing, check the element with get_element; the foreground server is the fallback.`,
    schema: z.object({
      element: z.string().min(1).describe(P.element),
      action: z
        .string()
        .min(1)
        .default("press")
        .describe(
          "press, show_menu, pick, confirm, cancel, raise, increment, decrement, focus, or a raw AX… name.",
        ),
    }),
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: P.element },
        action: {
          type: "string",
          default: "press",
          description:
            "press, show_menu, pick, confirm, cancel, raise, increment, decrement, focus, or a raw AX… name.",
        },
      },
      required: ["element"],
    },
    annotations: {
      title: "Perform an action on an element",
      readOnlyHint: false,
      destructiveHint: true,
    },
    summarize: (a) => `perform_action: ${a.action} ${a.element}`,
    handler: async (a) =>
      json(
        await helper.call("ax_perform", {
          element: a.element,
          action: a.action,
        }),
      ),
  });

  const setValue = defineTool({
    name: "set_value",
    description: `Set an element's value directly through Accessibility: the text of a field, a slider's number, a checkbox's state — no keystrokes, no focus change.

**Returns:** {"set":true,"element":{…the element after the write…}}

**Use cases:**
- Fill a text field or text area with exactly this text (replaces its contents)
- Set a slider or stepper
- Tick or untick a checkbox (1 / 0) when press is not what you want

Not every field accepts a value this way (web content in Chrome often does not); the error says so, and the fallback is focus + the foreground server's type_text.`,
    schema: z.object({
      element: z.string().min(1).describe(P.element),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .describe(
          "The new value: a string for text, a number for sliders and steppers, true/false or 1/0 for checkboxes.",
        ),
    }),
    inputSchema: {
      type: "object",
      properties: {
        element: { type: "string", description: P.element },
        value: {
          type: ["string", "number", "boolean"],
          description:
            "The new value: a string for text, a number for sliders and steppers, true/false or 1/0 for checkboxes.",
        },
      },
      required: ["element", "value"],
    },
    annotations: {
      title: "Set an element's value",
      readOnlyHint: false,
      destructiveHint: true,
    },
    summarize: (a) =>
      `set_value: ${a.element} = ${JSON.stringify(a.value).slice(0, 120)}`,
    handler: async (a) =>
      json(
        await helper.call("ax_set_value", {
          element: a.element,
          value: typeof a.value === "boolean" ? (a.value ? 1 : 0) : a.value,
        }),
      ),
  });

  const readText = defineTool({
    name: "read_text",
    description: `Read a window as text: every label, field, heading, link and button title in reading order, one per line. Faster and smaller than read_ui_tree when you want to know what a window SAYS rather than what it contains.

**Returns:** the text, then a JSON footer {"app":{…},"windows":[…],"truncated":false}

**Use cases:**
- Read a document, a message, a settings pane, a dialog's wording
- Check an app's state ("Connected", "3 unread") without a screenshot
- Get the contents of a table or list

Password fields are omitted. For the structure and ids, use read_ui_tree.`,
    schema: z.object({
      app: z.string().min(1).describe(P.app),
      window: z
        .union([z.number().int().min(0), z.string().min(1)])
        .optional()
        .describe(P.window),
      scope: z
        .enum(["window", "menu_bar", "app"])
        .default("window")
        .describe(P.scope),
      max_chars: z.number().int().min(200).max(400_000).default(20_000),
    }),
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: P.app },
        window: { type: ["integer", "string"], description: P.window },
        scope: {
          type: "string",
          enum: ["window", "menu_bar", "app"],
          default: "window",
          description: P.scope,
        },
        max_chars: { type: "integer", default: 20_000 },
      },
      required: ["app"],
    },
    annotations: { title: "Read a window's text", readOnlyHint: true },
    summarize: (a) => `read_text: ${a.app}`,
    handler: async (a) => {
      const r = await helper.call<
        { text: string; truncated: boolean } & Record<string, unknown>
      >("ax_read_text", {
        app: a.app,
        ...(a.window !== undefined ? { window: a.window } : {}),
        scope: a.scope,
        max_chars: a.max_chars,
      });
      const { text: body, ...footer } = r;
      const out = clip(body, a.max_chars);
      return text(
        `${out.text}\n\n${JSON.stringify({ ...footer, truncated: footer.truncated || out.truncated })}`,
      );
    },
  });

  return {
    tools: [
      listApps,
      readUiTree,
      findElements,
      getElement,
      performAction,
      setValue,
      readText,
    ],
    preflight: () => helperPreflight(helper, "computer-headless"),
    status: () => helperStatus(helper),
    close: () => {
      void config;
    },
  };
}
