import { InputError } from "../errors.js";
import {
  args,
  boundedInt,
  enumString,
  guard,
  ok,
  optionalBool,
  optionalString,
  requiredArn,
  type DepsFactory,
  type ToolDefinition,
} from "./shared.js";

/**
 * The test types this server will schedule.
 *
 * `BUILTIN_FUZZ` is the one that needs NO test package: Device Farm drives the
 * app with pseudo-random events for a few minutes and hands back a video,
 * device logs and a crash report. It is the cheapest thing that answers "does
 * this build launch and survive on a real phone", and it is what a project with
 * no UI test suite can use on day one.
 */
const TEST_TYPES = [
  "BUILTIN_FUZZ",
  "APPIUM_NODE",
  "APPIUM_PYTHON",
  "XCTEST",
  "XCTEST_UI",
] as const;

/** `ListArtifacts` takes one of exactly these three. */
const ARTIFACT_KINDS = ["FILE", "LOG", "SCREENSHOT"] as const;

const MAX_DEVICES = 5;

/**
 * An unattended run on real hardware.
 *
 * THIS IS THE MODE THAT PRODUCES ARTIFACTS. A run records video, collects the
 * device's own system log, keeps screenshots a test took and keeps whatever the
 * test wrote to the customer-artifact paths — which is the channel an app's own
 * instrumentation uses to report something a screen cannot show. The
 * interactive mode drives a phone and records nothing durable beyond the
 * session's video.
 */
export function scheduleRunTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "schedule_run",
    description:
      "Start an unattended test run on real devices and return immediately " +
      "with a run ARN. This is the mode that produces EVIDENCE — video, the " +
      "device system log, screenshots and test output — which list_run_artifacts " +
      "fetches once it finishes. Poll get_run.\n\n" +
      "`test_type` BUILTIN_FUZZ needs no test package: Device Farm drives the " +
      "app with random events and still records video, device logs and any " +
      "crash. It is the fastest answer to \"does this build launch and survive " +
      "on a real phone\". APPIUM_NODE / APPIUM_PYTHON / XCTEST / XCTEST_UI run " +
      "your own suite and need `test_package_arn` from upload_app.\n\n" +
      'Example: {"arn":"arn:aws:devicefarm:us-west-2:111122223333:run:.../cd34",' +
      '"status":"SCHEDULING","result":"PENDING","platform":"IOS",' +
      '"console_url":"https://us-west-2.console.aws.amazon.com/devicefarm/..."}\n\n' +
      "COST: billed per device-minute PER DEVICE. A pool of five devices is " +
      "five times the minutes of one. A run is capped at 150 minutes and " +
      "queues for up to 24 hours if the devices are busy.\n\n" +
      "Use cases: a regression sweep on a build before it ships; reproducing a " +
      "crash on a specific iOS version; producing a video a human can watch " +
      "when an agent cannot tell what went wrong.",
    inputSchema: {
      type: "object",
      properties: {
        app_arn: {
          type: "string",
          description:
            "The build to run, from upload_app or list_uploads. Required for " +
            "every test type except a web test.",
        },
        test_type: {
          type: "string",
          enum: [...TEST_TYPES],
          description:
            "What to run. Default: BUILTIN_FUZZ, which needs no test package.",
        },
        test_package_arn: {
          type: "string",
          description:
            "The test package, from upload_app. Required for every type " +
            "except BUILTIN_FUZZ.",
        },
        test_spec_arn: {
          type: "string",
          description:
            "A custom test-spec YAML upload, for a run that needs a custom " +
            "test environment. Optional.",
        },
        device_pool_arn: {
          type: "string",
          description:
            "Run on a saved pool, from list_device_pools. Either this or " +
            "`device_arns`.",
        },
        device_arns: {
          type: "array",
          items: { type: "string" },
          description:
            `Run on exactly these devices, from list_devices (max ` +
            `${MAX_DEVICES}). Either this or \`device_pool_arn\`. One device ` +
            `is one device's worth of minutes.`,
        },
        name: {
          type: "string",
          description:
            'A name for the run, shown in the console, e.g. "motet staging ' +
            'build 412 smoke".',
        },
        job_timeout_minutes: {
          type: "integer",
          description:
            "Kill each device's job after this many minutes (1-150). Lower " +
            "is cheaper when a run can hang.",
        },
        skip_app_resign: {
          type: "boolean",
          description:
            "Only meaningful on PRIVATE devices. Device Farm always re-signs " +
            "on public devices, so this does nothing there.",
        },
        video_capture: {
          type: "boolean",
          description: "Record video. Default: true — the video is the evidence.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const testType = enumString(input, "test_type", TEST_TYPES) ?? "BUILTIN_FUZZ";
        const testPackageArn = optionalString(input, "test_package_arn");
        if (testType !== "BUILTIN_FUZZ" && !testPackageArn) {
          throw new InputError(
            `test_type ${testType} runs YOUR test suite, so ` +
              `\`test_package_arn\` is required — upload it with upload_app ` +
              `first. BUILTIN_FUZZ is the type that needs no package.`,
          );
        }
        const deviceArns = input.device_arns;
        if (deviceArns !== undefined && !Array.isArray(deviceArns)) {
          throw new InputError("`device_arns` must be an array of device ARNs.");
        }
        if (Array.isArray(deviceArns) && deviceArns.length > MAX_DEVICES) {
          throw new InputError(
            `\`device_arns\` names ${deviceArns.length} devices; Device Farm ` +
              `runs at most ${MAX_DEVICES} at once, and each one bills its own ` +
              `minutes.`,
          );
        }
        const appArn = optionalString(input, "app_arn");
        const testSpecArn = optionalString(input, "test_spec_arn");
        const poolArn = optionalString(input, "device_pool_arn");
        const name = optionalString(input, "name");
        // Absent means "Device Farm's own default", which the account sets.
        // Passing a fallback here would silently override it.
        const jobTimeout =
          input.job_timeout_minutes === undefined
            ? undefined
            : boundedInt(input, "job_timeout_minutes", 150, 150);
        const skipResign = optionalBool(input, "skip_app_resign");
        const videoCapture = optionalBool(input, "video_capture");
        const run = await (
          await deps()
        ).gateway.scheduleRun({
          test_type: testType,
          ...(appArn === undefined ? {} : { app_arn: appArn }),
          ...(testPackageArn === undefined ? {} : { test_package_arn: testPackageArn }),
          ...(testSpecArn === undefined ? {} : { test_spec_arn: testSpecArn }),
          ...(poolArn === undefined ? {} : { device_pool_arn: poolArn }),
          ...(Array.isArray(deviceArns)
            ? { device_arns: deviceArns.map(String) }
            : {}),
          ...(name === undefined ? {} : { name }),
          ...(jobTimeout === undefined ? {} : { job_timeout_minutes: jobTimeout }),
          ...(skipResign === undefined ? {} : { skip_app_resign: skipResign }),
          ...(videoCapture === undefined ? {} : { video_capture: videoCapture }),
        });
        return ok({
          ...run,
          next: "Poll get_run every 20-30 seconds; artifacts exist once it is COMPLETED.",
        });
      }),
  };
}

