# strad-hostd

MCP servers that operate the machine they run on.

| Server              | Tools                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell`             | `run_command`, `get_command`, `list_commands`, `kill_command`                                                                                         |
| `browser`           | `list_tabs`, `open_tab`, `navigate_tab`, `read_page`, `click_element`, `type_text`, `evaluate_script`, `take_screenshot`, `activate_tab`, `close_tab` |
| `computer-headless` | `list_apps`, `read_ui_tree`, `find_elements`, `get_element`, `perform_action`, `set_value`, `read_text`                                               |
| `computer`          | `take_screenshot`, `list_displays`, `click`, `move_mouse`, `drag`, `scroll`, `type_text`, `press_keys`                                                |
| `messages`          | `imessage_list_chats`, `imessage_get_messages`, `imessage_get_attachment`                                                                             |
| `custody`           | `list_tabs`, `click_and_capture`, `capture_download`, `release_tab`, `generate_keypair`, `list_handles`, `discard_handle`, `deposit`                  |

The two `computer-*` servers are macOS only and need the native helper below.
`computer-headless` works through the Accessibility tree and never touches the
mouse. `computer` takes the real mouse and keyboard, and the first key or click
from the person at the machine ends its grant.

`messages` is macOS only too, read-only, and needs its own helper below: it
reads the Messages database (`~/Library/Messages/chat.db`), which macOS guards
with Full Disk Access. It cannot send.

`custody` is opt-in: `init` and the installer leave it off, and
`strad-hostd add custody` turns it on. It captures a credential the browser
shows or downloads into a handle, never returning the value, and deposits it
into strad: this machine's own by default, or another strad the config names
under `custody.destinations` (`strad-hostd destination add`), or, through
that strad, a deposit store it names for this machine (`store` + `target`:
Zimmer's parameter store, a deploy workflow's Secret Manager). While it holds one, the shell and computer-use servers refuse every
call and the browser server refuses its reads. That is enforced here, in
`src/custody/enforce.ts`, and every result from every server is checked for a
held value before it leaves. See
`docs/src/content/docs/servers/hostd-custody.md`.

Every server also has `request_control`, `end_control` and `get_control_status`.
`request_control` takes a purpose of at most two sentences and returns a
`grant_id`, which every other tool requires.

The audit log (`~/.strad-hostd/audit.jsonl`), the status page and the
notifications never hold a custody value or one of the daemon's own keys:
those are replaced exactly, and the rest is scrubbed by shape. The first start of
a daemon with this redaction rewrites what an older one left on disk, once
(`src/redact.ts`, `src/at-rest.ts`).

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
claude mcp add hostd-shell    -- node "$PWD/build/cli.js" stdio shell --no-consent
claude mcp add hostd-browser  -- node "$PWD/build/cli.js" stdio browser --no-consent
# macOS, after "The native helper" below:
claude mcp add hostd-computer-headless -- node "$PWD/build/cli.js" stdio computer-headless --no-consent
claude mcp add hostd-computer          -- node "$PWD/build/cli.js" stdio computer --no-consent
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

Without the flag, `request_control` puts a dialog on the screen and waits ten
seconds, and an unanswered dialog is a denial. That is the right default for a
server reached over a network. Run locally, the person who started the process is
at the keyboard and their MCP client already asks about each tool call, so the
flag drops the second dialog. The `serve` command refuses to run without the
dialog; the flag exists for stdio only.

The dialog is an `NSAlert` shown through `osascript`, on macOS only. Only a
click answers it (an Accessibility press, such as VoiceOver's, still does):
Return, Escape, Space and Tab do nothing, so typing
that lands on it is swallowed rather than taken as a decision. If the dialog
cannot be built that way, it is not shown and the request is denied as
`no_display`; the daemon's log has a `[consent]` line saying why. Other
platforms have no dialog whose keys can be switched off, so every request there
is denied as `no_display`; use `--no-consent` over stdio.

The dialog has three buttons: **Allow**, **Reject**, and **Disallow and cool
down**. Reject refuses one request and the next gets a fresh dialog, as does an
unanswered one. A server is refused as `cooldown`, with no dialog, for
`consent.rejectCooldownSeconds` only after you kill one of its grants (status
page, `strad-hostd kill`, the banner) or pick Disallow and cool down. The kill
switch starts none: it refuses everything until you turn it back on.

### The browser server

It drives the Chrome that is already running, with its real profile. There are
two ways in, and the daemon picks the first that is there:

1. **The bridge extension** (`extension/`), installed in that Chrome. It
   connects out to the daemon and attaches `chrome.debugger` to tabs on the
   daemon's request. No prompt from Chrome, so this is the route for a machine
   with nobody at the keyboard. It needs the daemon (`serve`), not `stdio`:
   the extension connects to the daemon's control port.
2. **DevTools**, when no extension is connected. In Chrome, open
   `chrome://inspect/#remote-debugging` and turn remote debugging on (Chrome
   144 or newer). Chrome asks "Allow remote debugging?" every time the daemon
   connects, and only a person can answer. Launching Chrome with
   `--remote-debugging-port` does not work for the default profile: Chrome has
   ignored the flag there since version 136.

