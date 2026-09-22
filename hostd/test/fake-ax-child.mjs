// The stdio shape of the fake helper, for the spawn path of
// src/native/transport.ts: reads JSON lines on stdin, answers on stdout, and
// exits when stdin closes — exactly as `strad-hostd-ax --stdio` does.
import { createInterface } from "node:readline";

process.stderr.write("fake-ax started\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply =
    req.op === "hello"
      ? {
          ok: true,
          result: {
            version: "fake-child",
            pid: process.pid,
            executable: process.argv[1],
            trusted: { accessibility: true, screen_recording: false },
          },
        }
      : req.op === "crash"
        ? null
        : {
            ok: false,
            error: { code: "unknown_op", message: `unknown op "${req.op}"` },
          };
  if (reply === null) process.exit(3);
  process.stdout.write(JSON.stringify({ id: req.id, ...reply }) + "\n");
});
rl.on("close", () => process.exit(0));