/** Where a run has got to, and what each device did. */
export function getRunTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "get_run",
    description:
      "A run's status, result, per-device outcome and the minutes it has " +
      "billed so far. Poll this every 20-30 seconds after schedule_run — " +
      "Device Farm throttles at one non-list call per second.\n\n" +
      'Example: {"arn":"arn:aws:devicefarm:us-west-2:111122223333:run:.../cd34",' +
      '"status":"COMPLETED","result":"FAILED","counters":{"total":4,"passed":3,' +
      '"failed":1},"device_minutes":{"total":6.5,"metered":6.5},' +
      '"estimated_metered_cost_usd":1.11,"jobs":[{"device":"Apple iPhone 15 Pro",' +
      '"os":"17.5.1","status":"COMPLETED","result":"FAILED"}]}\n\n' +
      "`status` is progress: PENDING, SCHEDULING, PREPARING, RUNNING, " +
      "COMPLETED, STOPPING. `result` is the verdict and only means something " +
      "once COMPLETED: PASSED, FAILED (a test failed), ERRORED (the run could " +
      "not execute — a bad package, a device problem), WARNED, SKIPPED, " +
      "STOPPED.\n\n" +
      "ERRORED with no tests run almost always means the build or the test " +
      "package, not the app's behaviour — read `message` and the device log " +
      "from list_run_artifacts.\n\n" +
      "Use cases: waiting for a run to finish; reporting what a verification " +
      "cost; telling a genuine test failure from a run that never started.",
    inputSchema: {
      type: "object",
      properties: {
        run_arn: { type: "string", description: "The run, from schedule_run." },
      },
      required: ["run_arn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        return ok(await (await deps()).gateway.getRun(requiredArn(input, "run_arn")));
      }),
  };
}

