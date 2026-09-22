// Drive a built strad-hostd-ax over --stdio, the way the daemon does, and
// check what a GitHub macOS runner can check: the protocol, `hello`, the app
// list, the display list, the controller-and-grant gate in front of every op
// that acts on the machine, and — when the runner holds the grants, which the
// GitHub images do — a real Accessibility tree and a real screenshot. It runs
// from CI's hostd-ax workflow; locally:
// `node ax/smoke.mjs .build/release/strad-hostd-ax`.
import { spawn } from "node:child_process";
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

  const cleared = await call("set_state", { disabled: false, grants: [] });
  check(
    "set_state with no grants clears the banner",
    cleared.ok === true && cleared.result?.shown === false,
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
