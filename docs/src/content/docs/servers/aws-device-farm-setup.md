---
title: AWS Device Farm — first-time setup
description: The human-owned steps that turn the shipped aws-device-farm server into a working slug — the AWS account, the project, a least-privilege IAM policy, where the secrets go, how a Motet build reaches a phone, and what it costs.
---

The [`aws-device-farm` server](/servers/aws-device-farm/) is built, tested and
baked into the bundle image. **It has never made a live AWS call**, because there
is no AWS account yet. This page is the rest: the steps a person has to do, in
order, and the exact text to paste at each one.

Nothing here is automatable. Provisioning a vendor account and minting a first
API key is a human-owned boundary, and an agent never holds a secret value — it
places the name and a person places the value in the console.

**Steps 1-5 are yours.** Step 6 is a handoff back to agents, one session per
repository, and step 7 is the first real call.

---

## 1. Create the AWS account, in the region that matters

Any AWS account will do, including a brand-new one. What is NOT free to get
wrong is the region.

**Device Farm's device cloud lives in `us-west-2` (Oregon) and nowhere else.**
The AWS general reference lists exactly one service endpoint,
`devicefarm.us-west-2.amazonaws.com`. That is not a latency preference: the
devices are physical phones in one building. Do everything below with the console
region switcher on **US West (Oregon)**, or you will create a project you cannot
find and the server will refuse the region with an error saying this.

The server defaults to `us-west-2` and validates any value it is given against a
constant, so the only way to get this wrong is to create the *project* somewhere
else — which the console will not let you do, because Device Farm does not appear
in other regions' consoles.