To point the DevTools route at a different Chrome, write
`~/.strad-hostd/config.json`:

```json
{ "browser": { "cdpUrl": "http://127.0.0.1:9222" } }
```

or `{ "browser": { "userDataDir": "/path/to/profile" } }`.

`read_page` and `evaluate_script` redact token-shaped values (`ghp_…`, `sk-…`,
64-hex tokens, DSNs, PEM blocks, long random base64) to `[redacted:token]`
before they leave the machine, and refuse text, html and scripts on credential
pages. `"browser": { "credentialPages": ["https://ci.example/keys*"] }`
replaces the default list of those pages; `src/browser/redact.ts` has both.

#### Installing the extension

`strad-hostd extension` prints everything below for your machine, with the
real paths and the pairing token. The daemon must be running.

**Load it unpacked.** `chrome://extensions` › Developer mode › Load
unpacked › the `extension/` directory (in an install,
`~/.strad-hostd/app/extension`). Then Details › Extension options, and paste
the daemon URL and the token. It stays installed while developer mode stays
on. Each attach puts a "started debugging this browser" bar on the tab;
launching Chrome with `--silent-debugger-extension-api` hides it.

**A configuration profile, on a managed Mac only.** The command also writes
`~/.strad-hostd/strad-hostd-extension.mobileconfig`, which force-installs the
extension from the daemon (a signed CRX and an update manifest on
`http://127.0.0.1:7312/extension/…`, loopback only) and hands it the daemon
URL and the token as managed storage. Chrome honours a force-install from
outside the Web Store only on a Mac it considers managed — MDM-enrolled or
domain-bound; on a personal Mac the entry is filtered as a sensitive policy
and `chrome://policy` shows it `[BLOCKED]`. Where it applies, the extension
cannot be switched off from `chrome://extensions` and attaches with no
"started debugging" bar. The profile holds the token, readable by every user
of the Mac. When `extension/manifest.json` changes, bump its `version`: that
is what Chrome compares to decide whether to fetch the new copy.

**A password manager's overlay.** Chrome will not let an extension debug a
tab that holds another extension's frame. When it refuses, the bridge
(`scripting` permission, `<all_urls>` host access) takes those frames out of
the page while it is attached and puts them back after. It never enters them.
Those two permissions came with version 0.2.0: an unpacked copy needs Reload on
`chrome://extensions` to pick them up.

The status page (`http://127.0.0.1:7312`) and `strad-hostd status` say whether
the extension is connected. `get_control_status` on the browser server reports
`browser: {extension, via}`.

**What this hands over.** With the extension installed, every account that
Chrome is signed in to can be driven by anything holding a browser key that
gets past the consent dialog — and for unattended use the dialog is set to
allow when nobody answers. A prompt injection in one agent's page reaches all
of those accounts. The daemon's own boundaries remain: a key per server, a
grant per task, the audit log, and the kill switch, which also detaches the
debugger from every tab. Nothing in Chrome asks any more.

### Several sessions on this machine, unattended

Run the daemon locally and give each MCP client its own key, instead of one
`stdio` process per client. `stdio` cannot use the extension, and on a Mac with
the helper's LaunchAgent installed a `stdio computer-*` process cannot reach
the helper either (it honours one controller, and that is the daemon).

```bash
node build/cli.js init --machine "My Mac" --suffix mbp   # once
node build/cli.js serve                                  # or the LaunchAgent, below
node build/cli.js key add browser claude-1               # one per session
claude mcp add --transport http hostd-browser http://127.0.0.1:7311/browser/mcp \
  --header "Authorization: Bearer <the key it printed>"
```

