---
title: "strad-hostd: the design"
description: Why one daemon exposes several MCP servers, how consent rides on a tool call, what attaches to a live Chrome profile and what silently does not, and what has been run versus reasoned about.
---

`strad-hostd` is a daemon that runs on a machine a person owns and serves MCP
servers that operate that machine: run a shell command, drive the Chrome that is
already open, operate an app through its Accessibility tree, see the screen and
move the mouse. strad reaches it as [`kind: local-tunnel`](/servers/local-tunnel-host/)
slugs. This page records the decisions and the reasons. [Running it](/servers/hostd/)
is the how-to.

The request it answers named four servers: `shell-tadas-mbp`,
`browser-use-tadas-mbp-headless`, `computer-use-tadas-mbp-headless` and
`computer-use-tadas-mbp`. All four are built. A fifth followed,
`imessage-tadas-mbp`: the owner's Messages history, read-only. The daemon side
of every one is tested on Linux; the native helpers the last three need are
compiled and smoke-tested on a macOS runner, and the parts that need a
permission grant have run on no machine yet. The last section says which is
which.

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
different TCC grants and very different blast radii. They are the third and
fourth rows: `/computer-headless/mcp` and `/computer/mcp`, and each
`CapabilityInfo` carries a `mode`, which is what colours the banner and decides
whether the owner's own keystroke ends the grant.

`messages` is a fifth row for the same reason. Reading every conversation the
owner has had is a different grant from running a command, even though a
shell with Full Disk Access could do it, so it is its own path
(`/messages/mcp`), its own key and its own slug (`imessage-*`), and the one
whose capability is reading rather than operating.

## The daemon

**Runtime: Node 22, TypeScript, three runtime dependencies** (`@modelcontextprotocol/sdk`,
`zod`, and `ws` for the one socket the daemon *accepts*: Node has a WebSocket
client and no server). The same stack as the rest of strad, so the same people
and agents can maintain it. DevTools is spoken over Node's built-in
`WebSocket`, so the daemon carries no browser-automation library. It attaches
to a Chrome that is already running and has no use for the half of Playwright
that launches one. The one thing Node cannot do is hold a macOS privacy grant
sensibly, and that is the native helper's whole job.

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