**Billing:** the first **1,000 device minutes are free**, once, and do not renew.
After that it is metered — see [step 7's costs](#7-what-this-will-cost). Add a
payment method now; the free trial does not need one, and discovering it does at
the moment an agent is mid-verification is worse.

---

## 2. Create the Device Farm project, and copy its ARN

In the console: **Device Farm → Mobile device testing → Projects → Create
project**. Name it something you will recognise in a bill — `motet` is fine.

Then copy its **ARN**. It is on the project's *Project settings* page, and it
looks like:

```
arn:aws:devicefarm:us-west-2:111122223333:project:11111111-2222-3333-4444-555555555555
```

The project **name** and the console **URL** are not the ARN, and the server
refuses both by name if one is pasted in. That ARN is the value of
`AWS_DEVICE_FARM_PROJECT_ARN` in step 4.

While you are there, note the two default quotas, because both are lower than
people expect and both are adjustable by support request:

- **2** concurrent metered devices for remote access (the interactive mode)
- **5** concurrent metered devices for automation runs

---

## 3. A least-privilege IAM user, and its access key

Create an IAM **user** (not a role — strad holds a static key), with **no**
console access and **no** other policy attached.

### The policy

These are exactly the eighteen Device Farm actions the server's tools call, and
nothing else. It can list devices, upload a build, run it, hold a phone and stop
either — and it cannot create or delete a project, delete a run, or **purchase an
unmetered device slot**, which is a $250/month decision.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StradDeviceFarmDriveAPhone",
      "Effect": "Allow",
      "Action": [
        "devicefarm:GetAccountSettings",
        "devicefarm:ListDevices",
        "devicefarm:ListDevicePools",
        "devicefarm:ListUploads",
        "devicefarm:CreateUpload",
        "devicefarm:GetUpload",
        "devicefarm:ScheduleRun",
        "devicefarm:GetRun",
        "devicefarm:StopRun",
        "devicefarm:ListJobs",
        "devicefarm:ListSuites",
        "devicefarm:ListTests",
        "devicefarm:ListArtifacts",
        "devicefarm:CreateRemoteAccessSession",
        "devicefarm:GetRemoteAccessSession",
        "devicefarm:ListRemoteAccessSessions",
        "devicefarm:StopRemoteAccessSession",
        "devicefarm:InstallToRemoteAccessSession"
      ],
      "Resource": "*"
    }
  ]
}
```

**On `"Resource": "*"`.** Device Farm's resource-level permission support is
uneven — `ListDevices` and `GetAccountSettings` are account-wide by nature, and
the project-scoped actions are documented inconsistently. The tightening is
genuine in the *action* dimension, which is the one that matters here: this key
cannot reach any other AWS service, and within Device Farm it cannot do anything
destructive or billable-by-subscription. If you want to try narrowing further,
split the project-scoped actions into a second statement with
`"Resource": ["<project ARN>", "<project ARN>/*"]` and **verify step 7 still
passes** — a wrongly-narrowed policy fails as an `AccessDeniedException` naming
the action it refused, which the server surfaces verbatim.

### The key

**Security credentials → Create access key → Application running outside AWS.**
You get an access key id (`AKIA…`) and a secret, once. Do not put either in a
commit, an issue, a PR, a chat message, or a message to an agent. The next step
is where they go.

---

## 4. Place the secrets in the store — a console step, by you

An agent never holds these values. You place them through strad's console, which
writes them to Google Parameter Manager; the gateway resolves them at runtime.

**Production** — <https://strad.tadasant.com/ui/secrets>, store switcher on
**strad production**, namespace:

```
/strad/prod/mcp/aws-device-farm/static/
```

**Staging** — <https://staging.strad.tadasant.com/ui/secrets>, store switcher on
**strad staging**, namespace:

```
/strad/staging/mcp/aws-device-farm/static/
```

Three names in each environment you set up (do both only if you want the server
in both; one is enough to start, and staging is the cheaper place to break
things):

| Name | Kind | Value |
| --- | --- | --- |
| `AWS_DEVICE_FARM_ACCESS_KEY_ID` | secret | the `AKIA…` id from step 3 |
| `AWS_DEVICE_FARM_SECRET_ACCESS_KEY` | secret | its secret |
| `AWS_DEVICE_FARM_PROJECT_ARN` | plain | the project ARN from step 2 |

The project ARN is not a secret and is stored beside the others anyway, so one
namespace holds the whole configuration of the mount.

:::note
Use the **same AWS account for staging and prod if you like** — Device Farm has
no notion of environments, and the blast radius of this key is "device minutes",
not data. A second account buys a second free trial and a cleaner bill, and
nothing else.
:::

---

## 5. How a Motet build actually reaches a phone

This is the step most likely to bite, and **it needs a change in
`tadasant/motet` that this PR does not make.**

### What Device Farm needs

An `.ipa`, at an **https URL strad's container can fetch without a login**, whose
`Info.plist` has `CFBundleSupportedPlatforms = ["iPhoneOS"]`.

### What a TestFlight build is

Not that. **TestFlight is a distribution channel, not a file you can fetch** —
there is no URL that hands back the binary, and App Store Connect's API does not
serve one either. The build that goes to TestFlight and the build that goes to
Device Farm are the same archive exported twice.

### What Motet's CI has to produce

In the workflow that already builds the iOS app, after the archive step:

1. **Export a second `.ipa` for a device**, ad-hoc or development — not a
   simulator build. A simulator build is the single most common Device Farm
   rejection, and it fails *asynchronously*: the upload succeeds, then goes to
   FAILED minutes later with `IOS_APP_WRONG_PLATFORM_DEVICE_VALUE`.
2. **Publish it somewhere strad can read without credentials.** Two options that
   work today:
   - strad's own artifact store — the `remote-filesystem-tmp-public` server
     returns a pre-signed link, which `upload_app` takes directly; or
   - a GCS object with a signed URL, which the Motet infrastructure already knows
     how to make.
   A GitHub Actions artifact is **not** an option: fetching one needs the GitHub
   API and a token, and `upload_app` refuses anything that is not a plain https
   URL it can GET.
3. **Record the URL where an agent can find it** — a job summary, a PR comment,
   or a fixed path in the artifact store. An agent that cannot find the build
   cannot use any of this.

### What re-signing costs you, whichever route

Device Farm **re-signs** the app on public devices, replacing the embedded
provisioning profile with a wildcard one. Re-signing **strips** these
entitlements: App Group, Associated Domains, Game Center, HealthKit, HomeKit,
Wireless Accessory Configuration, In-App Purchase, Inter-App Audio, Apple Pay,
**Push Notifications**, and VPN Configuration & Control.

For Motet that means **push notifications and universal links do not work on a
Device Farm phone**, and an agent must not report them as broken from there.
Everything else — audio playback, the timer, Gmail sync, episode generation —
is unaffected.

### And the thing a device farm cannot do

**There is no audio.** Device Farm records video without sound, in both modes, and
so does every competitor — see
[the server page](/servers/aws-device-farm/#what-a-device-farm-can-and-cannot-prove)
for why, and for the two ways an app's own instrumentation makes playback
assertable anyway. If Motet gains a debug-flagged RMS/`timeControlStatus`
readout on screen, `read_screen` asserts on it with no further work here.

---

## 6. What is left after the credential exists

Four numbered steps, in order. The first is in this repository; the next two are
other agent roots' files and are **out of scope for the session that built this
server**.

### 6.1 — strad staging config (`tadasant/strad`, this repo)

Paste this into `infra/strad.staging.yaml`, in the `servers:` list beside the
other `supplementary-image` entries:

```yaml
  # AWS Device Farm: a REAL iPhone, driven live over the remote-access session's
  # own Appium endpoint. strad's own server — servers/aws-device-farm.
  #
  # THIS SPENDS MONEY BY THE MINUTE. A remote-access session bills $0.17/device-
  # minute for up to 150 of them, so `aws-device-farm-ro` is the tier to hand
  # out: it can see everything, cost nothing, and STOP anything that is running.
  # The stop tools are in the read-only allow-list deliberately — stopping only
  # ever reduces a bill.
  - slug: aws-device-farm-ro
    kind: supplementary-image
    title: AWS Device Farm (read-only)
    description: See devices, runs, sessions and artifacts. Cannot start a device or a run; can stop one.
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /aws-device-farm
    entitlements: [admin]
    env:
      AWS_DEVICE_FARM_ACCESS_KEY_ID: "${AWS_DEVICE_FARM_ACCESS_KEY_ID}"
      AWS_DEVICE_FARM_SECRET_ACCESS_KEY: "${AWS_DEVICE_FARM_SECRET_ACCESS_KEY}"
      AWS_DEVICE_FARM_PROJECT_ARN: "${AWS_DEVICE_FARM_PROJECT_ARN}"
    tools:
      allow:
        - get_account_status
        - list_devices
        - list_device_pools
        - list_uploads
        - get_run
        - list_run_artifacts
        - list_device_sessions
        - stop_run
        - stop_device_session

  # The full surface: upload a build, hold a phone, drive it. Nineteen tools.
  - slug: aws-device-farm
    kind: supplementary-image
    title: AWS Device Farm
    description: Put a build on a real iPhone and drive it — tap, read the screen, type, and pull back video and logs.
    image: ghcr.io/tadasant/strad-bundle:latest
    bundle: bundle
    path: /aws-device-farm
    entitlements: [admin]
    env:
      AWS_DEVICE_FARM_ACCESS_KEY_ID: "${AWS_DEVICE_FARM_ACCESS_KEY_ID}"
      AWS_DEVICE_FARM_SECRET_ACCESS_KEY: "${AWS_DEVICE_FARM_SECRET_ACCESS_KEY}"
      AWS_DEVICE_FARM_PROJECT_ARN: "${AWS_DEVICE_FARM_PROJECT_ARN}"
    # No `tools:` — all nineteen.
