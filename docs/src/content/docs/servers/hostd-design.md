---
title: "strad-hostd: the design"
description: Why one daemon exposes several MCP servers, how consent rides on a tool call, what attaches to a live Chrome profile and what silently does not, and what has been run versus reasoned about.
---

`strad-hostd` is a daemon that runs on a machine a person owns and serves MCP
servers that operate that machine: run a shell command, drive the Chrome that is
already open. strad reaches it as [`kind: local-tunnel`](/servers/local-tunnel-host/)
slugs. This page records the decisions and the reasons. [Running it](/servers/hostd/)
is the how-to.

The request it answers named four servers: `shell-tadas-mbp`,
`browser-use-tadas-mbp-headless`, `computer-use-tadas-mbp-headless` and
`computer-use-tadas-mbp`. The first two are built and tested. The second two are
designed here and not built. Nothing on this page describes them as working.

## Why it lives in this repo

A strad server is either a proxy to an officially maintained remote server or
one implemented in this repository. A third-party add-on on a laptop, which is
what the first `local-tunnel` slug fronts, sits outside that line. A daemon whose
source, tests and release live here sits inside it. That is the reason to build
it as a tree in strad rather than adopt an existing remote-control server, and it
is why `hostd/` is a top-level tree with its own lockfile and its own CI job.

It is not under `servers/`. Everything there is baked into the bundle image, and
`test/ci-server-trees.test.ts` fails a directory the Dockerfile does not copy.
This code never runs in a strad container.

## One daemon, several servers

The four names vary on two axes. Capability: shell, browser, computer use. Mode:
whether the work takes over the screen. Three shapes fit that.

| Shape | Entitlement | Consent text | Install | Verdict |
| --- | --- | --- | --- | --- |
| One slug, tools gated by `tools: allow` | one grant covers shell and mouse | one name for everything | one | rejected |
| Four daemons, four tunnels | per capability | per capability | four LaunchAgents, four hostnames, four Access apps | rejected |
| One daemon, one path per capability, one slug per path | per capability | per capability | one | chosen |

strad grants a slug, not a tool. `entitledServers()` intersects a role's list
with a slug's `entitlements:`, and that is the only place "may this caller reach
my filesystem" is decided. A single slug would make reading a file and moving the
mouse the same grant. `tools: allow` narrows what a slug serves to everyone; it
cannot serve one role `run_command` and another role `list_tabs`.

A caller choosing `?servers=` also wants the narrow thing. A session that needs a
logged-in page asks for the browser slug and never sees `run_command` in its tool
list, which is one fewer tool for an injected instruction to reach for.

So `src/capabilities.ts` is a table of logical servers. Each entry is one path on
the daemon's listener (`/shell/mcp`, `/browser/mcp`), one bearer key, one display
name and one strad slug. The consent gate, the kill switch, the audit log, the
status page and the tunnel are shared, because a machine has one owner and one
place to say no.

The mode axis is not a config flag either. "Headless" and "foreground" computer
use have different tool surfaces (an element tree against pixels and coordinates),
different TCC grants and very different blast radii. They are two more rows in the
table when they are built.

## The daemon

**Runtime: Node 22, TypeScript, two runtime dependencies** (`@modelcontextprotocol/sdk`
and `zod`). The same stack as the rest of strad, so the same people and agents can
maintain it. DevTools is spoken over Node's built-in `WebSocket`, so the daemon
carries no browser-automation library. It attaches to a Chrome that is already
running and has no use for the half of Playwright that launches one.

**Kept running by a LaunchAgent, not a LaunchDaemon.** A LaunchDaemon runs as
root, before login, outside any GUI session. It cannot show the consent dialog,
cannot reach the user's Chrome or their TCC grants, and would run remote shell
commands as root. A LaunchAgent runs as the user inside their login session and
stops at logout. The consequence is that a logged-out Mac serves nothing, and
that is the intended behavior.

**`cloudflared` is a supervised child, on a tunnel of its own.** `src/tunnel.ts`
spawns `cloudflared --config ~/.strad-hostd/cloudflared.yml tunnel run` and
restarts it. One LaunchAgent starts the daemon and the daemon starts the tunnel,
so there is no second job and no ordering between two. It does not add an
`ingress:` line to the machine's existing `~/.cloudflared/config.yml`: launchd
runs one `com.cloudflare.cloudflared` job per machine, and a kill switch that
stopped that job would take every other tunnelled server on the machine down.
With its own process, disabling remote control stops this tunnel only. strad then
reports the slugs `offline` and serves `troubleshoot_host`, which is accurate.

**Install is one command**, run from a clone:

```bash
./hostd/install/install.sh --machine "Tadas's MacBook Pro" \
  --suffix tadas-mbp --hostname hostd.example.com
```

