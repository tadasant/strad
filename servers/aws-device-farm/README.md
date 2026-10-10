# AWS Device Farm MCP server

strad's server for **driving a real iPhone**: upload a build, take a physical
device out of AWS's rack, tap and read and type on it, and pull back the video,
logs and screenshots a run records.

It exists because a class of iOS bug is only findable on real hardware — "Play
doesn't start audio on TestFlight", "the timer line doesn't move" — and every one
of those cost a round trip through a human holding a phone. This server removes
the human from that loop.

## The question this server has to answer first

> *"Why can't AWS Device Farm report back stuff like whether audio is playing,
> isn't that the whole point?"*

**It cannot, and no device cloud can.** A device farm sells the device, not the
output signal. AWS's own artifact list for a test run is "pass/fail information,
crash reports, test logs, device logs, screenshots, videos, and performance
data"; for a remote access session it is "logs and a video of the session."
Audio appears in neither, because the phones are in a rack and the sound goes to
a speaker nobody is recording. Appium's XCUITest driver does have
`mobile: startAudioRecording`, and it records the HOST MACHINE's audio input —
using it on a real phone means physically wiring the handset's output into the
Mac's microphone input, which is not a thing that exists in a Device Farm rack.
Appetize is explicit in the other direction: audio output on iOS "has since been
deprecated", audio input "is not supported on any platform."

So "is audio playing" is not a question to shop for a vendor over. The answer
that works is **instrumentation inside the app**: an `AVAudioEngine` tap or an
`MTAudioProcessingTap` reducing rendered audio to an RMS level, plus
`timeControlStatus`, `currentTime` and the `AVAudioSession` route. That turns
"can I hear it" into a NUMBER, and a number can be:

- put on screen behind a debug flag, where **`read_screen`** reads it as an
  element label and an agent asserts on it; or
- written to a customer-artifact path in an automated run, where
  **`list_run_artifacts`** hands it back as a file.

Both are one call from this server. Neither needs a microphone.

**What this server CAN assert without any app changes**, which is most of the
bug class above: that the app launched, that a screen rendered, that a button is
enabled, that tapping Play changes the button to Pause, and that a timer label
reads `0:42` and then `0:45` three seconds later. `read_screen` twice with a
pause between is how "the timer doesn't move" stops being an opinion.

## Two modes, and what each one can prove

Device Farm has exactly two programmatic ways onto a phone, and they are not
interchangeable.

| | **Automated run** (`ScheduleRun`) | **Remote access session** (`CreateRemoteAccessSession`) |
| --- | --- | --- |
| What it is | An unattended job on 1-5 devices | One physical phone, held, for up to 150 minutes |
| Who drives | A test package you upload, or Device Farm's built-in fuzzer | **You do, live, over the session's own Appium endpoint** |
| Evidence | Video, device system log, crash report, test output, screenshots, customer artifacts | The screen, the accessibility hierarchy, screenshots — and a session video in the console |
| Latency | Minutes (queue, install, run, artifacts) | Seconds per command |
| Tools here | `upload_app`, `schedule_run`, `get_run`, `list_run_artifacts`, `stop_run` | `start_device_session`, `read_screen`, `tap_screen`, `type_text`, `swipe_screen`, `take_screenshot`, `run_mobile_command`, `install_app`, `stop_device_session` |
| Can assert "audio is playing" | Only through the app's own instrumentation, written to a customer-artifact path | Only through the app's own instrumentation, read off the screen |

**The interactive mode is programmatically drivable.** A remote access session
publishes `endpoints.remoteDriverEndpoint` — a plain
HTTPS **WebDriver** URL, which AWS's own documentation demonstrates with
`curl <endpoint>/status`. Any W3C WebDriver client speaks to it; this server
speaks to it directly with `fetch`. That is what makes "an agent drives a real
iPhone" a thing you can do rather than a thing you wish for.

⚠️ **That URL is a credential.** It authorises by the opaque segment in its
PATH — no signature, no header — so anyone holding the string can drive the
phone. This server never returns it and never logs it. `start_device_session`
reports `drivable: true` instead.

## Tools

Nineteen, in three groups. The groups are about **money**, not damage: an access
key scoped to Device Farm cannot break anything else in the AWS account, and a
remote-access session bills $0.17 a minute for as long as something keeps it
alive — five idle minutes end it, 150 minutes is the cap, and an agent polling it
in a loop is what reaches the cap.