```

Two other files move with it, and CI fails without them:

- `test/staging-config.test.ts` — add `aws-device-farm-ro: 9` to the allow-list
  count map, `aws-device-farm` to the no-policy list, and the three variable
  names to `PROVISIONED_STATICS`.
- Nothing else. The mount already exists in the image; the slug is the only new
  thing.

**Do not paste this before the secrets are seeded.** An unresolved `${NAME}`
fails the render, and the render is the WHOLE spec — a slug that ships early
takes every other server's deploy down with it.

### 6.2 — strad production config (`strad-production` root)

The same two entries in `tadasant-internal`'s `strad/infra/strad.prod.yaml`, with
prod's namespace, plus the **two-directional `zimmer` entitlement** so Zimmer
sessions can reach it:

- on the server entry: `entitlements: [admin, zimmer]`
- in the `roles:` block: add `aws-device-farm` (and/or `aws-device-farm-ro`) to
  the `zimmer:` role's `servers:` list

Both halves are required. A slug that names `zimmer` in its entitlements but is
not listed in the role is unreachable, and so is the reverse.

### 6.3 — the AIR catalog entry (`artifacts` root)

`artifacts/mcp.json` in `tadasant-internal` needs an entry so Zimmer sessions can
be given the server. It is greenfield: as of 2026-09-20 there is no AWS or Device
Farm entry among its ninety. The entry needs the slug, a description an
orchestrator can route on ("drive a real iOS device"), and the read-only variant
marked as the default tier — the full one costs money per minute and should be
opt-in.

### 6.4 — the first live call

Once a slug is deployed, from an agent session that has it:

```
get_account_status
```

Expect `free_trial_minutes_remaining` near 1000 and
`unmetered_remote_access_slots: {"IOS": 0}`. That one call proves the key, the
policy, the region and the project ARN in one go — and costs nothing.

Then, and only then:

```
list_devices                              → pick an iPhone ARN
upload_app(source_url, name: "…​.ipa")     → wait for SUCCEEDED
start_device_session(device_arn, app_arn) → wait for drivable: true
read_screen                               → the app's first screen
stop_device_session                       → STOP IT. It bills until you do.
```

Budget about 10 free minutes for that, and check `list_device_sessions` afterwards
to be sure nothing is still running.

---

## 7. What this will cost

These numbers are from the comparison in
[Zimmer session #19242](https://zimmer.tadasant.com/sessions/19242), which chose
Device Farm over Appetize; they are not re-derived here.

The mental model to adjust: **you are not renting a device, you are buying
device-minutes of session time**, and an agent's actual session time is far below
wall-clock.

| Usage | Metered at $0.17/min | Verdict |
| --- | --- | --- |
| 5 days × 24h literal (7,200 min) | **$1,224** | never do this — buy the slot |
| 5 days × 8h active (2,400 min) | **$408** | buy the slot |
| **Break-even: ~1,470 min ≈ 24.5 h/mo** | **$250** | the crossover |
| 5 days × 4h active (1,200 min) | **$204** | stay metered |
| Bursty: 20 sessions × 10 min × 5 days (1,000 min) | **$170** | stay metered |

The unmetered alternative is **$250/slot/month** for unlimited minutes on one
concurrent iOS device — and **automation slots and remote-access slots are bought
separately**, so unmetered interactive *and* unmetered real-device CI is $500/month.
That is another reason to start metered.

**Start metered, on the free 1,000 minutes**, and buy a slot only after crossing
roughly 24 hours a month. `get_account_status` reports the remaining trial
balance on every call that wants it, and every run and session result carries the
minutes it used and an estimate of what they cost.

---

## The short version

1. AWS account, **US West (Oregon)**, payment method on file.
2. Device Farm project → copy the **ARN**.
3. IAM user with **only** the eighteen actions above → access key.
4. Three values into `/ui/secrets`, namespace
   `/strad/{prod,staging}/mcp/aws-device-farm/static/`.
5. Motet CI: export a **device** `.ipa` and publish it at a **fetchable https
   URL**. Expect push notifications and universal links to be stripped by
   re-signing.
6. Agents land: staging config (strad) → prod config + `zimmer` entitlement
   (strad-production) → `artifacts/mcp.json` (artifacts).
7. `get_account_status` from a session that has the slug.
