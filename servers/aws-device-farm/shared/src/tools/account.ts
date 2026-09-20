import { args, guard, ok, type DepsFactory, type ToolDefinition } from "./shared.js";

/**
 * What a minute costs this account, before anyone spends one.
 *
 * FIRST TOOL IN THE LOOP, and the reason is money rather than tidiness. Every
 * other tool here that touches a phone bills by the device-minute against
 * somebody's card, and the two facts that decide whether that matters — how
 * much of the one-time 1,000-minute free trial is left, and whether any
 * unmetered slot is subscribed — are in this one call and nowhere else.
 */
export function getAccountStatusTool(deps: DepsFactory): ToolDefinition {
  return {
    name: "get_account_status",
    description:
      "What Device Farm minutes cost this AWS account right now: free-trial " +
      "minutes remaining, unmetered slots subscribed, and the metered rate. " +
      "CALL THIS FIRST in any session that will start a device — every other " +
      "tool that touches a phone bills by the minute, and this is the only " +
      "place that says whether the minutes are free.\n\n" +
      'Example: {"aws_account":"111122223333",' +
      '"free_trial_minutes_remaining":827,"free_trial_minutes_total":1000,' +
      '"unmetered_automation_slots":{"IOS":0},' +
      '"unmetered_remote_access_slots":{"IOS":0},' +
      '"metered_rate_usd_per_minute":0.17}\n\n' +
      "Reading it: `free_trial_minutes_remaining` is a ONE-TIME grant that " +
      "does not renew. An `unmetered_*_slots` value of 0 means pay-as-you-go " +
      "— every minute is billed at the metered rate. Automation slots and " +
      "remote-access slots are bought separately, so a subscription to one " +
      "does nothing for the other.\n\n" +
      "Use cases: deciding whether to explore interactively or to schedule a " +
      "single automated run; reporting to a human what a verification cost; " +
      "checking an account is actually set up before a run fails on it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (raw) =>
      guard(async () => {
        args(raw);
        return ok(await (await deps()).gateway.accountStatus());
      }),
  };
}
