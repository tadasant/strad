// Drive a built strad-hostd-ax over --stdio, the way the daemon does, and
// check what a GitHub macOS runner can check: the protocol, `hello`, the app
// list, the display list, and that every guarded op refuses cleanly with a
// permission code when the runner has granted nothing. It runs from CI's
// hostd-ax workflow; locally: `node ax/smoke.mjs .build/release/strad-hostd-ax`.
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

  const badArgs = await call("click", {});
  check(
    "a guarded op without a grant refuses with a permission or argument code",
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

  const state = await call("set_state", {
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
    "set_state shows the banner",
    state.ok === true && state.result?.shown === true,
    JSON.stringify(state.result ?? state.error),
  );
  const cleared = await call("set_state", { disabled: false, grants: [] });
  check(
    "set_state clears it",
    cleared.ok === true && cleared.result?.shown === false,
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
