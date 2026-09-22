import { PassThrough, Duplex } from "node:stream";

/**
 * A stand-in for `strad-hostd-ax` that speaks its JSON-lines protocol
 * (ax/Sources/strad-hostd-ax/Transport.swift) in-process: the daemon side is
 * exercised end to end on Linux, and the only thing not run is the Swift.
 *
 * It models a Mac with one app, one window and a handful of elements, records
 * every op it was sent, and can be told what `hello` should say about TCC.
 */
export interface FakeState {
  accessibility: boolean;
  screenRecording: boolean;
  /** The last `set_state` the daemon pushed. */
  banner?: {
    disabled: boolean;
    grants: {
      id: string;
      server: string;
      purpose: string;
      foreground: boolean;
    }[];
    control_url?: string;
  };
  fail?: string;
}

export class FakeHelper {
  readonly ops: { op: string; args: Record<string, unknown> }[] = [];
  readonly state: FakeState;
  private channels = new Set<PassThrough>();
  private streams = new Set<Duplex>();
  private textFieldValue = "";

  constructor(over: Partial<FakeState> = {}) {
    this.state = { accessibility: true, screenRecording: true, ...over };
  }

  /** Something the person at the machine did: sent to every connected daemon. */
  emit(event: Record<string, unknown>): void {
    for (const ch of this.channels) ch.write(JSON.stringify(event) + "\n");
  }

  get connections(): number {
    return this.channels.size;
  }

  /** The helper died: every connection the daemon holds drops. */
  drop(): void {
    for (const s of this.streams) s.destroy();
    this.streams.clear();
  }