| Tool | Group | What it does |
| --- | --- | --- |
| `get_account_status` | readonly | Free-trial minutes left, unmetered slots, the metered rate. **Call it first.** |
| `list_devices` | readonly | Real iOS hardware, defaulting to free-now and remote-access capable |
| `list_device_pools` | readonly | Saved device selections a run can name |
| `list_uploads` | readonly | Builds already on Device Farm — reusing one is free |
| `get_run` | readonly | A run's status, per-device outcome, minutes and estimated cost |
| `list_run_artifacts` | readonly | Video, device log, crash report, screenshots, customer artifacts |
| `list_device_sessions` | readonly | What is running, and what it has cost |
| `stop_run` | **every group** | Stops a run, and its meter |
| `stop_device_session` | **every group** | Stops a session, and its meter |
| `upload_app` | automation, interactive | Fetches a build from an https URL, uploads it, and WAITS for Device Farm to finish checking it |
| `schedule_run` | automation | An unattended run — `BUILTIN_FUZZ` needs no test package |
| `start_device_session` | interactive | Takes a phone, installs the build, waits until it can be driven |
| `install_app` | interactive | A different build on the same phone, without paying for a second session |
| `read_screen` | interactive | The accessibility hierarchy — **the assertion channel** |
| `take_screenshot` | interactive | A PNG, returned as an image |
| `tap_screen` | interactive | By label (preferred) or by coordinate |
| `type_text` | interactive | Into a named field, or into whatever a tap focused |
| `swipe_screen` | interactive | A drag, with a duration that reads as a drag and not a flick |
| `run_mobile_command` | interactive | One Appium `mobile:` verb — home, relaunch, app state, alerts |

### Why the two `stop_` tools are in the read-only group

Because stopping can only ever REDUCE a bill. A slug that can see a runaway
session and cannot end it is the worst arrangement available here, and that is
worth one deliberate exception to "read-only means no writes."

### What is deliberately absent

Nothing here creates or deletes a project, deletes a run or an upload, or
purchases an unmetered device slot — the last one is a **$250/month** decision
that is one API call away and no agent is going to make it.
`test/tools.test.ts` asserts that no tool name mentions any of them, and
`test/client.test.ts` asserts the same of the sixteen SDK calls underneath.

## The two coordinate systems, which is the trap

`read_screen` reports **points**: the logical coordinates XCUITest uses, and what
`tap_screen` and `swipe_screen` take. A screenshot of the same phone is two or
three times larger in each direction. A coordinate read off the IMAGE lands near
the top-left of what was aimed at, the tap does nothing visible, and the failure
looks like the app ignoring input. Every tool description that takes a coordinate
says so; use an element's `center` from `read_screen`, or its `label`.

## Getting a Motet build onto a phone

**A TestFlight build is not directly usable**, because TestFlight is a
distribution channel and not a file you can fetch. What Device Farm needs is an
`.ipa`, reachable at an https URL that strad's container can read without a
login, whose `Info.plist` has `CFBundleSupportedPlatforms = ["iPhoneOS"]`. A
**simulator** build is the most common rejection and it fails asynchronously —
`CreateUpload` succeeds, the PUT succeeds, and the upload goes to FAILED minutes
later with `IOS_APP_WRONG_PLATFORM_DEVICE_VALUE` in a field nobody reads. That is
why `upload_app` waits and reports Device Farm's own message as an error.

**Device Farm re-signs the app** on public devices, replacing the embedded
provisioning profile with a wildcard one. Re-signing STRIPS these entitlements:
App Group, Associated Domains, Game Center, HealthKit, HomeKit, Wireless
Accessory Configuration, In-App Purchase, Inter-App Audio, Apple Pay, **Push
Notifications**, and VPN Configuration & Control. An app that depends on one of
those behaves differently here than it does on a real user's phone, and that is a
property of the platform rather than of this server.

`docs/servers/aws-device-farm-setup` has what a CI job has to produce, and the
whole first-time setup.

## Credentials

Five environment variables; three are required.

| Variable | What it is |
| --- | --- |
| `AWS_DEVICE_FARM_ACCESS_KEY_ID` | An IAM access key id, for a user whose only policy is the Device Farm actions these tools call |
| `AWS_DEVICE_FARM_SECRET_ACCESS_KEY` | Its secret. **Secret**, never logged, never returned |
| `AWS_DEVICE_FARM_PROJECT_ARN` | The Device Farm project this mount works in |
| `AWS_DEVICE_FARM_REGION` | `us-west-2`, and only that. Optional; it is the default |
| `AWS_DEVICE_FARM_MAX_UPLOAD_MB` | How much of a build this server will hold in memory. Optional; 192 by default |

