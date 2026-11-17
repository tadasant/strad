// Drive a built strad-hostd-ax over --stdio, the way the daemon does, and
// check what a GitHub macOS runner can check: the protocol, `hello`, the app
// list, the display list, the controller-and-grant gate in front of every op
// that acts on the machine, and — when the runner holds the grants, which the
// GitHub images do — a real Accessibility tree and a real screenshot. It runs
// from CI's hostd-ax workflow; locally:
// `node ax/smoke.mjs .build/release/strad-hostd-ax`.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: node smoke.mjs <path-to-strad-hostd-ax>");
  process.exit(2);
}

const child = spawn(binary, ["--stdio"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let seq = 0;
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  p(msg);
});
const call = (op, args = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${op} did not answer in 15s`));
    }, 15_000);
    child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
  });

let failed = 0;

// SMOKE_SCREENSHOT_DIR: save real screenshots of the banner and the menu bar
// at the moments that matter, when the helper holds Screen Recording (GitHub's
// macOS images do). Evidence, not a check: a capture that fails is logged.
const shotDir = process.env.SMOKE_SCREENSHOT_DIR;
const snap = async (name) => {
  if (!shotDir) return;
  const r = await call("screen_capture", { max_width: 2048, format: "png" });
  if (r.ok !== true) {
    console.log(`note screenshot ${name} not taken — ${r.error?.code}`);
    return;
  }
  mkdirSync(shotDir, { recursive: true });
  writeFileSync(
    `${shotDir}/${name}.png`,
    Buffer.from(r.result.image_base64, "base64"),
  );
  console.log(
    `note screenshot ${name}.png ${r.result.width}x${r.result.height}`,
  );
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

try {
  const hello = await call("hello");
  check(
    "hello answers",
    hello.ok === true && typeof hello.result?.version === "string",
    JSON.stringify(hello.result),
  );
  const trusted = hello.result?.trusted ?? {};
  check(
    "hello reports both grants as booleans",
    typeof trusted.accessibility === "boolean" &&
      typeof trusted.screen_recording === "boolean",
  );

  const apps = await call("list_apps");
  check(
    "list_apps answers without any grant",
    apps.ok === true && Array.isArray(apps.result?.apps),
    `${apps.result?.apps?.length ?? "?"} apps`,
  );

  const displays = await call("displays");
  check(
    "displays answers without any grant",
    displays.ok === true && Array.isArray(displays.result?.displays),
    JSON.stringify(displays.result?.displays?.[0] ?? null),
  );

  const bad = await call("no_such_op");
  check(
    "an unknown op is refused with unknown_op",
    bad.ok === false && bad.error?.code === "unknown_op",
  );

  // The gate: nothing acts on the machine until the controller has reported a
  // grant that covers it.
  const noController = await call("click", { x: 1, y: 1 });
  check(
    "an input op before any set_state is refused as not_controller",
    noController.ok === false && noController.error?.code === "not_controller",
    noController.error?.code,
  );
  const noTree = await call("ax_tree", { app: "Finder" });
  check(
    "an ax op before any set_state is refused as not_controller",
    noTree.ok === false && noTree.error?.code === "not_controller",
    noTree.error?.code,
  );
  const noMode = await call("banner_mode", { mode: "menubar" });
  check(
    "banner_mode before any set_state is refused as not_controller",
    noMode.ok === false && noMode.error?.code === "not_controller",
    noMode.error?.code,
  );

  const bg = await call("set_state", {
    disabled: false,
    grants: [
      {
        id: "g_bg",
        server: "computer-use-ci-headless",
        purpose: "Smoke-test the headless gate.",
        foreground: false,
      },
    ],
  });
  check("set_state with a background grant is accepted", bg.ok === true);
  const noFg = await call("click", { x: 1, y: 1 });
  check(
    "an input op under a background-only grant is refused as no_grant",
    noFg.ok === false && noFg.error?.code === "no_grant",
    noFg.error?.code,
  );
  const noShot = await call("screen_capture", { max_width: 320 });
  check(
    "a screenshot under a background-only grant is refused as no_grant",
    noShot.ok === false && noShot.error?.code === "no_grant",
    noShot.error?.code,
  );

  const fg = await call("set_state", {
    disabled: false,
    control_url: "http://127.0.0.1:7312",
    grants: [
      {
        id: "g_smoke",
        server: "computer-use-ci",
        purpose: "Smoke-test the banner.",
        foreground: true,
      },
    ],
  });
  check(
    "set_state with a foreground grant shows the banner",
    fg.ok === true && fg.result?.shown === true,
    JSON.stringify(fg.result ?? fg.error),
  );
  check(
    "a grant with nothing running holds the menu-bar icon still",
    fg.result?.animating === false &&
      fg.result?.icon === "cursorarrow.motionlines",
    JSON.stringify(fg.result),
  );
  // The owner's banner size lives in this helper's preferences, and this
  // script also runs on the owner's Mac: note it, and put it back at the end.
  const ownersMode = fg.result?.mode;
  const ownersOpenMode = fg.result?.open_mode;
  const compact = await call("banner_mode", { mode: "compact" });
  check(
    "banner_mode compact shows the strip",
    compact.ok === true &&
      compact.result?.mode === "compact" &&
      compact.result?.panel_visible === true,
    JSON.stringify(compact.result ?? compact.error),
  );

  // The detailed payload the daemon sends: two grants, a session link, a
  // call in flight, a command left running and a finished call. Every
  // field draws, whichever of the three sizes the banner is in.
  const at = Date.now();
  const rich = await call("set_state", {
    disabled: false,
    control_url: "http://127.0.0.1:7312",
    grants: [
      {
        id: "g_smoke",
        server: "computer-use-ci",
        purpose: "Smoke-test the banner.",
        foreground: true,
        started_at: at - 90_000,
        expires_at: at + 1_710_000,
        calls: 3,
        session: "session 1234",
        session_url: "https://zimmer.example.com/sessions/1234",
        in_flight: [
          {
            tool: "click",
            summary: "click: 10,20 left",
            started_at: at - 2000,
          },
        ],
        background: [],
        recent: [
          {
            tool: "screenshot",
            summary: "screenshot: display 0",
            started_at: at - 9000,
            ended_at: at - 8000,
            ok: true,
          },
        ],
      },
      {
        id: "g_smoke_shell",
        server: "shell-ci",
        purpose: "Run the test suite. Report what fails.",
        foreground: false,
        started_at: at - 600_000,
        expires_at: at + 1_200_000,
        calls: 12,
        session: "file:///etc/passwd is not a link",
        session_url: "file:///etc/passwd",
        in_flight: [],
        background: ["run_command: npm test"],
        recent: [],
      },
    ],
  });
  check(
    "set_state with the detailed payload (session, in-flight, recent) shows the banner",
    rich.ok === true && rich.result?.shown === true,
    JSON.stringify(rich.result ?? rich.error),
  );
  // `statusIconAnimation`: always, never, or auto (animate unless Reduce
  // motion is on). CI's runner has Reduce motion on, so the workflow sets
  // `always` and SMOKE_REQUIRE_ANIMATION=1 makes a skipped animation a failure.
  const shouldMove = (r) =>
    r?.animation === "always" ||
    (r?.animation === "auto" && r?.reduce_motion === false);
  const moving = (r) =>
    shouldMove(r)
      ? r?.animating === true && /^cursorarrow\.motionlines/.test(r?.icon)
      : r?.animating === false;
  check(
    "a call in flight animates the menu-bar icon (unless the setting or Reduce motion says not to)",
    moving(rich.result),
    JSON.stringify(rich.result),
  );
  await snap("1-banner-compact-call-running");
  if (process.env.SMOKE_REQUIRE_ANIMATION === "1")
    check(
      "the animation path actually ran (SMOKE_REQUIRE_ANIMATION)",
      rich.result?.animating === true,
      JSON.stringify(rich.result),
    );

  const tucked = await call("banner_mode", { mode: "menubar" });
  check(
    "banner_mode menubar puts the strip away and keeps the menu-bar icon going",
    tucked.ok === true &&
      tucked.result?.mode === "menubar" &&
      tucked.result?.panel_visible === false &&
      tucked.result?.shown === true &&
      moving(tucked.result),
    JSON.stringify(tucked.result ?? tucked.error),
  );
  // Two captures a beat apart: the strip gone, the icon on two frames.
  await snap("2-put-away-icon-animating-a");
  await pause(500);
  await snap("3-put-away-icon-animating-b");
  const stillTucked = await call("set_state", {
    disabled: false,
    grants: [
      {
        id: "g_smoke",
        server: "computer-use-ci",
        purpose: "Smoke-test the banner.",
        foreground: true,
      },
    ],
  });
  check(
    "a push while put away keeps the strip away, and stops the animation when nothing runs",
    stillTucked.result?.panel_visible === false &&
      stillTucked.result?.animating === false,
    JSON.stringify(stillTucked.result),
  );
  const badMode = await call("banner_mode", { mode: "huge" });
  check(
    "banner_mode refuses a size it does not know",
    badMode.ok === false && badMode.error?.code === "bad_args",
    badMode.error?.code,
  );
  const back = await call("banner_mode", { mode: "compact" });
  check(
    "banner_mode compact brings the strip back",
    back.ok === true && back.result?.panel_visible === true,
    JSON.stringify(back.result),
  );

  const badArgs = await call("click", {});
  check(
    "a guarded op with bad arguments refuses with bad_args (or the permission code)",
    badArgs.ok === false &&
      ["accessibility_denied", "bad_args"].includes(badArgs.error?.code),
    badArgs.error?.code,
  );

  const tree = await call("ax_tree", { app: "Finder", max_nodes: 20 });
  if (trusted.accessibility) {
    check(
      "ax_tree reads Finder when Accessibility is granted",
      tree.ok === true && typeof tree.result?.tree === "object",
    );
  } else {
    check(
      "ax_tree refuses without Accessibility",
      tree.ok === false && tree.error?.code === "accessibility_denied",
      tree.error?.code,
    );
  }

  const shot = await call("screen_capture", { max_width: 320 });
  if (trusted.screen_recording) {
    check(
      "screen_capture returns an image when Screen Recording is granted",
      shot.ok === true &&
        typeof shot.result?.image_base64 === "string" &&
        shot.result.width <= 320,
      `${shot.result?.width}x${shot.result?.height}`,
    );
  } else {
    check(
      "screen_capture refuses without Screen Recording",
      shot.ok === false && shot.error?.code === "screen_recording_denied",
      shot.error?.code,
    );
  }

  const missing = await call("banner_mode", {});
  check(
    "banner_mode with no mode is refused",
    missing.ok === false && missing.error?.code === "bad_args",
    missing.error?.code,
  );
  // Show's target first (an open size records it), then the size itself.
  if (ownersOpenMode) await call("banner_mode", { mode: ownersOpenMode });
  if (ownersMode) await call("banner_mode", { mode: ownersMode });
  const cleared = await call("set_state", { disabled: false, grants: [] });
  check(
    "set_state with no grants clears the banner",
    cleared.ok === true &&
      cleared.result?.shown === false &&
      cleared.result?.panel_visible === false &&
      cleared.result?.animating === false &&
      cleared.result?.icon === "circle.dashed",
    JSON.stringify(cleared.result),
  );
  const afterClear = await call("mouse_move", { x: 1, y: 1 });
  check(
    "an input op after the grants are cleared is refused as no_grant",
    afterClear.ok === false && afterClear.error?.code === "no_grant",
    afterClear.error?.code,
  );
} catch (err) {
  check("protocol", false, err.message);
}

child.stdin.end();
await new Promise((r) => child.once("exit", r));
check(
  "the helper exits when stdin closes",
  child.exitCode === 0,
  `exit ${child.exitCode}`,
);
process.exit(failed ? 1 : 0);
