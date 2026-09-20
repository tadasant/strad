import { describe, expect, it } from "vitest";

import { parseScreen } from "../src/screen.js";
import { SCREEN_XML } from "./fakes.js";

const parse = (xml: string, options = {}) =>
  parseScreen(xml, { limit: 100, ...options });

describe("the accessibility hierarchy becomes something to assert on", () => {
  it("returns the elements a person can see, with their labels and values", () => {
    const { elements } = parse(SCREEN_XML("0:42"));
    expect(elements).toEqual([
      // The application root survives the filter, because it carries a label:
      // "which app is in the foreground" is a thing a caller asks.
      {
        type: "Application",
        label: "Motet",
        name: "Motet",
        enabled: true,
        visible: true,
        rect: { x: 0, y: 0, width: 393, height: 852 },
        center: { x: 197, y: 426 },
      },
      {
        type: "StaticText",
        label: "Tuesday's briefing",
        name: "episode-title",
        enabled: true,
        visible: true,
        rect: { x: 24, y: 120, width: 345, height: 34 },
        center: { x: 197, y: 137 },
      },
      {
        type: "Button",
        label: "Play",
        name: "play-button",
        enabled: true,
        visible: true,
        rect: { x: 167, y: 612, width: 60, height: 60 },
        center: { x: 197, y: 642 },
      },
      {
        type: "StaticText",
        label: "0:42",
        name: "elapsed",
        value: "0:42",
        enabled: true,
        visible: true,
        rect: { x: 24, y: 540, width: 60, height: 20 },
        center: { x: 54, y: 550 },
      },
    ]);
  });

  it("drops the layout scaffolding but still counts it", () => {
    const parsed = parse(SCREEN_XML("0:42"));
    // The application node and two `Other` containers are real elements and
    // returning them is how a read_screen costs ten thousand tokens to say the
    // Play button is enabled.
    expect(parsed.matched).toBe(4);
    expect(parsed.total).toBeGreaterThan(parsed.matched);
    expect(parse(SCREEN_XML("0:42"), { include_all: true }).matched).toBe(parsed.total);
  });

  it("hides an off-screen node, which is the most convincing wrong answer available", () => {
    // An iOS hierarchy carries whole view controllers that are not on screen. A
    // label found in one of them looks exactly like a label the user can see.
    const visible = parse(SCREEN_XML("0:42"));
    expect(JSON.stringify(visible.elements)).not.toContain("Offscreen sheet");
    const all = parse(SCREEN_XML("0:42"), { include_all: true });
    expect(JSON.stringify(all.elements)).toContain("Offscreen sheet");
  });

  it("unescapes XML entities, so a label reads as the app wrote it", () => {
    const { elements } = parse(SCREEN_XML("0:42"), { query: "briefing" });
    expect(elements[0]!.label).toBe("Tuesday's briefing");
  });

  it("narrows on a substring of label, name, value or type", () => {
    expect(parse(SCREEN_XML("0:42"), { query: "play" }).elements).toHaveLength(1);
    expect(parse(SCREEN_XML("0:42"), { query: "0:" }).elements).toHaveLength(1);
    expect(parse(SCREEN_XML("0:42"), { query: "Button" }).elements).toHaveLength(1);
    expect(parse(SCREEN_XML("0:42"), { query: "nothing here" }).elements).toEqual([]);
  });

  it("says a result was cut rather than implying the screen is small", () => {
    const parsed = parse(SCREEN_XML("0:42"), { limit: 1 });
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.matched).toBe(4);
    expect(parsed.truncated).toBe(true);
  });

  it("gives every element a tap point in POINTS", () => {
    // The whole coordinate contract: `center` is what tap_screen takes, and it
    // is 2-3x smaller than the same pixel on a screenshot.
    const play = parse(SCREEN_XML("0:42"), { query: "Play" }).elements[0]!;
    expect(play.center).toEqual({ x: 197, y: 642 });
    expect(play.rect!.width).toBe(60);
  });

  it("makes a moving timer checkable, which is the point of the whole tool", () => {
    // "the timer line doesn't move" was a bug report. This is what turns it
    // into a test: read twice, compare one label.
    const before = parse(SCREEN_XML("0:42"), { query: "elapsed" }).elements[0]!;
    const after = parse(SCREEN_XML("0:45"), { query: "elapsed" }).elements[0]!;
    expect(before.value).toBe("0:42");
    expect(after.value).toBe("0:45");
    expect(after.value).not.toBe(before.value);
  });

  it("survives a document it cannot make sense of", () => {
    // A phone that answered with something else must not crash the tool that
    // was going to report what the phone said.
    expect(parse("").elements).toEqual([]);
    expect(parse("not xml at all").elements).toEqual([]);
    expect(parse("<XCUIElementTypeButton label=").elements).toEqual([]);
  });

  it("keeps an interactive element that carries no text at all", () => {
    const xml =
      '<AppiumAXDocument><XCUIElementTypeSwitch type="XCUIElementTypeSwitch" ' +
      'enabled="true" visible="true" x="1" y="2" width="3" height="4"/>' +
      '<XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" ' +
      'visible="true" x="0" y="0" width="393" height="852"/></AppiumAXDocument>';
    const { elements } = parse(xml);
    expect(elements.map((e) => e.type)).toEqual(["Switch"]);
  });
});