**The credential is read under names of its own, and the AWS default credential
chain is never consulted.** The SDK would happily read `AWS_ACCESS_KEY_ID` out of
the process environment, and this server shares a process with twenty-seven others;
a stray AWS variable that arrived for some other reason must not become the
identity that spends device minutes.

**The region is a closed set of one.** Device Farm's device cloud is served from
`us-west-2` and nowhere else — the AWS general reference lists exactly one
endpoint. Setting anything else is not choosing a nearer rack, it is choosing a
hostname that does not answer, so the value is validated against a constant here.

Put the values straight into the secret store through the console at
`/ui/secrets`. Do not paste them into a commit, an issue, a PR, a chat message or
a log line.

## What a minute costs

$0.17 per device-minute, metered, for both modes; the first **1,000 device
minutes are free**, once, and do not renew. The alternative is an unmetered slot
at **$250/month per concurrent device**, and automation slots and remote-access
slots are bought SEPARATELY — so "interactive AND real-device CI" unmetered is
$500/month. The crossover is around 24 hours of device time a month.
`get_account_status` is the only thing that says which of those an account is on,
which is why every result that can report `deviceMinutes` does, with an estimate
and the basis of it.

Default concurrency is **two** metered remote-access devices and five metered
automation devices. The usual cause of hitting either is a session nobody
stopped.

## strad bundle mount

The bundle host mounts this server at `/aws-device-farm` from
`servers/aws-device-farm/shared/build/index.js`. It mounts **even with no
credentials**, marked `degraded` on `/healthz`: the tool surface still lists, so
the console and an agent can see what the deployment would offer, and every call
fails with an error naming the variables. One server's missing config must not
cost the other twenty-seven their boot.

**The mount holds state, and that is why it is built once.** It keeps one
WebDriver session per live phone, because establishing one RELAUNCHES the app —
so a mount rebuilt per request would turn a sequence of taps into a sequence of
cold starts. strad builds a fresh MCP `Server` per request; the pool lives in the
closure the factory returns.

**There is no slug yet, in any environment.** `infra/strad.staging.yaml` names no
`aws-device-farm` server, deliberately: an unresolved `${NAME}` fails the RENDER,
and the render is the whole spec, so an entry that ships before its secret is
seeded takes every other server's deploy down with it. The block to paste once
the credential exists is in `docs/servers/aws-device-farm-setup`.

## Tests

```
cd servers/aws-device-farm && npm test
```

The suite runs under Vitest against the TypeScript sources, on every PR, in the
`servers (aws-device-farm)` CI job. **No AWS account, no network, no live
device.** Every seam is an injected interface, so the fakes are plain objects:

- the **SDK seam** is a `send` function, so the suite asserts the inputs this
  server builds against the REAL `@aws-sdk/client-device-farm` command classes —
  a renamed field fails in CI rather than in production;
- the **HTTP seam** is a `fetch`, which covers both the build download and the
  phone's WebDriver endpoint.

What the suite is really about: that a simulator `.ipa` is reported with Device
Farm's own message rather than as a successful upload, that an oversized download
is abandoned mid-flight rather than absorbed, that the Appium endpoint never
appears in a result or a log line, that a stale WebDriver handle is
re-established exactly once, that two running sessions are an error rather than a
coin toss, that a label containing a quote does not break the predicate it is
compiled into, and that a `mobile:` escape hatch cannot reach anything outside
that namespace.

Every identifier in the fixtures is invented. No real AWS account, project,
device or session appears in this repo.

## Not verified against a live account

This server has never made a real Device Farm call: there is no AWS account yet.
Everything above is built from AWS's published API and documented behaviour, and
the first live call is the last step of
`docs/servers/aws-device-farm-setup`. What that step will settle, in order of how
likely it is to bite:

1. whether the Appium endpoint accepts a session created with `platformName:
   iOS` and no other capabilities, which is what this server sends;
2. whether the iOS predicate `hasKeyboardFocus == 1` names the field a tap just
   focused on a real device;
3. how long a session really takes to become drivable, which decides whether
   `start_device_session`'s 180-second default wait is generous or tight;
4. whether `"2"` is the right `appium:version` to default on iOS 27 and later,
   where Device Farm requires one — the SDK documents "2 or 3" and says the
   service may reject a version the device does not have.