It builds, copies the build to `~/.strad-hostd/app` so the clone can go away,
generates a key per server, creates the named tunnel and its DNS route, writes a
`cloudflared.yml` whose ingress names the MCP port and nothing else, and
bootstraps the LaunchAgent. Re-running it upgrades the code and keeps the config,
the keys and the tunnel.

## Consent

### "A connection" does not exist, so a grant does

The requirement was that initiating a connection stalls the daemon on a dialog.
Over a gateway there is no such event. `src/gateway/adapters/http.ts` keeps one
pooled upstream connection per slug, shared by every caller, and forwards a
tool's `name` and `arguments` and nothing else: no client identity, no `_meta`,
no per-caller session. The daemon sees one long-lived client called
`strad-gateway`.

The only channel from the caller to the machine is tool arguments. So the
connection is made an explicit thing a caller asks for:

1. `request_control({ purpose, minutes? })` shows the dialog and blocks.
2. On approval it returns a `grant_id`.
3. Every other tool requires `grant_id`. `src/mcp/server.ts` adds the parameter to
   each capability tool's schema and strips it before the handler, so a tool
   cannot be written that forgets it.

The grant is what the dialog approves, what the status page lists and what the
kill button ends. This also settles what happens when a caller omits the purpose:
it has no `grant_id`, every tool answers `Not permitted … call request_control`,
and nothing runs. A grant is bound to one capability. A browser grant presented
to the shell server is refused.

The listener is stateless (a fresh MCP server per request), because the state
that matters lives in the daemon and is addressed by `grant_id`. The test suite
requests a grant on one connection and uses it on another for that reason.

### The dialog

```
Remote control requested by shell-tadas-mbp MCP server for purpose: Find the Q3
invoice PDFs in ~/Documents and report their file names.

Denied automatically in 5 seconds unless you allow it.
```

Buttons are **Reject** (the default, so a reflexive Return refuses) and **Allow**.
On macOS it is `osascript`'s own `display dialog … giving up after 5`, which needs
no TCC grant and no helper app. The purpose travels as an argument to a constant
script. It is never interpolated into AppleScript source, so a purpose cannot
close a string and start a `do shell script`.

The purpose is untrusted text headed for a screen. `src/consent/purpose.ts`
strips control characters and bidi overrides (a right-to-left override can make a
dialog display a purpose other than the one sent), collapses whitespace, and
refuses more than 280 characters or more than two sentences. It refuses rather
than trims: a truncated purpose is a dialog showing the harmless first half.

### Fail closed, and the tension with the original ask

An unanswered dialog is a denial by default (`consent.onTimeout: "deny"`). Nobody
saw the request, so nobody agreed to it, and what is being granted is a shell on
a personal machine.

This is stricter than the words of the request, which describe a veto window:
stall five seconds, give the person at the laptop the chance to reject, then
proceed. That reading is what unattended use from a phone needs. Both are
supported and the choice belongs to the owner: `onTimeout: "allow"` in
`~/.strad-hostd/config.json`, a file only they can write. The dialog says which
rule is in force, and `request_control`'s description tells the caller, so an
agent knows whether the owner has to be at the screen. Two outcomes are denials
under either setting: a click on Reject, and a dialog that could not be shown at
all (`no_display`: nobody is logged in to the desktop).

### What bounds a grant

| Bound | Default | Why |
| --- | --- | --- |
| lifetime | 30 min, caller may ask up to 120 | a task, not a standing permission |
| idle | 10 min | a caller that went away gives the grant back |
| live grants | 4 | several sessions can work; a loop cannot stack dialogs |
| after a Reject | 60 s cooldown for that server, no dialog shown | a rejection is an answer, and a caller cannot wear the owner down |
| daemon restart | ends every grant | grants are in memory only; one that outlived the process that showed its dialog would be a permission nobody can see |

### The kill switch and the status page

**Full disable is a file**, `~/.strad-hostd/DISABLED`. The status page writes it,
`strad-hostd disable` writes it, and `touch` works with the daemon hung. It
survives a reboot. It is read on every request rather than cached, and consulted
again after the dialog closes in case it was thrown while the dialog was up.
Disabling ends every grant, kills what they started, and stops the tunnel.

**The status page** at `http://127.0.0.1:7312` shows whether remote control is
on, any request whose dialog is on screen now, each live grant with its server,
purpose, age, call count, last tool and running commands, a Kill button per grant,
and the recent audit log.

It is a second listener on a second port, and that is the security property: the
tunnel's ingress names the MCP port only, so no configuration of strad, Cloudflare
or a caller routes a request to it. Three more checks hold if someone points an
ingress at it anyway. It requires a loopback `Host`, which also defeats DNS
rebinding. It refuses any request carrying `cf-connecting-ip`, `cf-ray` or
`x-forwarded-for`. Every write needs a per-boot token, so a web page open in the
owner's browser cannot post a kill, or an enable.

