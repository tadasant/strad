import { z } from "zod";

import type { Config } from "../config.js";
import { defineTool, json, text, type Capability } from "../mcp/tool.js";
import { clip } from "../shell/output.js";
import { focusForTyping, LIST_ELEMENTS, locate } from "./page-scripts.js";
import {
  credentialPageMatcher,
  credentialPageRefusal,
  redactText,
  redactValue,
  REDACTED,
} from "./redact.js";
import type { ExtensionBridge } from "./bridge.js";
import { BrowserSessions, type BrowserSession } from "./session.js";

const P = {
  tab_id:
    'A tab_id from list_tabs or open_tab, e.g. "8F2C1A…". Tab ids are stable for the life of the tab.',
  url: 'An absolute http(s) URL, e.g. "https://github.com/notifications". Other schemes (file:, chrome:, javascript:) are refused.',
  selector:
    'A CSS selector for ONE element, e.g. "#search", "button[type=submit]" or a selector copied from read_page\'s "elements" format.',
  foreground:
    "false (default): the tab opens in the background and Chrome does not come to the front — the owner is not interrupted. " +
    "true: the tab is focused in its window.",
  format:
    '"text" (default): the visible text. "elements": the clickable/typeable elements with selectors, for click_element and type_text. ' +
    '"html": the raw outer HTML.',
  max_chars:
    "Cap on returned characters. Default 20000; longer content keeps its first and last halves.",
} as const;

/**
 * Only the web. `file:` would make this slug a filesystem reader and `chrome:`
 * a settings editor — both are what the SHELL slug's sharper entitlement is for.
 */
export function checkUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (
      u.protocol === "http:" ||
      u.protocol === "https:" ||
      raw === "about:blank"
    )
      return undefined;
    return `Refused: only http(s) URLs can be opened, not "${u.protocol}".`;
  } catch {
    return `"${raw}" is not an absolute URL.`;
  }
}

/**
 * What a click in a tab that is still hidden says. Chrome drops mouse input
 * sent to a hidden tab's page, so a click there would be a silent no-op, and a
 * caller waiting on its effect would wait out its whole timeout instead.
 */
export const HIDDEN_TAB_CLICK =
  "The tab is hidden (in the background, or its window is covered or minimised) and Chrome would not deliver a click to it, " +
  "even with focus emulation on. Nothing was clicked. Bring the tab to the front with the browser server's activate_tab " +
  "(it takes the owner's focus) or ask the owner to, then call again.";

export type ClickResult =
  | { clicked: true; tag: string }
  | { clicked: false; reason: "no-match" | "hidden" };

/** click_element needs a selector verbatim; a page does not put a credential in one. */
const KEEP_SELECTOR = new Set(["selector"]);

/** Say how many values were taken out, so a caller does not mistake them for the page's. */
function withRedacted<T extends object>(
  out: T,
  count: number,
): T | (T & { redacted: number; redacted_note: string }) {
  if (count === 0) return out;
  return {
    ...out,
    redacted: count,
    redacted_note: `${count} token-shaped value(s) were replaced with ${REDACTED} before this left the machine. They cannot be read through this server; to take a credential, use the custody server.`,
  };
}

/** How long a page may take to read itself visible once emulation is on. */
const VISIBLE_GRACE_MS = 500;

/**
 * One click at a time per tab. Focus emulation is per tab, and on the
 * extension route every grant shares the tab's one attachment, so one click's
 * switch-off could land between another's switch-on and its input.
 */
const clicking = new Map<string, Promise<unknown>>();

/**
 * Click one element with a real mouse event at its centre, scrolled into view
 * first. Shared with the custody server, whose click has to be the same click
 * the owner's page sees from this one.
 *
 * Background tabs: Chrome does not route DevTools mouse input to a hidden
 * page, so the click is wrapped in `Emulation.setFocusEmulationEnabled`, which
 * makes the page focused AND visible to itself for this session — the input
 * then lands as a trusted click, without bringing the tab to the front and
 * without taking the owner's focus. It is switched off again straight after,
 * so the page goes back to throttling as a background tab. A Chrome where the
 * page still reads hidden under emulation is refused before any input is sent,
 * rather than clicked into nothing.
 */
export function clickSelector(
  s: BrowserSession,
  tabId: string,
  selector: string,
): Promise<ClickResult> {
  const prior = clicking.get(tabId) ?? Promise.resolve();
  const run = prior.then(
    () => clickOnce(s, tabId, selector),
    () => clickOnce(s, tabId, selector),
  );
  const tail = run.catch(() => {});
  clicking.set(tabId, tail);
  void tail.then(() => {
    if (clicking.get(tabId) === tail) clicking.delete(tabId);
  });
  return run;
}