`key add` works while the daemon runs and prints the `claude mcp add` line.
The same for `shell`, `computer-headless` and `computer`. The dialog and the
status page show the client's name next to the server's, and `key revoke`
drops one key without touching the others. Sessions get independent grants;
a tab one grant opened is not closable by another.

For nobody-at-the-keyboard use, in `~/.strad-hostd/config.json`:

```json
{ "consent": { "onTimeout": "allow", "windowSeconds": 3 } }
```

An unanswered dialog is then allowed, after the shortest window the daemon
accepts. That is the unattended configuration, and it is the whole of what the
dialog protects: with nobody there, nothing is refused. The default stays
`deny`.

### The native helper (macOS): `strad-hostd-ax`

The two `computer-*` servers drive the Mac through a small Swift program in
`ax/`. It is what macOS grants Accessibility and Screen Recording to, and it
draws the banner that says a caller is in control. Build it once, on the Mac,
with the Command Line Tools (`xcode-select --install`):

```bash
cd ax && swift build -c release && cd ..
./install/sign-helper.sh ax/.build/release/strad-hostd-ax
```

The second line signs it with a stable identity (a Developer ID certificate if
the keychain has one, else a self-signed one it creates, which asks for your
login password once). macOS keys its permission grants on the signature, so an
unsigned or ad-hoc-signed build has to be re-granted after every rebuild.

Then grant it, once, in System Settings › Privacy & Security:

- **Accessibility** — both servers. `node build/cli.js helper --request-access` makes macOS prompt for it.
- **Screen & System Audio Recording** — `computer` only, for `take_screenshot`.

`node build/cli.js helper` says whether the helper is reachable and what it
holds. In this local mode the daemon spawns the helper as a child and macOS
attributes the grants to whatever launched your MCP client (your terminal, as
for any command-line tool); the LaunchAgent arrangement the strad install uses
is in `docs/src/content/docs/servers/hostd.md`.

On macOS 15 the system asks again, about monthly, whether the helper may keep
recording the screen. That is macOS's rule for every capture that skips its
picker, and there is no setting for it.

While a grant is live the helper shows a banner at the top of the screen and a
menu-bar item, each with a Kill button (and, except on the banner's sliver, a
Disable button). A foreground (`computer`) grant is red and ends on your first
key or click. The banner has three sizes —
a sliver with a count and Kill, a compact strip with each grant's server,
claimed session, purpose and current call, and a details view adding timing,
commands left running and the last five calls — and **Minimize** puts it away
into the menu bar entirely (**Show banner** in the menu brings it back). It
remembers the pick (`defaults read strad-hostd-ax bannerMode`: `menubar`,
`sliver`, `compact` or `expanded`). The menu-bar icon animates while a call or
a command a call started is running, and holds still otherwise — not under
Reduce motion, unless `defaults write strad-hostd-ax statusIconAnimation
always` (or `never`) says otherwise. Call text is scrubbed of
obvious secrets before it is drawn, and typed text is shown only as its length.

The icon is a status item named `strad-hostd`, owned by `com.strad.hostd-ax`
(the bundle identifier linked into the binary from `ax/Info.plist`), so macOS
and a menu-bar manager remember where you put it and whether it is shown,
across every restart of the helper. To keep it in view: turn
**strad-hostd-ax** on under System Settings › Menu Bar › **Allow in the Menu
Bar**, ⌘-drag it toward the right end of the menu bar, past the notch, and in
Bartender (or Ice) move it to the always-shown section. Neither the helper nor strad can override a hide you set there.

### The Messages helper (macOS): `strad-hostd-messages`

The `messages` server reads iMessage and SMS history through a second small
Swift program in `messages/`, the one process here that holds Full Disk
Access. Build and sign it the same way, under its own identifier:

```bash
cd messages && swift build -c release && cd ..
./install/sign-helper.sh messages/.build/release/strad-hostd-messages --identifier com.strad.hostd-messages
```