**Kill ends the work, not only the permission.** Each grant carries an
`AbortSignal`. The shell hangs its process groups on it and the browser hangs its
DevTools socket on it.

## The capabilities

### shell — built

`run_command`, `get_command`, `list_commands`, `kill_command`.

- **Execution.** `$SHELL -lc "<command>"`, zsh on macOS, as a login shell so the
  owner's `PATH` applies. The working directory defaults to `$HOME`.
- **No stdin, no TTY.** `sudo` and an ssh host-key question read EOF and fail
  instead of hanging.
- **Waiting is separate from running.** `wait_seconds` (default 30, max 300)
  bounds the call. A command that outlives it is not killed: the result says
  `running` with a `command_id` to poll. A hard ceiling of one hour kills it
  regardless.
- **Output.** stdout and stderr interleaved, capped at 2 MB per command as a head
  and a tail with the dropped middle counted. A response is clipped again to
  `max_output_chars`.
- **Process groups.** Each command is `detached`, so a kill reaches the pipeline
  and the grandchildren.
- **Environment.** The daemon's own `STRAD_HOSTD_*` variables are scrubbed.

**Nothing is refused by pattern.** A denylist of commands is theater: `rm` has a
hundred spellings, and a list that blocks some of them tells the owner they are
protected when they are not. The boundaries are the entitlement, the dialog, the
grant and the kill switch. The tool description says it is not sandboxed.

### browser — built

`list_tabs`, `open_tab`, `navigate_tab`, `read_page`, `click_element`,
`type_text`, `evaluate_script`, `take_screenshot`, `activate_tab`, `close_tab`.

The requirement is the owner's real, running profile. The options differ on
exactly that point:

| Option | Live default profile? | Notes |
| --- | --- | --- |
| Launch Chrome with `--remote-debugging-port` | **No, silently.** | Since Chrome 136 the flag is ignored for the default user-data directory. Chrome starts, no port opens, nothing errors. |
| Same flag plus a non-default `--user-data-dir` | It is a different profile | Works, and the profile is live if the owner moves their whole Chrome life into that directory and always launches with the flag. Any local process can then connect. |
| Copy the profile directory and launch that | **No.** | Chrome's own note on the 136 change says a non-standard data directory uses a different encryption key, so do not expect the copied cookies to decrypt. Where they do, it is still a fork: sessions diverge, and the owner's open tabs are not in it. |
| Playwright or Puppeteer `connectOverCDP` | Inherits the endpoint's answer | A client, not a way in. |
| AppleScript `execute javascript` | Yes | Needs "Allow JavaScript from Apple Events". No input events, no screenshots, no load waiting. |
| A Chrome extension bridging to the daemon | Yes | `chrome.debugger` on the live profile, on any Chrome version. Costs an extension to build, ship and keep installed. |
| `chrome://inspect/#remote-debugging` toggle (Chrome 144+) | **Yes.** | The running browser opens a DevTools endpoint and writes `DevToolsActivePort` into its user-data directory. |

The daemon uses the last. `src/browser/discover.ts` reads `DevToolsActivePort`
from the stock profile directory, connects to the browser target, and attaches to
tabs with flat sessions. A Chrome enabled this way serves no `/json/version`, so
the file is the only discovery that works. When the file is missing, the tool
error says what to switch on, and that the launch flag does not work.

Chrome shows its own "Allow remote debugging?" prompt every time a client
connects, and a "Chrome is being controlled by automated test software" banner
while a session is attached. Both are Chrome's and cannot be turned off. The
daemon bounds the wait at eight seconds and says so in the error. Under
`onTimeout: "allow"` this prompt still needs a person, so unattended browser use
is weaker than unattended shell use. The extension bridge is the way around it,
and it fits behind `BrowserSession` without changing a tool.

"Headless" here means the owner is not interrupted. `open_tab` creates background
tabs. `activate_tab` is the one tool that takes focus and its description says
so. `close_tab` refuses any tab the grant did not open, because closing someone's
tab loses their place. `open_tab` and `navigate_tab` refuse every scheme but
http(s): `file:` would make this slug a filesystem reader and `chrome:` a settings
editor, and both belong to the shell slug's sharper entitlement. Tabs a grant
opened stay open when it ends, because a tab left in a state for the owner is
half the point.

Chrome does not paint a tab in the background of its window, so `take_screenshot`
of one hangs. The tool bounds that at ten seconds and names the way out.

### computer-use headless — designed, not built

Accessibility APIs: `AXUIElement` trees per application. Tools would be
`list_apps`, `read_ui_tree(app)`, `perform_action(element, AXPress | AXSetValue …)`.

- **What it can drive.** Native AppKit and SwiftUI apps expose full trees, and
  `AXPress` works on a window that is not frontmost. That is what makes it
  background control.
