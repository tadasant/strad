import { createHash } from "node:crypto";

/**
 * A macOS configuration profile that force-installs the bridge extension and
 * hands it its settings — on a Mac that Chrome considers MANAGED. Chromium
 * filters `ExtensionSettings` entries that force-install from anywhere but
 * the Web Store as "sensitive" unless the machine is MDM-enrolled or
 * domain-bound (`FilterSensitiveExtensionSettings` in
 * `components/policy/core/common/policy_loader_common.cc`, applied by
 * `policy_loader_mac.mm` when `IsManagedOrEnterpriseDevice()` is false), so
 * on a personal Mac the first payload shows as `[BLOCKED]` in
 * `chrome://policy` and installs nothing. `strad-hostd extension` says so;
 * the unpacked route is the one a personal Mac gets. Two payloads:
 *
 * - `com.google.Chrome` → `ExtensionSettings`: the extension id, force-installed
 *   from the daemon's own update manifest on loopback. Chrome fetches the CRX
 *   from the daemon, verifies it against the key inside, and re-checks that
 *   URL for updates. A force-installed extension cannot be disabled or removed
 *   from `chrome://extensions`, survives Chrome's developer-mode rules, and —
 *   because it is policy-installed — attaches `chrome.debugger` with NO
 *   "started debugging this browser" infobar (`Manifest::IsPolicyLocation` in
 *   Chromium's `debugger_api.cc`), without `--silent-debugger-extension-api`.
 * - `com.google.Chrome.extensions.<id>`: the extension's managed storage —
 *   the daemon URL and the pairing token. A value set here is read ahead of
 *   the options page and cannot be edited there.
 *
 * The token is therefore in a profile under `/Library/Managed Preferences`,
 * readable by every user of the Mac. The daemon's config, keys and audit log
 * are in a 0700 directory of one user. On a one-person Mac the two are the
 * same boundary; on a shared one, use the options page instead.
 */
export function renderMobileconfig(input: {
  extensionId: string;
  updateUrl: string;
  daemonUrl: string;
  token: string;
  machine: string;
}): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // Stable per extension id, so re-installing the profile REPLACES it rather
  // than stacking a second copy.
  const uuid = (label: string) => {
    const h = createHash("sha256")
      .update(`strad-hostd:${label}:${input.extensionId}`)
      .digest("hex")
      .toUpperCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  const ext = `com.google.Chrome.extensions.${input.extensionId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadScope</key><string>User</string>
  <key>PayloadIdentifier</key><string>com.strad.hostd.extension</string>
  <key>PayloadUUID</key><string>${uuid("profile")}</string>
  <key>PayloadDisplayName</key><string>strad-hostd Chrome extension</string>
  <key>PayloadDescription</key><string>Installs the strad-hostd bridge extension in Google Chrome and pairs it with the strad-hostd daemon on ${esc(input.machine)}. Remove this profile to remove the extension.</string>
  <key>PayloadOrganization</key><string>strad-hostd</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.google.Chrome</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>com.strad.hostd.extension.chrome</string>
      <key>PayloadUUID</key><string>${uuid("chrome")}</string>
      <key>PayloadDisplayName</key><string>Google Chrome: force-install the strad-hostd bridge</string>
      <key>PayloadEnabled</key><true/>
      <key>ExtensionSettings</key>
      <dict>
        <key>${esc(input.extensionId)}</key>
        <dict>
          <key>installation_mode</key><string>force_installed</string>
          <key>update_url</key><string>${esc(input.updateUrl)}</string>
          <key>override_update_url</key><true/>
        </dict>
      </dict>
    </dict>
    <dict>
      <key>PayloadType</key><string>${esc(ext)}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>com.strad.hostd.extension.settings</string>
      <key>PayloadUUID</key><string>${uuid("settings")}</string>
      <key>PayloadDisplayName</key><string>strad-hostd bridge: daemon and pairing token</string>
      <key>PayloadEnabled</key><true/>
      <key>daemon</key><string>${esc(input.daemonUrl)}</string>
      <key>token</key><string>${esc(input.token)}</string>
    </dict>
  </array>
</dict>
</plist>
`;
}