/** Stop a run, and stop its meter. */
export function stopRunTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "stop_run",
    description:
      "Stop a run that is still going. Billing stops with it, which is the " +
      "reason to reach for this rather than waiting out a 150-minute timeout " +
      "on a run that is clearly stuck.\n\n" +
      'Example: {"arn":"arn:aws:devicefarm:us-west-2:111122223333:run:.../cd34",' +
      '"status":"STOPPING","result":"STOPPED","device_minutes":{"metered":3.2},' +
      '"estimated_metered_cost_usd":0.54}\n\n' +
      "Artifacts recorded before the stop survive it — list_run_artifacts " +
      "still works on a stopped run, and the partial video is often enough to " +
      "see what hung.\n\n" +
      "Use cases: a run that will obviously fail; a run started against the " +
      "wrong build; freeing concurrency for a run that matters.",
    inputSchema: {
      type: "object",
      properties: {
        run_arn: { type: "string", description: "The run to stop." },
      },
      required: ["run_arn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        return ok(await (await deps()).gateway.stopRun(requiredArn(input, "run_arn")));
      }),
  };
}

/**
 * The evidence.
 *
 * Every artifact carries a PRE-SIGNED URL that expires, so this re-lists rather
 * than caching: a link an agent kept from an hour ago is a 403 that reads like
 * a missing artifact.
 */
export function listRunArtifactsTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "list_run_artifacts",
    description:
      "Everything a run recorded, with a download URL for each: the VIDEO of " +
      "each device, the device's own system log (syslog on iOS), test output, " +
      "any crash report, screenshots the test took, and whatever the test " +
      "wrote to the customer-artifact paths. Call it once get_run says " +
      "COMPLETED.\n\n" +
      'Example: {"file":[{"name":"Video","type":"VIDEO","extension":"mp4",' +
      '"url":"https://prod-us-west-2-uploads.s3..."},{"name":"Customer ' +
      'Artifacts","type":"CUSTOMER_ARTIFACT","extension":"zip","url":"..."}],' +
      '"log":[{"name":"Device Log","type":"DEVICE_LOG","extension":"logcat"}],' +
      '"screenshot":[],"returned":3}\n\n' +
      "`kinds`: FILE is video, crash reports and customer artifacts; LOG is " +
      "device and test logs; SCREENSHOT is images a test captured. All three " +
      "by default.\n\n" +
      "The URLs are PRE-SIGNED AND EXPIRE. Fetch them promptly, and re-call " +
      "this tool rather than reusing an old link — an expired one answers 403, " +
      "which looks exactly like an artifact that was never recorded.\n\n" +
      "AUDIO IS NOT HERE, and it is not an omission of this tool: Device Farm " +
      "records video without sound, so \"is audio actually playing\" has to " +
      "come from the app's own instrumentation, written to a customer-artifact " +
      "path or exposed on screen.\n\n" +
      "Use cases: getting the video of a failing run; reading the device log " +
      "after an ERRORED run; pulling an app's own probe output back for an " +
      "assertion.",
    inputSchema: {
      type: "object",
      properties: {
        run_arn: { type: "string", description: "The run, from schedule_run." },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...ARTIFACT_KINDS] },
          description:
            "Which kinds to list. Default: all three (FILE, LOG, SCREENSHOT).",
        },
      },
      required: ["run_arn"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const requested = input.kinds;
        if (requested !== undefined && !Array.isArray(requested)) {
          throw new InputError(
            `\`kinds\` must be an array of: ${ARTIFACT_KINDS.join(", ")}.`,
          );
        }
        const kinds = (
          Array.isArray(requested) && requested.length > 0
            ? requested.map((k) => String(k).toUpperCase())
            : [...ARTIFACT_KINDS]
        ).map((k) => {
          if (!(ARTIFACT_KINDS as readonly string[]).includes(k)) {
            throw new InputError(
              `\`kinds\` may only contain ${ARTIFACT_KINDS.join(", ")}; got "${k}".`,
            );
          }
          return k;
        });
        const grouped = await (
          await deps()
        ).gateway.listRunArtifacts(requiredArn(input, "run_arn"), kinds);
        const returned = Object.values(grouped).reduce((n, a) => n + a.length, 0);
        return ok({ ...grouped, returned });
      }),
  };
}