- **What it cannot.** Electron apps expose a tree only after
  `AXManualAccessibility` is set on them. Games and canvas-drawn UI expose
  nothing. Some actions (menus, drags) only work on the frontmost app. Secure
  input fields are unreadable by design.
- **TCC.** Accessibility, granted to the responsible process. For a LaunchAgent
  running `node` that is the `node` binary, so System Settings would list "node",
  and the grant would cover every Node script the user ever runs. The design is a
  small signed Swift helper (`strad-hostd-ax`) that holds the grant and speaks
  JSON over stdio to the daemon. It must be signed with a stable identity: an
  ad-hoc-signed binary loses its grant on every rebuild.

### computer-use foreground — designed, not built

Screen capture plus synthetic input through `CGEvent`. Tools would be
`take_screenshot`, `click(x, y)`, `type_text`, `press_keys`, `scroll`.

- **TCC.** Screen Recording for capture and Accessibility for posting events,
  both on the same helper. Recent macOS re-prompts for Screen Recording
  periodically, which a fail-closed unattended machine cannot answer.
- **It takes the machine.** It moves the real cursor and types into whatever is
  focused. A person using the laptop fights it, and their keystrokes land in the
  agent's flow.
- **Consent should differ.** A grant here should hold a visible on-screen
  indicator for its whole life and end on any physical input from the owner.

Both need a native helper and a Mac to develop against. Neither can be exercised
from CI, which runs on Linux. They are a follow-up with its own PR.

## Security model

The two locks of every `local-tunnel` slug apply unchanged. Cloudflare Access
refuses at the edge with a service token, and the policy action must be
`Service Auth`, not `Allow`. The server's own bearer key is enforced on the
machine. The daemon adds:

- **A key per server.** The key strad holds for the browser slug is a 401 on
  `/shell/mcp`. Digests are compared in constant time.
- **Loopback binds.** `127.0.0.1` literally, for both listeners.
- **`serve` refuses `consent.mode: "none"`.** Nothing with a listener runs
  without the gate. That mode exists for stdio.
- **A local audit log**, `~/.strad-hostd/audit.jsonl`, mode 0600. It records
  requests, decisions and one line per tool call including the command. No tool
  returns it and nothing ships it. strad's own telemetry still records no
  arguments.

**What entitlement means here.** Adding one of these slugs to
`roles.zimmer.servers` puts it in reach of every Zimmer session, and therefore of
any prompt injection that lands in one: a web page, an email, an issue body. For
the first `local-tunnel` slug the worst case was a damaged flashcard deck. Here it
is a shell on a personal laptop, or a browser signed in to a bank. The dialog is
the last line and it is a five-second one. Under `onTimeout: "allow"` with nobody
at the screen, it is no line.

Recommended tiering:

| Slug | Recommendation |
| --- | --- |
| `shell-*` | `admin` only. Hand it to a session explicitly when a task needs it. |
| `browser-use-*-headless` | `admin` only. `evaluate_script` in a signed-in profile reaches every account the owner is logged in to, which is arguably wider than the shell. |
| `computer-use-*` | `admin` only, when built. |

None of them is a candidate for fleet-wide entitlement today. If one is widened,
keep `onTimeout: "deny"` on that machine. The widening is the owner's decision:
this work registers nothing with `default_in_roots` and assumes no `zimmer`
entitlement.

## Local-run mode

`strad-hostd stdio shell` serves the same server over stdio. There is no daemon,
no tunnel, no key and no config file: `buildCore()` in `src/daemon.ts` assembles
the gate, the switch and the capabilities, and `serve` and `stdio` differ only in
what they put in front of it. The test suite asserts the tool list is identical.

The consent dialog stays on by default. `--no-consent` turns it off, on the
reasoning that the person who launched the process is at the keyboard and their
MCP client already asks about each tool call. `request_control` and `grant_id`
remain, so an agent that learned the interface through strad uses it unchanged.

`hostd/README.md` is the page to point an agent at.

## What was run, and what was reasoned about

Development and CI are on Linux.

**Run here:** the consent gate and every denial path, purpose validation, grants,
the kill switch, the HTTP listener and its auth through a real MCP client, the
status page and its guards, the shell capability including process-group kills,
the tunnel supervisor against a stand-in binary, stdio mode against the built
CLI, the installer with `--no-agent`, and the browser capability against a real
running Chromium discovered through `DevToolsActivePort`.

**Reasoned about, not run:** the `osascript` dialog and whether it comes to the
front when launched from a LaunchAgent, the LaunchAgent itself, the installer's
`cloudflared` branch, the Chrome 144 toggle and its prompt on a real default
profile, and TCC prompts for files under `~/Documents`, `~/Desktop` and
`~/Downloads` when the shell reaches them (expect "node would like to access…",
or grant `node` Full Disk Access). The first install on the MacBook is the test
of all of these.
