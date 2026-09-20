import { uploadApp, UPLOAD_TYPES } from "../uploads.js";
import {
  args,
  boundedInt,
  enumString,
  guard,
  ok,
  requiredString,
  type DepsFactory,
  type ToolDefinition,
} from "./shared.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 900;

/**
 * A build, from wherever CI left it onto Device Farm — and the wait that makes
 * the result mean something.
 *
 * THE WAIT IS THE TOOL. `CreateUpload` reserves an ARN and succeeds
 * immediately; Device Farm checks the build afterwards, and a SIMULATOR .ipa —
 * the single most common mistake — fails there, minutes later, with the reason
 * in a field nobody reads. An agent that took the ARN and scheduled a run on it
 * would find out on a phone it was paying for. So this returns only once the
 * upload is SUCCEEDED or FAILED, and a FAILED upload is an error carrying
 * Device Farm's own message.
 */
export function uploadAppTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "upload_app",
    description:
      "Upload a build to Device Farm from an https URL and WAIT for Device " +
      "Farm to finish checking it. Returns an upload ARN that " +
      "start_device_session and schedule_run take.\n\n" +
      "There is no local file: strad fetches `source_url` itself, so it has " +
      "to be reachable without a login — a pre-signed link, a public release " +
      "asset, or an artifact published somewhere strad can read. A GitHub " +
      "Actions artifact behind the API is not.\n\n" +
      'Example: {"arn":"arn:aws:devicefarm:us-west-2:111122223333:upload:.../ab12",' +
      '"name":"Motet-staging.ipa","type":"IOS_APP","status":"SUCCEEDED",' +
      '"bytes":48210944,"ready":true}\n\n' +
      "`status`: INITIALIZED and PROCESSING mean Device Farm is still " +
      "checking; SUCCEEDED means the build is usable; FAILED is returned as " +
      "an error with the reason. `ready:false` means the wait ran out with " +
      "the upload still processing — the ARN is fine, poll list_uploads.\n\n" +
      "The .ipa must be a DEVICE build, not a simulator build, and Device " +
      "Farm re-signs it with its own wildcard profile on public devices — " +
      "which strips App Groups, Associated Domains, Push Notifications, " +
      "In-App Purchase and Apple Pay entitlements. An app that depends on one " +
      "of those behaves differently here than on TestFlight.\n\n" +
      "Use cases: putting a CI build on a phone to reproduce a bug; " +
      "refreshing the build between two device sessions; uploading an Appium " +
      "or XCUITest package for schedule_run.",
    inputSchema: {
      type: "object",
      properties: {
        source_url: {
          type: "string",
          description:
            "https URL of the build. Must be fetchable by strad without " +
            "credentials — a pre-signed link or a public asset. http is refused.",
        },
        name: {
          type: "string",
          description:
            'File name for the upload, no slashes. Must end ".ipa" for ' +
            'IOS_APP, ".apk" for ANDROID_APP and ".zip" for every test ' +
            'package — e.g. "Motet-staging-build-412.ipa". Device Farm refuses ' +
            "anything else without saying which rule it was.",
        },
        type: {
          type: "string",
          enum: [...UPLOAD_TYPES],
          description:
            "What is being uploaded. IOS_APP (default) for an .ipa; the " +
            "APPIUM_*/XCTEST_* types are test packages for schedule_run.",
        },
        wait_seconds: {
          type: "integer",
          description:
            `How long to wait for Device Farm to finish checking the build ` +
            `(1-${MAX_WAIT_SECONDS}). Default: ${DEFAULT_WAIT_SECONDS}. A ` +
            `normal .ipa settles in well under a minute.`,
        },
      },
      required: ["source_url", "name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const { gateway, maxUploadBytes, fetchImpl } = await deps();
        const result = await uploadApp({
          gateway,
          fetchImpl,
          sourceUrl: requiredString(input, "source_url"),
          name: requiredString(input, "name"),
          type: enumString(input, "type", UPLOAD_TYPES) ?? "IOS_APP",
          maxBytes: maxUploadBytes,
          timeoutMs:
            boundedInt(input, "wait_seconds", DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) *
            1000,
        });
        return ok(result);
      }),
  };
}

/**
 * Builds already on Device Farm.
 *
 * An upload is reusable for as long as the project keeps it, and reusing one is
 * free where re-uploading costs a transfer and a wait. This is what makes "run
 * the same build on a second phone" one call rather than four.
 */
export function listUploadsTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "list_uploads",
    description:
      "Builds and test packages already uploaded to this project, newest " +
      "first. Reuse an ARN from here instead of uploading the same build " +
      "twice — an upload is kept by the project and costs nothing to reuse.\n\n" +
      'Example: {"uploads":[{"arn":"arn:aws:devicefarm:us-west-2:111122223333:upload:.../ab12",' +
      '"name":"Motet-staging.ipa","type":"IOS_APP","status":"SUCCEEDED",' +
      '"created":"2026-09-20T07:41:02.000Z"}],"returned":1}\n\n' +
      "`status`: INITIALIZED (created, bytes not in yet), PROCESSING (Device " +
      "Farm is checking it), SUCCEEDED (usable), FAILED (`message` says why — " +
      "usually a simulator build).\n\n" +
      "Use cases: finding the build a previous session uploaded; checking " +
      "whether an upload that was still PROCESSING has settled; listing test " +
      "packages before scheduling a run.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [...UPLOAD_TYPES],
          description: "Only uploads of this type. Omit for all of them.",
        },
        limit: {
          type: "integer",
          description: `How many to return (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        const input = args(raw);
        const uploads = await (
          await deps()
        ).gateway.listUploads(
          enumString(input, "type", UPLOAD_TYPES),
          boundedInt(input, "limit", DEFAULT_LIMIT, MAX_LIMIT),
        );
        return ok({ uploads, returned: uploads.length });
      }),
  };
}
