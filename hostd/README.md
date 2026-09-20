# strad-hostd

MCP servers that operate the machine they run on.

| Server    | Tools                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`   | `run_command`, `get_command`, `list_commands`, `kill_command`                                                                                         |
| `browser` | `list_tabs`, `open_tab`, `navigate_tab`, `read_page`, `click_element`, `type_text`, `evaluate_script`, `take_screenshot`, `activate_tab`, `close_tab` |

Every server also has `request_control`, `end_control` and `get_control_status`.
`request_control` takes a purpose of at most two sentences and returns a
`grant_id`, which every other tool requires.

There are two ways to run it. They serve the same tools; only the transport
differs.

- **Locally over stdio**, on any machine, for an MCP client on that machine. No
  tunnel, no Cloudflare, no keys. This page.
- **As a daemon behind strad**, reached through a `local-tunnel` slug. See
  `docs/src/content/docs/servers/hostd.md`. The reasoning is in
  `docs/src/content/docs/servers/hostd-design.md`.

## Run it locally

You are an agent, or a person, on a laptop that should be operated by a local MCP
client such as Claude Code. You need Node 22.4 or newer (`node -v`).

```bash
git clone https://github.com/tadasant/strad
cd strad/hostd
npm ci
npm run build
```

Register the servers with the client. For Claude Code:

```bash
claude mcp add hostd-shell   -- node "$PWD/build/cli.js" stdio shell --no-consent
claude mcp add hostd-browser -- node "$PWD/build/cli.js" stdio browser --no-consent
```

Or in any client's `mcp.json` (use the absolute path to the clone):

```json
{
  "mcpServers": {
    "hostd-shell": {
      "command": "node",
      "args": [
        "/absolute/path/to/strad/hostd/build/cli.js",
        "stdio",
        "shell",
        "--no-consent"
      ]
    },
    "hostd-browser": {
      "command": "node",
      "args": [
        "/absolute/path/to/strad/hostd/build/cli.js",
        "stdio",
        "browser",
        "--no-consent"
      ]
    }
  }
}
```

No config file is needed. Then, from the client:

1. Call `request_control` with a `purpose`. With `--no-consent` it returns at once.
2. Pass the `grant_id` to every other tool.
3. Call `end_control` when done.

### `--no-consent`

Without the flag, `request_control` puts a dialog on the screen and waits five
seconds, and an unanswered dialog is a denial. That is the right default for a
server reached over a network. Run locally, the person who started the process is
at the keyboard and their MCP client already asks about each tool call, so the
flag drops the second dialog. The `serve` command refuses to run without the
dialog; the flag exists for stdio only.

The dialog uses `osascript` on macOS and `zenity` on Linux. With neither, every
request is denied as `no_display`, so use `--no-consent` there.

### The browser server

It attaches to the Chrome that is already running, with its real profile. In that
Chrome, open `chrome://inspect/#remote-debugging` and turn remote debugging on.
This needs Chrome 144 or newer. Chrome asks for permission each time a client
connects. Launching Chrome with `--remote-debugging-port` does not work for the
default profile: Chrome has ignored the flag there since version 136.

To point it at a different Chrome, write `~/.strad-hostd/config.json`:

```json
{ "browser": { "cdpUrl": "http://127.0.0.1:9222" } }
```

or `{ "browser": { "userDataDir": "/path/to/profile" } }`.

### The shell server

Commands run as `$SHELL -lc "<command>"` as your user, with no stdin and no TTY.
It is not sandboxed. A command that outlives `wait_seconds` keeps running and is
polled with `get_command`. A command ends when its shell exits and whatever it
left in the background is killed then, so run a long job in the foreground with
`wait_seconds: 0`. Everything a grant started is killed when the grant ends,
except a command that moved itself into a new session (`setsid`).

## Configuration

`~/.strad-hostd/config.json`. Every field is optional, and an unknown key is an
error. `src/config.ts` is the schema and documents each field. The ones that
matter:

| Field                                                      | Default             |                                                                   |
| ---------------------------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| `consent.onTimeout`                                        | `"deny"`            | what an unanswered dialog means. `"allow"` makes it a veto window |
| `consent.windowSeconds`                                    | `5`                 | how long the dialog stays up                                      |
| `consent.grantMinutes` / `maxGrantMinutes` / `idleMinutes` | `30` / `120` / `10` | grant lifetime                                                    |
| `shell.defaultCwd`                                         | `$HOME`             |                                                                   |
| `port` / `controlPort`                                     | `7311` / `7312`     | daemon mode only, both on `127.0.0.1`                             |

`STRAD_HOSTD_HOME` moves the state directory.

## Development

```bash
npm test   # tsc, then vitest
```

The browser suite drives a real Chrome or Chromium. It looks at
`$HOSTD_TEST_CHROME`, Playwright's cache, then the usual system paths. With none
it skips locally and fails under `CI`.

The macOS halves (the `osascript` dialog, the LaunchAgent, the installer's
`cloudflared` branch) are not exercised by the suite, which runs on Linux.