  /** A fresh transport, as `HelperClient.connect` wants. */
  transport = async (): Promise<Duplex> => {
    if (this.state.fail) throw new Error(this.state.fail);
    const toHelper = new PassThrough();
    const fromHelper = new PassThrough();
    this.channels.add(fromHelper);
    let buffer = "";
    toHelper.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as {
          id?: number;
          op: string;
          args?: Record<string, unknown>;
        };
        const reply = this.handle(req.op, req.args ?? {});
        fromHelper.write(JSON.stringify({ id: req.id, ...reply }) + "\n");
      }
    });
    const stream = Duplex.from({ readable: fromHelper, writable: toHelper });
    this.streams.add(stream);
    stream.once("close", () => {
      this.channels.delete(fromHelper);
      this.streams.delete(stream);
    });
    return stream;
  };

  private handle(
    op: string,
    args: Record<string, unknown>,
  ):
    | { ok: true; result: unknown }
    | { ok: false; error: { code: string; message: string } } {
    this.ops.push({ op, args });
    const ok = (result: unknown) => ({ ok: true as const, result });
    const err = (code: string, message: string) => ({
      ok: false as const,
      error: { code, message },
    });
    const needAx = () =>
      this.state.accessibility
        ? undefined
        : err("accessibility_denied", "not trusted for Accessibility");
    switch (op) {
      case "hello":
        return ok({
          version: "fake",
          pid: 1,
          executable: "/fake/strad-hostd-ax",
          trusted: {
            accessibility: this.state.accessibility,
            screen_recording: this.state.screenRecording,
          },
        });
      case "set_state":
        this.state.banner = args as FakeState["banner"];
        return ok({ shown: (this.state.banner?.grants.length ?? 0) > 0 });
      case "list_apps":
        return ok({
          apps: [
            {
              pid: 512,
              name: "Notes",
              bundle_id: "com.apple.Notes",
              frontmost: true,
              hidden: false,
            },
          ],
        });
      case "ax_tree": {
        const denied = needAx();
        if (denied) return denied;
        if (
          args.app !== "Notes" &&
          args.app !== "512" &&
          args.app !== "com.apple.Notes"
        )
          return err(
            "no_such_app",
            `no running app matches "${String(args.app)}"`,
          );
        return ok({
          app: { pid: 512, name: "Notes", bundle_id: "com.apple.Notes" },
          windows: [{ index: 0, id: "e1", title: "Untitled", main: true }],
          tree: {
            id: "e1",
            role: "AXWindow",
            title: "Untitled",
            frame: { x: 100, y: 100, w: 600, h: 400 },
            children: [
              {
                id: "e2",
                role: "AXTextField",
                placeholder: "Title",
                value: this.textFieldValue,
                focused: true,
                actions: ["AXScrollToVisible"],
                frame: { x: 120, y: 140, w: 300, h: 24 },
              },
              {
                id: "e3",
                role: "AXButton",
                title: "Save",
                actions: ["AXPress"],
                frame: { x: 500, y: 140, w: 80, h: 24 },
              },
              {
                id: "e4",
                role: "AXSecureTextField",
                title: "Password",
                actions: [],
              },
            ],
          },
          truncated: false,
        });
      }
      case "ax_find": {
        const denied = needAx();
        if (denied) return denied;
        const text = String(args.text ?? "").toLowerCase();
        const els = [
          { id: "e3", role: "AXButton", title: "Save", actions: ["AXPress"] },
        ].filter((e) => !text || e.title.toLowerCase().includes(text));
        return ok({
          app: { pid: 512, name: "Notes", bundle_id: "com.apple.Notes" },
          windows: [],
          elements: els,
          visited: 4,
        });
      }
      case "ax_get":
        if (args.element !== "e2" && args.element !== "e3")
          return err("unknown_element", `no element "${String(args.element)}"`);
        return ok({
          id: args.element,
          role: args.element === "e2" ? "AXTextField" : "AXButton",
          value: this.textFieldValue,
          attributes: { AXRoleDescription: "text field" },
          attribute_names: ["AXRole"],
          child_count: 0,
        });
      case "ax_perform":
        if (
          args.element === "e3" &&
          (args.action === "press" || args.action === "AXPress")
        )
          return ok({
            performed: "AXPress",
            element: { id: "e3", role: "AXButton", title: "Save" },
          });
        if (args.element === "e3")
          return err(
            "action_unavailable",
            "that element does not offer that; it offers AXPress",
          );
        return err("unknown_element", `no element "${String(args.element)}"`);
      case "ax_set_value":
        if (args.element !== "e2")
          return err("not_settable", "that element's value cannot be set");
        this.textFieldValue = String(args.value);
        return ok({
          set: true,
          element: {
            id: "e2",
            role: "AXTextField",
            value: this.textFieldValue,
          },
        });
      case "ax_read_text":
        return ok({
          app: { pid: 512, name: "Notes", bundle_id: "com.apple.Notes" },
          windows: [],
          text: `Untitled\nTitle: ${this.textFieldValue}\nSave`,
          truncated: false,
        });
      case "displays":
        return ok({
          displays: [
            {
              index: 0,
              id: 1,
              main: true,
              x: 0,
              y: 0,
              width: 1512,
              height: 982,
              pixel_width: 3024,
              pixel_height: 1964,
            },
          ],
          cursor: { x: 10, y: 20 },
          frontmost_app: {
            pid: 512,
            name: "Notes",
            bundle_id: "com.apple.Notes",
          },
        });
      case "screen_capture":
        if (!this.state.screenRecording)
          return err(
            "screen_recording_denied",
            "not allowed to record the screen",
          );
        return ok({
          image_base64: Buffer.from("not-really-a-jpeg").toString("base64"),
          mime_type: "image/jpeg",
          width: 1280,
          height: 831,
          scale: 1280 / 1512,
          origin: { x: 0, y: 0 },
          display: 0,
          display_size: { width: 1512, height: 982 },
          cursor: { x: 10, y: 20 },
        });
      case "mouse_move":
        return ok({ moved: true });
      case "click":
        return ok({ clicked: true });
      case "drag":
        return ok({ dragged: true });
      case "scroll":
        return ok({ scrolled: true });
      case "type_text":
        return ok({ typed: true });
      case "press_keys":
        return ok({ pressed: true });
      case "input_release":
        return ok({ released: true });
      default:
        return err("unknown_op", `unknown op "${op}"`);
    }
  }
}