async function clickOnce(
  s: BrowserSession,
  tabId: string,
  selector: string,
): Promise<ClickResult> {
  // A route that refuses the method still gets the visibility check below.
  const emulating = await s
    .send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true })
    .then(
      () => true,
      () => false,
    );
  try {
    type At = { x: number; y: number; tag: string; hidden?: boolean };
    let at = await s.evaluate<At | null>(tabId, locate(selector));
    // The browser answers the switch-on before the page has necessarily
    // heard it; give the page a moment to read itself visible.
    const deadline = Date.now() + VISIBLE_GRACE_MS;
    while (emulating && at?.hidden && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      at = await s.evaluate<At | null>(tabId, locate(selector));
    }
    if (!at) return { clicked: false, reason: "no-match" };
    if (at.hidden) return { clicked: false, reason: "hidden" };
    const base = { x: at.x, y: at.y, button: "left", clickCount: 1 };
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await s.send(tabId, "Input.dispatchMouseEvent", { ...base, type });
    return { clicked: true, tag: at.tag };
  } finally {
    if (emulating)
      await s
        .send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false })
        .catch(() => {});
  }
}

export function browserCapability(
  config: Config,
  bridge?: ExtensionBridge,
): Capability {
  const sessions = new BrowserSessions(config, bridge);
  const credentialPage = credentialPageMatcher(config.browser.credentialPages);

  const listTabs = defineTool({
    name: "list_tabs",
    description: `List the tabs open in the owner's real Chrome — their own windows and profile, not a separate automation browser.

**Returns:** {"tabs":[{"tab_id":"8F2C…","title":"Inbox (3)","url":"https://mail.google.com/…","opened_by_you":false}]}
opened_by_you is true for tabs this grant opened with open_tab; close_tab only closes those.

**Use cases:**
- Find a tab the owner already has open and logged in
- Get the tab_id the other tools need
- Check what you have opened before ending control
- Confirm Chrome is reachable at all (an error here explains what the owner must switch on)`,
    schema: z.object({}),
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List Chrome tabs", readOnlyHint: true },
    handler: async (_a, { grant }) =>
      json({ tabs: await sessions.for(grant).tabs() }),
  });

  const openTab = defineTool({
    name: "open_tab",
    description: `Open a new tab in the owner's Chrome and load a URL in it, with their cookies and logins. Prefer this to navigating a tab they already had open.

**Returns:** {"tab_id":"8F2C…","url":"https://…","title":"…","load":"complete"}
load is "complete", or "timeout" if the page was still loading after 15s (it is usually usable anyway). A URL that loads no page — a download, an empty response — returns after about 5s with url "about:blank".

**Use cases:**
- Reach a site the owner is signed in to, as them
- Prepare a page for the owner to find later (leave it open; set foreground true only if they asked to see it now)
- Start a multi-step flow in a tab of your own instead of disturbing theirs`,
    schema: z.object({
      url: z.string().min(1).describe(P.url),
      foreground: z.boolean().default(false).describe(P.foreground),
    }),
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: P.url },
        foreground: {
          type: "boolean",
          description: P.foreground,
          default: false,
        },
      },
      required: ["url"],
    },
    annotations: {
      title: "Open a tab",
      readOnlyHint: false,
      openWorldHint: true,
    },
    summarize: (a) => `open_tab: ${a.url.slice(0, 200)}`,
    handler: async (a, { grant }) => {
      const bad = checkUrl(a.url);
      if (bad) return text(bad, true);
      const s = sessions.for(grant);
      const targetId = await s.openTab(a.url, a.foreground);
      const load = await s.waitForLoad(
        targetId,
        15_000,
        a.url !== "about:blank",
      );
      const info = await s.evaluate<{ url: string; title: string }>(
        targetId,
        "({url: location.href, title: document.title})",
      );
      return json({ tab_id: targetId, ...info, load });
    },
  });

  const navigateTab = defineTool({
    name: "navigate_tab",
    description: `Load a URL in an existing tab. On a tab the owner had open this REPLACES what they were looking at — prefer open_tab unless moving that tab is the point.

**Returns:** {"tab_id":"8F2C…","url":"https://…","title":"…","load":"complete"}

**Use cases:**
- Move a tab you opened to the next page of a flow
- Bring a tab the owner named into the state they asked for
- Reload a page (navigate to its current URL)`,
    schema: z.object({
      tab_id: z.string().min(1).describe(P.tab_id),
      url: z.string().min(1).describe(P.url),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: P.tab_id },
        url: { type: "string", description: P.url },
      },
      required: ["tab_id", "url"],
    },
    annotations: {
      title: "Navigate a tab",
      readOnlyHint: false,
      openWorldHint: true,
    },
    summarize: (a) => `navigate_tab: ${a.url.slice(0, 200)}`,
    handler: async (a, { grant }) => {
      const bad = checkUrl(a.url);
      if (bad) return text(bad, true);
      const s = sessions.for(grant);
      const nav = await s.send<{ errorText?: string }>(
        a.tab_id,
        "Page.navigate",
        { url: a.url },
      );
      if (nav.errorText)
        return text(`Navigation failed: ${nav.errorText}`, true);
      const load = await s.waitForLoad(a.tab_id);
      const info = await s.evaluate<{ url: string; title: string }>(
        a.tab_id,
        "({url: location.href, title: document.title})",
      );
      return json({ tab_id: a.tab_id, ...info, load });
    },
  });

  const readPage = defineTool({
    name: "read_page",
    description: `Read a tab's current content.

**Returns:**
- format "text": {"url":"…","title":"…","text":"visible page text…","truncated":false}
- format "elements": {"url":"…","title":"…","elements":[{"selector":"#q","tag":"input","type":"search","label":"Search"},{"selector":"main > a:nth-of-type(2)","tag":"a","label":"Pricing","href":"https://…"}]} — up to 400 visible interactive elements
- format "html": {"url":"…","title":"…","html":"<html…","truncated":true}

**Use cases:**
- Read what a logged-in page says (an inbox, a dashboard, an order status)
- Find the selector of a button or field before click_element / type_text
- Check the result of a click or a navigation
- Pull structured data out of the DOM with format "html" when text loses it`,
    schema: z.object({
      tab_id: z.string().min(1).describe(P.tab_id),
      format: z
        .enum(["text", "elements", "html"])
        .default("text")
        .describe(P.format),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(400_000)
        .default(20_000)
        .describe(P.max_chars),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: P.tab_id },
        format: {
          type: "string",
          enum: ["text", "elements", "html"],
          description: P.format,
          default: "text",
        },
        max_chars: {
          type: "integer",
          description: P.max_chars,
          default: 20_000,
        },
      },
      required: ["tab_id"],
    },
    annotations: {
      title: "Read a tab",
      readOnlyHint: true,
      openWorldHint: true,
    },
    handler: async (a, { grant }) => {
      const s = sessions.for(grant);
      const page = await s.evaluate<{ url: string; title: string }>(
        a.tab_id,
        "({url: location.href, title: document.title})",
      );
      const matched = credentialPage(page.url);
      if (matched && a.format !== "elements")
        return text(
          credentialPageRefusal(redactText(page.url).text, matched),
          true,
        );
      const head = redactValue(page);
      if (a.format === "elements") {
        const elements = redactValue(
          await s.evaluate<unknown[]>(a.tab_id, LIST_ELEMENTS),
          KEEP_SELECTOR,
        );
        return json(
          withRedacted(
            { ...head.value, elements: elements.value },
            head.count + elements.count,
          ),
        );
      }
      const raw = await s.evaluate<string>(
        a.tab_id,
        a.format === "html"
          ? "document.documentElement.outerHTML"
          : "document.body ? document.body.innerText : ''",
      );
      // Redact BEFORE clipping, so a clip cannot cut a token in half and
      // leave each half too short to recognise.
      const body = redactText(raw ?? "");
      const out = clip(body.text, a.max_chars);
      return json(
        withRedacted(
          { ...head.value, [a.format]: out.text, truncated: out.truncated },
          head.count + body.count,
        ),
      );
    },
  });

  const clickElement = defineTool({
    name: "click_element",
    description: `Click one element in a tab, with a real mouse event at the element's centre (scrolled into view first). A background tab is clicked where it is: it is not brought to the front.

**Returns:** {"clicked":"button","url":"https://…"} — url is where the tab is after the click, so a navigation shows.

**Use cases:**
- Press a button or follow a link found with read_page format "elements"
- Tick a checkbox, open a menu, switch a tab in a web app
- Submit a form after type_text

If the selector matches nothing the result is an error and nothing is clicked; re-read the page, the DOM may have changed.`,
    schema: z.object({
      tab_id: z.string().min(1).describe(P.tab_id),
      selector: z.string().min(1).describe(P.selector),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: P.tab_id },
        selector: { type: "string", description: P.selector },
      },
      required: ["tab_id", "selector"],
    },
    annotations: {
      title: "Click an element",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    summarize: (a) => `click_element: ${a.selector.slice(0, 120)}`,
    handler: async (a, { grant }) => {
      const s = sessions.for(grant);
      const at = await clickSelector(s, a.tab_id, a.selector);
      if (!at.clicked)
        return text(
          at.reason === "hidden"
            ? HIDDEN_TAB_CLICK
            : `No element matches ${JSON.stringify(a.selector)}. Nothing was clicked.`,
          true,
        );
      await new Promise((r) => setTimeout(r, 250));
      await s.waitForLoad(a.tab_id, 8000);
      return json({
        clicked: at.tag,
        url: await s.evaluate<string>(a.tab_id, "location.href"),
      });
    },
  });

  const typeText = defineTool({
    name: "type_text",
    description: `Focus a field in a tab and type into it, as keyboard input the page's own handlers see.

**Returns:** {"typed":12,"submitted":false}

**Use cases:**
- Fill a search box and press Enter (submit true)
- Fill one field of a form (call once per field, then click_element the submit button)
- Replace a field's contents (clear true, the default) or append to them (clear false)

Do not type credentials the owner did not give you for this purpose: their browser is already signed in, which is the point of using it.`,
    schema: z.object({
      tab_id: z.string().min(1).describe(P.tab_id),
      selector: z.string().min(1).describe(P.selector),
      text: z.string().max(50_000).describe("The text to type."),
      clear: z
        .boolean()
        .default(true)
        .describe("Empty the field first. Default true."),
      submit: z
        .boolean()
        .default(false)
        .describe("Press Enter after typing. Default false."),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: P.tab_id },
        selector: { type: "string", description: P.selector },
        text: { type: "string", description: "The text to type." },
        clear: {
          type: "boolean",
          description: "Empty the field first. Default true.",
          default: true,
        },
        submit: {
          type: "boolean",
          description: "Press Enter after typing. Default false.",
          default: false,
        },
      },
      required: ["tab_id", "selector", "text"],
    },
    annotations: {
      title: "Type into a field",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    summarize: (a) =>
      `type_text: ${a.text.length} chars into ${a.selector.slice(0, 120)}`,
    handler: async (a, { grant }) => {
      const s = sessions.for(grant);
      const found = await s.evaluate<boolean>(
        a.tab_id,
        focusForTyping(a.selector, a.clear),
      );
      if (!found)
        return text(
          `No element matches ${JSON.stringify(a.selector)}. Nothing was typed.`,
          true,
        );
      await s.send(a.tab_id, "Input.insertText", { text: a.text });
      if (a.submit) {
        const key = {
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: "\r",
        };
        await s.send(a.tab_id, "Input.dispatchKeyEvent", {
          type: "keyDown",
          ...key,
        });
        await s.send(a.tab_id, "Input.dispatchKeyEvent", {
          type: "keyUp",
          ...key,
        });
        await new Promise((r) => setTimeout(r, 250));
        await s.waitForLoad(a.tab_id, 8000);
      }
      return json({ typed: a.text.length, submitted: a.submit });
    },
  });

  const evaluateScript = defineTool({
    name: "evaluate_script",
    description: `Evaluate a JavaScript expression in a tab and return its JSON-serialisable value. Promises are awaited. The escape hatch for what the other tools cannot express.

**Returns:** {"value": <the expression's value>} — or an error carrying the page's exception.

**Use cases:**
- Extract a table: "[...document.querySelectorAll('tr')].map(r => r.innerText)"
- Read app state a page keeps in JS or localStorage
- Scroll ("window.scrollTo(0, document.body.scrollHeight)") or wait for an element
- Call a site's own same-origin API with fetch(), using the owner's session

It runs with the page's full privileges in the owner's signed-in session. Keep it to what your stated purpose covers.`,
    schema: z.object({
      tab_id: z.string().min(1).describe(P.tab_id),
      expression: z
        .string()
        .min(1)
        .max(100_000)
        .describe(
          'A JavaScript expression, e.g. "document.title" or "(async () => (await fetch(\'/api/me\')).json())()".',
        ),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(400_000)
        .default(20_000)
        .describe(P.max_chars),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: P.tab_id },
        expression: {
          type: "string",
          description: 'A JavaScript expression, e.g. "document.title".',
        },
        max_chars: {
          type: "integer",
          description: P.max_chars,
          default: 20_000,
        },
      },
      required: ["tab_id", "expression"],
    },
    annotations: {
      title: "Evaluate JavaScript in a tab",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    summarize: (a) => `evaluate_script: ${a.expression.slice(0, 200)}`,
    handler: async (a, { grant }) => {
      const s = sessions.for(grant);
      const url = await s.evaluate<string>(a.tab_id, "location.href");
      const matched = credentialPage(url);
      if (matched)
        return text(credentialPageRefusal(redactText(url).text, matched), true);
      const value = redactValue(await s.evaluate(a.tab_id, a.expression));
      const out = clip(
        JSON.stringify(
          withRedacted({ value: value.value ?? null }, value.count),
          null,
          2,
        ),
        a.max_chars,
      );
      return text(out.text);
    },
  });

  const takeScreenshot = defineTool({
    name: "take_screenshot",
    description: `Capture a JPEG of a tab's viewport — what the page looks like, not the owner's whole screen.

**Returns:** an image, plus {"url":"…","title":"…"}.

**Use cases:**
- See a page whose layout matters (a chart, a canvas app, a visual diff)
- Confirm a flow ended where you think it did
- Show your user the state you left a tab in

Chrome does not paint tabs that are in the background of their window, so a screenshot of one can time out. If it does, the error says so: open the tab with foreground true, or use read_page.`,
    schema: z.object({ tab_id: z.string().min(1).describe(P.tab_id) }),
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: P.tab_id } },
      required: ["tab_id"],
    },
    annotations: {
      title: "Screenshot a tab",
      readOnlyHint: true,
      openWorldHint: true,
    },
    handler: async (a, { grant }) => {
      const s = sessions.for(grant);
      let data: string;
      try {
        ({ data } = await s.send<{ data: string }>(
          a.tab_id,
          "Page.captureScreenshot",
          { format: "jpeg", quality: 70 },
          10_000,
        ));
      } catch (err) {
        return text(
          `Screenshot failed: ${(err as Error).message}. A tab in the background of its window is not painted; use activate_tab (it takes the owner's focus) or read_page instead.`,
          true,
        );
      }
      const info = await s.evaluate<{ url: string; title: string }>(
        a.tab_id,
        "({url: location.href, title: document.title})",
      );
      return {
        content: [
          { type: "image", data, mimeType: "image/jpeg" },
          { type: "text", text: JSON.stringify(info) },
        ],
      };
    },
  });

  const activateTab = defineTool({
    name: "activate_tab",
    description: `Bring a tab to the front of its Chrome window. This is the ONE tool here that takes the owner's focus — use it when they asked to be shown something, not as a step in your own work.

**Returns:** {"activated":"8F2C…"}

**Use cases:**
- Hand a prepared tab to the owner: "it's open in front of you"
- Make a background tab paintable for take_screenshot, when read_page will not do`,
    schema: z.object({ tab_id: z.string().min(1).describe(P.tab_id) }),
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: P.tab_id } },
      required: ["tab_id"],
    },
    annotations: {
      title: "Bring a tab to the front",
      readOnlyHint: false,
      idempotentHint: true,
    },
    summarize: (a) => `activate_tab: ${a.tab_id}`,
    handler: async (a, { grant }) => {
      await sessions.for(grant).activateTab(a.tab_id);
      return json({ activated: a.tab_id });
    },
  });

  const closeTab = defineTool({
    name: "close_tab",
    description: `Close a tab THIS GRANT opened. The owner's own tabs are refused — closing someone's tab loses their place, and nothing here can give it back.

**Returns:** {"closed":"8F2C…"}

**Use cases:**
- Clean up the tabs you opened before end_control
- Drop a tab that went somewhere useless`,
    schema: z.object({ tab_id: z.string().min(1).describe(P.tab_id) }),
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: P.tab_id } },
      required: ["tab_id"],
    },
    annotations: {
      title: "Close a tab you opened",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    summarize: (a) => `close_tab: ${a.tab_id}`,
    handler: async (a, { grant }) => {
      const s = sessions.for(grant);
      if (!s.opened.has(a.tab_id)) {
        return text(
          "Refused: that tab was not opened by this grant. Only tabs with opened_by_you true can be closed.",
          true,
        );
      }
      await s.closeTab(a.tab_id);
      return json({ closed: a.tab_id });
    },
  });

  return {
    tools: [
      listTabs,
      openTab,
      navigateTab,
      readPage,
      clickElement,
      typeText,
      evaluateScript,
      takeScreenshot,
      activateTab,
      closeTab,
    ],
    status: async () => ({
      browser: {
        extension: bridge?.connected ?? false,
        via: bridge?.connected ? "extension" : "devtools",
      },
    }),
    close: () => sessions.closeAll(),
  };
}