Then give it Full Disk Access in System Settings › Privacy & Security (in this
local mode, the grant has to be on whatever launched your MCP client, as for
the other helper). `node build/cli.js messages` says whether it can read the
database, and `--grant` opens the list. It opens the database read-only and
refuses any statement that is not; it never sends, and reading marks nothing
as read. `imessage_get_messages` pages by `after_rowid`, an exact cursor.
Senders and chat participants come with the name your Contacts give them
(`sender_name`, a participant's `name`), read from Contacts' own files under
`~/Library/Application Support/AddressBook` with the same Full Disk Access, so
there is no Contacts prompt; `null` when no contact matches.

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

| Field                                                      | Default             |                                                                        |
| ---------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `consent.onTimeout`                                        | `"deny"`            | what an unanswered dialog means. `"allow"` makes it a veto window      |
| `consent.windowSeconds`                                    | `10`                | how long the dialog stays up (3 is the minimum)                        |
| `consent.rejectCooldownSeconds`                            | `60`                | how long a server is held off after a Kill or "Disallow and cool down" |
| `capabilities.<server>.clientKeys`                         | `{}`                | named extra keys for that server; `strad-hostd key add` writes it      |
| `consent.grantMinutes` / `maxGrantMinutes` / `idleMinutes` | `30` / `120` / `10` | grant lifetime                                                         |
| `shell.defaultCwd`                                         | `$HOME`             |                                                                        |
| `native.mode`                                              | `"auto"`            | `socket` (the LaunchAgent, never a child), `stdio`, or `auto`          |
| `native.binary` / `native.socketPath`                      | see `src/config.ts` | where `strad-hostd-ax` is, or where its LaunchAgent listens            |
| `capabilities.<server>.onTimeout`                          | unset               | that server's own `consent.onTimeout`; `add messages` sets `allow`     |
| `messages.binary` / `messages.socketPath`                  | see `src/config.ts` | where `strad-hostd-messages` is, or where its LaunchAgent listens      |
| `messages.maxAttachmentBytes`                              | `10485760`          | largest attachment returned, after conversion                          |
| `computer.maxScreenshotWidth`                              | `1280`              | widest image `take_screenshot` returns                                 |
| `custody.stradUrl`                                         | unset               | the strad deployment `deposit` posts to; https, or http on loopback    |
| `custody.stradName`                                        | `"default"`         | the name the `stradUrl` destination also answers to, e.g. `"mine"`     |
| `custody.destinations`                                     | `{}`                | other strads `deposit` may name, each `{url, key, title?}`             |
| `custody.downloadsDir`                                     | `~/Downloads`       | where `capture_download` looks for the new file                        |
| `custody.handleMinutes`                                    | `15`                | how long a captured secret is held undeposited                         |
| `port` / `controlPort`                                     | `7311` / `7312`     | daemon mode only, both on `127.0.0.1`                                  |

`STRAD_HOSTD_HOME` moves the state directory.

## Development

```bash
npm test   # tsc, then vitest
```

The browser suite drives a real Chrome or Chromium. It looks at
`$HOSTD_TEST_CHROME`, Playwright's cache, then the usual system paths. With none
it skips locally and fails under `CI`. `test/extension.test.ts` loads the real
extension into that Chromium (`--load-extension`, which branded Chrome 137+
ignores and Chromium honours) and drives every browser tool through it;
`test/bridge.test.ts` runs the same daemon against `test/fake-extension.ts`, a
stand-in that speaks the extension's protocol. The force-install profile,
managed storage and the infobar's absence run only on a Mac.

The computer-use servers are tested against `test/fake-ax.ts`, a stand-in that
speaks the helper's protocol in-process, so every daemon-side path runs on
Linux. The Swift helper itself is built and smoke-tested over stdio on a
GitHub macOS runner (`.github/workflows/hostd-ax.yml`), which holds no
permission grants: reading a real tree, a real screenshot and the banner under
a real grant run only on a Mac whose owner has granted them. The other macOS
halves (the `osascript` dialog and its mouse-only buttons, the real LaunchAgents, the installer's `cloudflared`
branch, the signing script) are not exercised by any suite.

The Messages server is tested against `test/fake-messages.ts`, which runs the
daemon's own SQL with `node:sqlite` against a fixture chat.db. The same
workflow builds `strad-hostd-messages`, reads a fixture database made by
`messages/fixture.swift` (with an `attributedBody` NSArchiver wrote), and runs
the daemon's queries through it (`messages/smoke.mjs`), including its
Contacts read against a fixture AddressBook directory. Reading the real
database and the real Contacts under a real Full Disk Access grant runs only on
the owner's Mac.