**A re-run must not be able to strand the machine.** The daemon serves the shell
an unattended installer arrives through, so a plain `bootout` then `bootstrap` is
a window in which losing the script loses the machine. The first unattended run
failed in that shape on the helper's agent
([#457](https://github.com/tadasant/strad/issues/457)):
`Bootstrap failed: 5: Input/output error`. `hostd/install/launchd-smoke.sh`
reproduces that exact error on a real launchd: `bootout` exits 0 while a service
that takes three seconds to die is still loaded, and a `bootstrap` straight after
it fails with 5. That was a macOS runner, not the laptop, and launchd's 5 covers
most refusals, so the cause on the laptop is likely and not proven. Running from a
detached session is the weaker candidate: a new session
changes the POSIX session and neither the Mach bootstrap port nor the audit
session, both inherited from a daemon already in `gui/<uid>`, and the domain is
named explicitly. So `install/launchd.sh` is built for either answer: an unchanged
plist is `kickstart -k` and never unloads, the one unload belongs to a one-shot
launchd itself runs, and a refusal prints what tells the causes apart, including
`launchctl managername`. [The install section](/servers/hostd/#install) has the
paths.

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

Denied automatically in 10 seconds unless you allow it.

Click a button. The keyboard cannot answer this dialog.
```

Buttons are **Allow** (in the primary place), **Reject** and **Disallow and
cool down**, and only a mouse click on one of them answers the dialog. Reject
refuses this one request. Disallow and cool down refuses it and holds that
server off for the cooldown (see the table below). It takes focus when it appears, and the owner may be typing
in another app at that moment, so a key that answered it would decide requests
nobody meant to decide. No key decides it, in either direction. Typing that
lands on it is swallowed.

On macOS it is an `NSAlert` built from JavaScript for Automation
(`osascript -l JavaScript`), which needs no TCC grant and no helper app. Each
button has its key equivalent cleared and refuses first responder, so Return,
Escape, Space (under Full Keyboard Access) and Tab do nothing. The countdown is
`abortModal` scheduled on the run loop, and an aborted dialog is a `timeout`
that goes to `onTimeout` like any other. `display dialog` cannot be made to
ignore the keyboard, so it is only the fallback for an `osascript` whose Cocoa
bridge will not load, and even then it has no default button and no button
named Cancel, so Return and Escape do nothing there either. The purpose travels
as an argument to a constant script. It is never interpolated into script
source, so a purpose cannot close a string and start a `do shell script`.

None of this has run on a Mac. Whether no key answers the `NSAlert`, whether
its three buttons come back as the codes the script reads, and
whether a first click on a button presses it rather than only bringing the
window forward (macOS 14 can decline `activateIgnoringOtherApps`), are
reasoned from AppKit, not observed. Allow is the button
AppKit hands Return to, so the script checks that every key equivalent is
empty and no default button remains before it shows anything, and if one
survived it fails, and the keyless AppleScript dialog is shown instead.

On Linux it is `zenity`, whose keys cannot be switched off: Return there
rejects. Disallow and cool down is its `--extra-button`.

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
stall a few seconds, give the person at the laptop the chance to reject, then
proceed. That reading is what unattended use from a phone needs. Both are
supported and the choice belongs to the owner: `onTimeout: "allow"` in
`~/.strad-hostd/config.json`, a file only they can write. The dialog says which
rule is in force, and `request_control`'s description tells the caller, so an
agent knows whether the owner has to be at the screen. Two outcomes are denials
under either setting: a click on Reject (or Disallow and cool down), and a dialog that could not be shown at
all (`no_display`: nobody is logged in to the desktop).

The unattended configuration is therefore `onTimeout: "allow"` with
`windowSeconds: 3`, the shortest window the schema accepts, and the extension
in Chrome. `serve` still refuses `consent.mode: "none"`: the dialog is shown,
a person who happens to be there can still reject, and the audit log says
`timeout-allow` on every grant nobody answered. What the setting means is that
with nobody there, nothing is refused, and the docs say so wherever it is
mentioned.

### What bounds a grant

| Bound | Default | Why |
| --- | --- | --- |
| lifetime | 30 min, caller may ask up to 120 | a task, not a standing permission |
| idle | 10 min | a caller that went away gives the grant back |
| live grants | 4 | several sessions can work |
| dialogs on screen | 1, machine-wide | a caller firing twenty requests at once would otherwise stack twenty dialogs, and a cooldown chosen in the first could not reach the others. The rest are refused as `dialog_busy` |
| after a Kill, or "Disallow and cool down" | 60 s cooldown for that server (`consent.rejectCooldownSeconds`), no dialog shown | the owner deliberately ended or refused that server's control and asked for quiet. The Kill is the status page's (one grant or all), `strad-hostd kill`, or the banner's |
| after a plain Reject, or an unanswered dialog | no cooldown: the next request gets a fresh dialog | a mis-click costs one request, not a minute of them. One dialog at a time is what keeps a caller from stacking them |
| daemon restart | ends every grant | grants are in memory only; one that outlived the process that showed its dialog would be a permission nobody can see |

### The kill switch and the status page

**Full disable is a file**, `~/.strad-hostd/DISABLED`. The status page writes it,
`strad-hostd disable` writes it, and `touch` works with the daemon hung. It survives a reboot. It is read on every request rather than cached, and consulted
again after the dialog closes in case it was thrown while the dialog was up. A
file made with `touch` calls nothing, so the daemon also checks for it every two
seconds and ends the grants in force when it appears.
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
owner's browser cannot post a kill, or an enable. Reads need no token:
`/state.json` shows purposes and the audit trail to any process on the machine,
which can already read the audit file if it runs as the owner.

**The machine is told, not only asked.** When a grant starts, the OS posts a
notification naming the server, the purpose and the status page's address, and
another when the grant ends. Under `onTimeout: "allow"` the dialog can come and go
with nobody looking, and the notification is what is still there when the owner
comes back. It says so when nobody answered.

**And it is shown, for the life of every grant.** With the native helper
installed, a strip sits at the top of the main display above every window and
on every Space, naming the server and the purpose, with a **Kill** button and a
**Disable everything** button, and the menu bar carries the same state with the
same buttons. The owner can put the strip away into the menu bar; the menu-bar
icon then still shows the grant's colour and count, animates while a call is
running, keeps Kill in its menu, and a foreground grant still ends on the
owner's first key or click. Orange is background control; red is a foreground grant that
holds the mouse. The helper draws it and decides nothing: the daemon pushes the
full set of grants as one idempotent `set_state` message whenever the set
changes and again every two seconds, unconditionally, and the buttons come back
as events the gate acts on. The notification remains, for the case where nobody
was looking.

**One controller, and every op checked against its grants.** The helper's
socket is a file, and every process running as the owner can open it — a
shell-slug command included. So the helper honours one connection at a time:
the first to send `set_state` holds it until it drops, a second connection's
`set_state` is `busy`, and every op that reads a tree, captures the screen or
posts input is refused unless it comes from that connection and the state it
last sent carries a grant that covers it (`no_grant`, `not_controller`). The
daemon connects at boot and re-sends on the clock, so it is the controller
whenever it is up. That closes the cheap path: nobody drives the helper around
the daemon's grant table while the daemon runs. It is not a privilege
boundary, and the limitations page says so: a process running as the owner can
stop the daemon, edit its config, unload either LaunchAgent or replace the
helper, and macOS offers no way for two processes of one user to keep secrets
from each other. That is the shell slug's blast radius, which #159 named on
day one, and the reason it stays `admin`-only.

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
  and the grandchildren. The group is the limit of it. A command that starts a new
  session (`setsid`, a launchd job) has left the group, and neither the kill
  button nor the kill switch can find it again.
- **A command ends when its shell exits.** Whatever is still in its group then is
  killed, so `server &` does not leave a server behind. The record settles on the
  shell's exit and not on its output pipes closing: a background child holding
  the pipe would otherwise keep the command "running" with its shell long gone,
  hold a concurrency slot, and hang `kill_command` and shutdown behind it. A long
  job runs in the foreground with `wait_seconds: 0`.
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
| A Chrome extension bridging to the daemon | **Yes.** | `chrome.debugger` on the live profile, on any Chrome version, with no per-connection prompt. Costs an extension to build, ship and keep installed. |
| `chrome://inspect/#remote-debugging` toggle (Chrome 144+) | Yes | The running browser opens a DevTools endpoint and writes `DevToolsActivePort` into its user-data directory. Asks "Allow remote debugging?" on every connection, and never remembers. |

The daemon uses both, and prefers the extension. `src/browser/backend.ts` is
the seam: one interface — list, open, focus and close tabs, send a DevTools
command to one — with two implementations, and `BrowserSession` picks one per
grant on first use without a tool knowing which. The extension backend is
taken whenever the extension is connected; otherwise `src/browser/discover.ts`
reads `DevToolsActivePort` from the stock profile directory and the DevTools
backend connects to the browser target and attaches to tabs with flat
sessions. A Chrome enabled from the toggle serves no `/json/version`, so the
file is the only discovery that works there. When neither is there, the tool
error says the extension is not connected and what the toggle is.

The toggle route cannot run unattended. Chrome shows its own "Allow remote
debugging?" prompt every time a client connects, and the daemon bounds the
wait at eight seconds and says so in the error. Under `onTimeout: "allow"` that
prompt still needs a person, which is what the extension is for.

#### The extension bridge — built

`hostd/extension/` is a Manifest V3 extension: a service worker, an options
page, and a managed-storage schema. `src/browser/bridge.ts` is its other half.

**The extension dials, the daemon listens.** The service worker opens one
WebSocket to `ws://127.0.0.1:7312/extension` — the CONTROL listener, the port
the tunnel never routes — and the daemon accepts it there. Native messaging
would spawn a host process per connection, a second daemon with its own
lifetime; the daemon already exists and already holds the grant table. Since
Chrome 116 an open WebSocket with traffic keeps a service worker alive, so the
daemon pings it every twenty seconds, and an alarm every thirty reconnects one
that dropped.

**Three guards on the socket, and what each is for.** The listener's own
loopback-`Host`-and-no-proxy-headers test, so nothing that came through a
tunnel or a proxy reaches it. An `Origin` starting `chrome-extension://`,
which a browser sets and a web page cannot forge, so no page open in the
owner's Chrome can pose as the extension. Then the pairing token,
`~/.strad-hostd/extension-token`, made at first boot, mode 0600 — and it
never crosses the socket. Any process on the machine can bind the control
port while the daemon is down and wait for the extension to dial in, so the
daemon proves itself first: the extension's hello carries a nonce, the
daemon's welcome carries an HMAC of the token over it, and an extension that
cannot verify that proof hangs up having sent nothing but the nonce. Then
the extension proves itself the same way over the daemon's nonce, compared in
constant time, and nothing is relayed before that. A wrong proof closes the
socket with code 4003 from whichever side saw it; a second good connection
replaces the first, because there is one owner and one live profile. A
malformed frame from a socket that never said hello is terminated, not
raised: `ws` reports it as an error event, and an unhandled one would take
the daemon down.

**One extension, many grants.** `chrome.debugger` attaches a tab once per
extension, so attachments are shared. Each grant's backend records the tabs it
used; the bridge counts holders per tab, attaches on the first and detaches
when the last lets go. A grant ending releases its tabs, and only those. The
kill switch calls `detachAll` — from the switch's `onChange`, and again on the
two-second sweep, because a `touch`ed `DISABLED` file calls nothing — and the
extension detaches everything itself the moment its socket closes, since a
daemon that is gone has no grants. If the person cancels the debugger from
Chrome's own bar, the extension reports it and the next call re-attaches.

**Tab operations go through `chrome.tabs`, not the Target domain.** `open_tab`
is `chrome.tabs.create`, `activate_tab` is `chrome.tabs.update` plus a window
focus, `close_tab` is `chrome.tabs.remove`, and the tab id is the number Chrome
gives, carried as a string. The DevTools commands the tools use — `Page`,
`Runtime`, `Input` — are all on `chrome.debugger`'s allowed list. Events are
not forwarded: no tool consumes one, and `Runtime.enable` alone would flood the
socket with console events.

**Installing it: unpacked on a personal Mac, by profile on a managed one.**
The route a personal Mac gets is `chrome://extensions` with developer mode
on, Load unpacked, and the token pasted into the options page; it holds while
developer mode does. The daemon also packs `extension/` into a CRX3 signed
with an RSA key it keeps in `~/.strad-hostd/extension-key.pem`
(`src/extension/crx.ts`, a zip writer and the CRX3 header in two hundred
lines, because Chrome's "Pack extension" is a hand step and a Web Store
listing is not the point), serves it with an update manifest at
`http://127.0.0.1:7312/extension/`, and `strad-hostd extension` writes a
configuration profile that force-installs the extension by id from that URL
and sets its managed storage to the daemon URL and the token. Two reads of
Chromium say what that profile is worth. `extension_downloader.cc` forces
HTTPS on the Web Store's update URL only, so a loopback `http://` one is
valid, and `debugger_api.cc` skips the "started debugging this browser"
infobar for a policy-installed extension. But `policy_loader_common.cc`
filters a force-install from outside the Web Store as a *sensitive* policy,
and `policy_loader_mac.mm` applies that filter unless the Mac is MDM-enrolled
or domain-bound — so on a personal Mac the profile's `ExtensionSettings`
entry shows `[BLOCKED]` in `chrome://policy` and installs nothing. The CLI
and the docs say so. The key is what the id is derived from, so the key must
not change: a new key is a new extension and a profile that force-installs
the old one.

**What it costs, said once here and again on the limitations page.** The
owner's real profile becomes drivable with no Chrome prompt by anything that
holds a browser key and gets past the consent window — and unattended use sets
that window to allow. A prompt injection in one agent's page reaches every
account the owner is signed in to. The extension moves the last line of
defence from Chrome to the daemon: the key, the grant, the audit log, the kill
switch, and `admin`-only entitlement.

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

Chrome does not deliver DevTools mouse input to a hidden page either. `click_element`,
and custody's clicks through the same function, switch on
`Emulation.setFocusEmulationEnabled` for the one click. The page reads itself as
visible and focused, and the input lands as a trusted click without the tab
coming forward. Emulation goes off again straight after. A page that still
reads hidden is refused before any input is sent. Keyboard input (`type_text`)
reached a hidden page without it in a windowed Chrome on Linux, so typing is
not wrapped.

### The native helper: `strad-hostd-ax`

Both computer-use servers, and the banner, go through one small Swift program
(`hostd/ax/`, no dependencies, `swift build -c release` with the Command Line
Tools). It exists for one reason: **macOS keys a privacy grant on the code
signature of the "responsible process"**, and for the daemon that would be
`node`. System Settings would list "node", and the grant would cover every
Node script the owner ever runs.

Two consequences shaped it, and the second changed the original design.

- **Signed with a stable identity.** The designated requirement of an ad-hoc
  signature is the binary's own hash, so every rebuild is a different program
  and loses both grants. A signature from any certificate is recognised across
  rebuilds. `install/sign-helper.sh` uses a Developer ID certificate if the
  keychain has one, and otherwise creates a self-signed code-signing
  certificate in the login keychain and trusts it for code signing, which asks
  for the login password once. The certificate signs nothing else.
- **Its own LaunchAgent, not a child of the daemon.** The design said "JSON over
  stdio". Responsibility passes from parent to child through `fork`/`exec` and
  is reset only when launchd (or LaunchServices) starts the process, so a helper
  the daemon spawned would be `node` for TCC's purposes, signature or not. So
  `com.strad.hostd-ax` is a second LaunchAgent listening on a Unix socket in
  the state directory (mode 0600), and the daemon connects to it, reconnecting
  whenever it drops. Once the agent is installed the installer pins
  `native.mode: "socket"`, so a daemon that boots before the helper waits for
  the socket rather than spawning a private helper whose grants would land on
  `node`. Stdio remains for local-run mode, where the daemon spawns the helper
  as a child and the grant lands on the terminal that launched the MCP client,
  which is the ordinary arrangement for a command-line tool.

The protocol is newline-delimited JSON: `{id, op, args}` in, `{id, ok, result}`
or `{id, ok:false, error:{code,message}}` out, and lines with an `event` and no
`id` from the helper when the person at the machine presses a button. The
banner's state is one idempotent `set_state`: each grant's id, server,
purpose and mode, when it started and expires, its call count, the session
its caller claimed in `request_control` (a label, and a link only when it is
https — the helper checks the scheme again before it opens anything), the
calls in flight and the shell commands it left running (the oldest three of
each, with their totals), and its last five calls.
The call text is the tool's own audit summary, scrubbed for the screen by
`hostd/src/consent/display.ts`. None of it is read by `Banner.authorize`, which
still asks only whether the connection is the controller and whether a grant,
or a foreground grant, is in force. Input
and the banner run on the helper's main thread, which AppKit needs; reading an
Accessibility tree and capturing the screen run on a serial queue of their own,
so a stuck app cannot freeze the Kill button. `hello` reports the two grants, and the
daemon asks it **before** showing a consent dialog: a server that cannot work
gets `helper_unavailable` and no dialog, because nothing the person at the
screen can click in ten seconds would fix a missing grant.

### computer-use headless — built

`list_apps`, `read_ui_tree`, `find_elements`, `get_element`, `perform_action`,
`set_value`, `read_text`, through `AXUIElement`.

- **What it drives.** Native AppKit and SwiftUI apps expose full trees, and
  `AXPress` works on a window that is not frontmost. That is what makes it
  background control: the owner keeps their mouse and their focus.
- **What it cannot.** Electron apps expose a tree only after
  `AXManualAccessibility` is set on them, which the helper does on every read.
  Games and canvas-drawn UI expose nothing. Some actions (menus, drags) only
  work on the frontmost app. Secure fields never show a value: the helper skips
  `AXValue` on `AXSecureTextField`.
- **Element ids are stable.** `AXUIElement` is CF-hashable, so `e12` names the
  same button on the next read; an id dies with the element or the helper.
- **The tree is an outline, not JSON.** One line per element with its id, role,
  text, state and actions, for a caller that reads it in a context window.
  `find_elements` is the search, `read_text` the window's words in reading
  order, `max_nodes` and `scope` the bounds.

### messages — built

`imessage_list_chats`, `imessage_get_messages`, `imessage_get_attachment`,
over `~/Library/Messages/chat.db`. iMessage has no API on any platform; that
SQLite file, which Messages keeps on every Mac signed in to the account, is
the only programmatic way in, and it is how every tool that reads iMessage
works (BlueBubbles, imessage-exporter, the Messages MCP servers).

- **Its own helper, `strad-hostd-messages`** (`hostd/messages/`). macOS guards
  the file with Full Disk Access, and the grant has the same
  responsible-process rule as the computer-use grants: a LaunchAgent of its
  own (`com.strad.hostd-messages`), a socket in the state directory
  (`messages.sock`), signed by `install/sign-helper.sh` under its own
  identifier so the grant survives rebuilds and is not shared. It is NOT
  folded into `strad-hostd-ax`: that helper posts mouse and keyboard input,
  and the grant that reads every message should not sit in the same process.
- **The SQL is the daemon's; the guarantee is the helper's.** The helper
  serves four ops — `hello`, `query`, `read_attachment`, `contacts_sources` —
  and `query` runs one statement it is sent. The statements live in `src/messages/chatdb.ts`,
  where `test/messages.test.ts` runs them against a fixture database on Linux.
  What the helper guarantees is that nothing it runs writes or reaches beyond
  chat.db and the Contacts databases it enumerates itself: the connection is `SQLITE_OPEN_READONLY`, a statement SQLite does
  not report read-only is refused, so is anything after the first statement,
  and ATTACH — which `sqlite3_stmt_readonly` calls read-only because it changes
  the connection, not a file — is denied by an authorizer and a limit of zero,
  so no other database Full Disk Access reaches can be opened through it.
- **`attributedBody`.** Since macOS 13 Messages often stores a body only as an
  NSAttributedString archived in the old typedstream format. The helper reads
  it with `NSUnarchiver`, wrapped in a few lines of Objective-C, because the
  unarchiver reports a malformed archive by raising an NSException Swift
  cannot catch. If that refuses, a byte scan for the first NSString is the
  fallback.
- **Attachments by id, never by path.** `read_attachment` takes an
  `attachment.ROWID`, looks up the file in chat.db itself, and refuses one
  that resolves outside the database's directory. HEIC, HEIF and TIFF, and
  any JPEG, PNG or WebP over 3.5 MB (clients refuse image blocks of a few
  megabytes), are converted to a JPEG at most 2048 pixels on a side with
  `sips`, which the helper starts and so inherits its grant, and which is
  killed after 30 seconds. `hello` is answered off the work queue, so a long
  conversion does not make the pre-dialog check report the helper missing. The bytes go back over the socket base64-encoded, capped at
  `messages.maxAttachmentBytes` (10 MB).
- **The cursor is the ROWID.** It only grows, so "after this rowid" is exact:
  no timestamps, no de-duplication, and the messages of every chat in one
  read. It is storage order, not send order: what a woken Mac syncs from
  iCloud arrives with new rowids and old dates. It sees a row once, so an edit
  or unsend made after a sweep read the message is not re-delivered. A
  message row is never skipped for want of its chat: the unfiltered read
  LEFT JOINs the chat and returns `chat_id: null` rather than relying on how
  Messages orders its two writes. A rebuilt database restarts the numbering;
  a cursor past the highest rowid ever handed out (`sqlite_sequence`, which
  survives deleting the newest message) gets a `warning` rather than an empty
  page forever. Without a cursor the read is the newest page, and
  `before_rowid` pages back.
- **Never spawned under `node` once installed.** `native.mode` is a setting
  about the AX helper; with `com.strad.hostd-messages` installed, the daemon
  reaches this helper over its socket whatever that setting says, because a
  spawned child would need Full Disk Access on `node`.
- **Contact names, from Contacts' files.** A sender and each participant
  come with the name the owner's Contacts give them (`sender_name`, a
  participant's `name`), resolved on the Mac so a name never has to be
  looked up anywhere else. Contacts keeps one Core Data SQLite file per
  account, `AddressBook-v22.abcddb` at the top of `~/Library/Application
  Support/AddressBook` and one under each `Sources/<id>/`. They are read as
  files, under the Full Disk Access the helper already holds:
  Contacts.framework would ask for a separate Contacts grant, a prompt an
  unattended LaunchAgent cannot answer. `contacts_sources` returns the ids
  the helper found, and `query` takes one as `contacts_source`, so the daemon
  names a source and never a path; the statement runs under the same
  read-only guards as chat.db's, and the SQL lives in
  `src/messages/contacts.ts`. The whole book is read into one index (phones
  in E.164 with the Mac's region filling a missing country code, emails
  lowercased) and kept for ten minutes, so a page of 200 messages is 200 map
  lookups. A contact saved in another country's local form matches on its
  national number when that number is not valid in the Mac's region and
  exactly one name claims it. An unreadable book means a `contacts_warning`,
  never a failed read: null names if it has never been read, the last read's
  if a re-read failed.
- **What it does not have.** A send tool: posting as the owner is a different grant, and would be a
  separate server and slug. Freshness on a sleeping Mac: see below.
- **Consent.** The intended caller is a nightly sweep, which runs with nobody
  at the screen. `init` and `add` write `onTimeout: "allow"` on this server
  only (`capabilities.messages.onTimeout`), so its dialog is a veto window and
  the machine-wide `deny` still governs the shell and the computer-use
  servers. The alternative — a server exempt from the dialog because it
  cannot operate the machine — was rejected: it would be the first path to a
  grant that skips the gate, and the gate is also where the notification, the
  audit line, the status page and the kill switch attach.

**Freshness.** iMessage exists only on Apple hardware, and a Mac receives
messages only while it is awake. With Messages in iCloud on, a Mac that wakes
syncs what it missed into chat.db with new ROWIDs, so a sweep that holds its
cursor reads the gap on its next run. A sweep that runs while the Mac sleeps
cannot reach it at all (the tunnel is down). An always-on Mac on the same
Apple ID makes it as dependable as the WhatsApp bridge.

### computer-use foreground — built

`take_screenshot`, `list_displays`, `click`, `move_mouse`, `drag`, `scroll`,
`type_text`, `press_keys`: `CGDisplayCreateImage` and `CGEvent` posted at the
HID tap.

- **TCC.** Screen Recording for capture and Accessibility for posting events,
  both on the helper. On macOS 15 the system re-asks for Screen Recording
  roughly monthly, for every capture that skips its picker (the legacy CG
  APIs and ScreenCaptureKit alike); the entitlement that exempts an app is
  issued to VNC-class products on application. An unattended machine cannot
  answer that prompt, so a screenshot taken after the approval lapses fails
  with `screen_recording_denied` until the owner clicks again.
- **It takes the machine, and says so.** The consent dialog carries a second
  line — it will move your mouse and type on your keyboard — and the banner is
  red. Every event the helper posts is stamped, so the helper's global monitor
  can tell the owner's keyboard from its own: the owner's first key or click
  ends the grant (`owner_input`), and ending a grant for any reason releases
  every modifier and the mouse button.
- **Coordinates are points.** `take_screenshot` returns an image scaled to at
  most `maxScreenshotWidth` pixels with `scale` and `origin`, so a point in the
  image maps back to the global coordinates `click` takes. JPEG by default,
  because a desktop is large and the caller pays per pixel.

### custody — built

Takes a credential the owner's browser shows or downloads into an opaque
handle, or generates an SSH keypair whose private half goes straight into
one, and deposits it into strad through a write-only route. The model sees
only the handle and the value's shape. It is its own server for the reason
every hostd server is: "may mint and move my credentials" is a different
grant from "may browse as me". The key strad holds for its slug is also what
the deposit bearer is derived from.

It is also the one server that changes what the others may do. One vault is
shared by the whole daemon. While it holds a secret, shell and both
computer-use servers refuse every call, and the browser server refuses its
reads. Every result from every server passes an exact-match filter against the
held values. [Custody and deposit](/servers/hostd-custody/) has the tools, the
rules and the route.

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
- **A key per local client, on top of the key per server.**
  `capabilities.<server>.clientKeys` names further keys, one per Claude Code
  session on the machine, each opening exactly what the server's own key opens
  and nothing else. The dialog and the status page name the client, so the
  owner can see which session is asking and revoke one without the rest.
- **The extension's door is on the control port, behind a pairing token that
  never crosses the socket.** A socket there passes the loopback test, must
  carry a `chrome-extension://` Origin, is answered with the daemon's own
  HMAC proof over the extension's nonce — the extension hangs up on a
  listener that cannot produce it — and must then prove the token from
  `~/.strad-hostd/extension-token` the same way over the daemon's nonce
  before the daemon relays anything. The extension acts only on the daemon's
  request, and the daemon only asks under a live grant.

**What entitlement means here.** Adding one of these slugs to
`roles.zimmer.servers` puts it in reach of every Zimmer session, and therefore of
any prompt injection that lands in one: a web page, an email, an issue body. For
the first `local-tunnel` slug the worst case was a damaged flashcard deck. Here it
is a shell on a personal laptop, or a browser signed in to a bank. The dialog is
the last line and it is a ten-second one. Under `onTimeout: "allow"` with nobody
at the screen, it is no line.

Recommended tiering:

| Slug | Recommendation |
| --- | --- |
| `shell-*` | `admin` only. Hand it to a session explicitly when a task needs it. |
| `browser-use-*-headless` | `admin` only. `evaluate_script` in a signed-in profile reaches every account the owner is logged in to, which is arguably wider than the shell. With the extension installed there is no Chrome prompt in front of that at all. |
| `computer-use-*-headless` | `admin` only. Every app's contents, fields and buttons, in the background. |
| `computer-use-*` | `admin` only. The screen and the keyboard; a caller here is the person at the machine. |
| `custody-*` | `admin` only, and attached to a session only after a human approved the specific secrets it will capture. It is write-only into strad and create-only, but it clicks "generate" on the owner's accounts, and a prompt-injected page could steer it to mint a token with more scope than intended. |
| `imessage-*` | `admin` only, and handed to the session that sweeps it. Read-only, but every conversation the owner has had, and allowed on timeout by default, so with nobody at the screen the dialog refuses nothing. A message is also untrusted text: a sweep that reads it should not hold a tool that can send on its say-so. |

None of them is a candidate for fleet-wide entitlement today. If one is widened,
keep `onTimeout: "deny"` on that machine. The widening is the owner's decision:
this work registers nothing with `default_in_roots` and assumes no `zimmer`
entitlement.

## Local-run mode

`strad-hostd stdio shell` serves the same server over stdio. There is no daemon,
no tunnel, no key and no config file: `buildCore()` in `src/daemon.ts` assembles
the gate, the switch, the helper client and the capabilities, and `serve` and
`stdio` differ only in what they put in front of it. The test suite asserts the
tool list is identical. `stdio computer-headless` and `stdio computer` spawn the
helper as a child over stdio, from `~/.strad-hostd/bin`, the package's own
build, or PATH, and `stdio messages` does the same with `strad-hostd-messages`
— whose Full Disk Access then has to be the terminal's, the ordinary
arrangement for a command-line tool.

The consent dialog stays on by default. `--no-consent` turns it off, on the
reasoning that the person who launched the process is at the keyboard and their
MCP client already asks about each tool call. `request_control` and `grant_id`
remain, so an agent that learned the interface through strad uses it unchanged.

Two things `stdio` cannot do, and the shape that replaces it for them. The
extension connects to the daemon's control port, so a `stdio` process, which
has no listener, is always on the DevTools route. And on a Mac where the
helper runs as its own LaunchAgent, the helper honours one controller — the
daemon — so a `stdio computer-*` process is refused with `not_controller`. For
several sessions on the owner's own machine the answer is one `serve` on
loopback, reached over HTTP with a client key per session
(`strad-hostd key add`): the same daemon strad reaches through the tunnel, the
same grants, the same status page.

`hostd/README.md` is the page to point an agent at.

## What was run, and what was reasoned about

Development and CI are on Linux.

**Run here:** the consent gate and every denial path, purpose validation, grants,
the kill switch, the HTTP listener and its auth through a real MCP client, the
status page and its guards, the shell capability including process-group kills,
the tunnel supervisor against a stand-in binary, stdio mode against the built
CLI, the installer with `--no-agent`, the browser capability against a real
running Chromium discovered through `DevToolsActivePort`, the same capability
through the REAL extension loaded into a real Chromium (`--load-extension`,
which Chromium honours and branded Chrome 137+ does not): pairing over the
socket, `chrome.debugger` attaching inside the profile, every browser tool,
two sessions on two keys sharing one attachment, the kill switch taking the
debugger off every tab, a rogue listener on the daemon's port getting a
nonce and nothing else, and the CRX and update manifest served — plus the
bridge against `test/fake-extension.ts` for the refusals (wrong Origin, a
daemon that cannot prove the token, an extension that cannot, wrong path, a
malformed frame before hello, a replaced connection, a dropped one), the
client-key paths, and both computer-use
servers through a real MCP client against `test/fake-ax.ts`, a stand-in that
speaks the helper's protocol: the tree outline, actions, values, screenshots as
image content, chords, the pre-dialog refusal for a missing grant, the
owner-input rule, the banner's state and its buttons, and the helper client's
reconnect, timeout and spawn paths. The Messages server runs through a real
MCP client against `test/fake-messages.ts`, which executes the daemon's own
SQL with `node:sqlite` on a read-only connection to a fixture chat.db: the
ROWID cursor across every chat and within one, the newest-first read,
reactions, replies, edits, unsends, system rows, an `attributedBody`-only body,
attachments, a rebuilt database's warning, contact names matched from fixture
Contacts databases (and null, with a warning, when they cannot be read), the
per-server timeout rule beside
a shell that still denies, and the pre-dialog refusals for a helper that is
missing or has no Full Disk Access.

**Run on a GitHub macOS runner:** the helper compiles, signs ad-hoc, answers
`hello`, lists apps and displays, refuses every op that acts on the machine
until a controller has reported a grant that covers it, and — because the
runner image turns out to hold both grants — reads a real Accessibility tree
from Finder, captures a real screenshot, and shows and clears the banner
(`.github/workflows/hostd-ax.yml`). In the same workflow, `strad-hostd-messages`
compiles, signs ad-hoc, reads a fixture chat.db built by
`hostd/messages/fixture.swift`, decodes an `attributedBody` that
`NSArchiver` wrote, refuses writes, a second statement and ATTACH, converts a
TIFF with `sips`, refuses an attachment outside the database's directory, and
runs the daemon's own queries through it on macOS's SQLite.

**Reasoned about, not run:** everything that needs a person at a Mac. The
`osascript` dialog and whether it comes to the front when launched from a
LaunchAgent, both LaunchAgents, the installer's `cloudflared` branch, the
installer restarting the real daemon under the shell it arrived through, the
Chrome 144 toggle and its prompt on a real default profile, the extension in
Google Chrome rather than Chromium — the unpacked install and its options
page, whether developer mode keeps it installed across Chrome updates, and,
on a managed Mac, the configuration profile: the force-install from a
loopback `http://` update URL (`extension_downloader.cc` forces HTTPS for the
Web Store only), the sensitive-policy filter that blocks it on an unmanaged
one (`policy_loader_common.cc`, `policy_loader_mac.mm`), managed storage
delivering the token, and the infobar's absence for a policy-installed
extension (`debugger_api.cc`) — TCC prompts for
files under `~/Documents`, `~/Desktop` and `~/Downloads` when the shell reaches
them, the signing script's self-signed branch and whether `codesign` accepts
the certificate it makes, the two System Settings grants on a real Mac and
whether TCC attributes them to the helper under its LaunchAgent, the banner's
look on a real desktop, the global input monitor telling the
owner's keys from posted ones, and the monthly Screen Recording re-prompt.
For the Messages server: the Full Disk Access grant and whether TCC attributes
it to the helper under its LaunchAgent, the real chat.db of a current macOS
(its columns, its WAL under a running Messages, an `attributedBody`
`NSUnarchiver` refuses), attachments Messages in iCloud has offloaded, and
whether a woken Mac's catch-up lands as new ROWIDs. The
first install on the MacBook is the test of all of these.
