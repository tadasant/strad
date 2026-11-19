import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { ExtensionBridge } from "../browser/bridge.js";
import { BrowserSession } from "../browser/session.js";
import { clickSelector, HIDDEN_TAB_CLICK } from "../browser/tools.js";
import type { Config } from "../config.js";
import type { Grant } from "../consent/grants.js";
import { defineTool, json, text, type Capability } from "../mcp/tool.js";
import {
  depositRoutePath,
  depositToken,
  isDepositSlug,
  isDepositVariable,
  MAX_DEPOSIT_VALUE_LENGTH,
  parseDepositReceipt,
} from "./deposit-wire.js";
import { destinationNames, resolveDestination } from "./destinations.js";
import { KEY_COMMENT, KEY_TYPES, mintKeypair } from "./keygen.js";
import { elementValue, SNAPSHOT_CANDIDATES } from "./page-scripts.js";
import { shapeOf, type Vault } from "./vault.js";

const P = {
  tab_id:
    'A tab_id from list_tabs (here or on the browser server), e.g. "8F2C1A…".',
  click_selector:
    'A CSS selector for the button that makes the credential appear, e.g. "button#generate-token". Omit it when the credential is already on the page.',
  capture_selector:
    'A CSS selector for the element that will HOLD the credential, e.g. "#new-token" or "input[readonly]". Omit it to let custody find the one new credential-shaped value the click produced.',
  wait_seconds:
    "How long to wait for the credential to appear after the click. Default 10.",
  label:
    'A short note for yourself about what this is, e.g. "Linear API key, read scope". Never the value.',
  handle:
    'A handle from click_and_capture, capture_download or generate_keypair, e.g. "h_3kd9…".',
  slug: 'The strad server slug the secret is for, e.g. "linear". Lowercase, dashes.',
  variable:
    'The environment-variable name the server reads it as, e.g. "LINEAR_API_KEY".',
} as const;

const POLL_MS = 250;
/** What list_tabs shows for a tainted tab's title and URL. */
const TAINTED = "(tainted — hidden until release_tab)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Candidate {
  selector: string;
  token: string;
}

/** Why a capture's click did not happen. Nothing was clicked, so nothing was captured. */
function notClicked(reason: "no-match" | "hidden", selector: string): string {
  return reason === "hidden"
    ? `${HIDDEN_TAB_CLICK} Nothing was captured.`
    : `No element matches ${JSON.stringify(selector)}. Nothing was clicked or captured.`;
}

/** Where Chrome saves downloads. */
function downloadsDir(config: Config): string {
  return config.custody.downloadsDir ?? join(homedir(), "Downloads");
}

/** Names in a directory a finished download could have. */
function settledFiles(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (/\.(crdownload|download|part|tmp)$/i.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) out.set(name, st.mtimeMs);
    } catch {
      // gone between the listing and the stat
    }
  }
  return out;
}

/**
 * strad-hostd's custody server: capture a credential into a handle, deposit
 * the handle into strad. See docs/servers/hostd-custody.md.
 *
 * Nothing any tool here returns contains a captured value, and every result
 * passes the egress filter anyway (src/mcp/server.ts). The vault is shared
 * with the other servers, which is how they know to refuse while it is live.
 */
export function custodyCapability(
  config: Config,
  vault: Vault,
  bridge?: ExtensionBridge,
  /**
   * Why a capture may not start right now — the daemon passes "a shell
   * command is running", since a command started before the hold runs
   * through it. Undefined when nothing is in the way.
   */
  busy: () => string | undefined = () => undefined,
): Capability {
  const sessions = new Map<string, BrowserSession>();

  /**
   * This grant's browser session, and — once per grant — what its end does:
   * every tab it tainted is blanked, so the secret is no longer on screen when
   * the other servers stop refusing, and every handle it holds is dropped.
   */
  const sessionFor = (grant: Grant): BrowserSession => {
    let s = sessions.get(grant.id);
    if (s) return s;
    const session = new BrowserSession(config, bridge);
    s = session;
    sessions.set(grant.id, session);
    grant.signal.addEventListener(
      "abort",
      () => {
        sessions.delete(grant.id);
        vault.endGrant(grant.id);
        void (async () => {
          for (const tab of vault.taintedBy(grant.id)) {
            const blanked = await session
              .send(tab, "Page.navigate", { url: "about:blank" }, 5000)
              .then(() => true)
              .catch(() => false);
            // A tab that could not be blanked keeps its taint while it still
            // exists — the secret may still be on it — and any custody grant
            // can release_tab it. A tab that is gone took the secret with it.
            const gone =
              !blanked &&
              !(await session
                .tabs()
                .then((ts) => ts.some((t) => t.tab_id === tab))
                .catch(() => true));
            if (blanked || gone) vault.untaint(tab);
          }
          session.close();
        })();
      },
      { once: true },
    );
    return session;
  };

  const origin = (s: BrowserSession, tab: string) =>
    s.evaluate<string>(tab, "location.origin").catch(() => "unknown");

  const listTabs = defineTool({
    name: "list_tabs",
    description: `List the tabs open in the owner's Chrome, and which ones custody has tainted.

**Returns:** {"tabs":[{"tab_id":"8F2C…","title":"API keys","url":"https://linear.app/settings/api","tainted":false}]}
tainted is true for a tab a capture ran in: the secret may still be on it, so the other servers refuse to read it until you release_tab it.

**Use cases:**
- Find the tab you navigated to the provider's token page with the browser server
- Check which tabs still need release_tab before you end control`,
    schema: z.object({}),
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List Chrome tabs", readOnlyHint: true },
    handler: async (_a, { grant }) => {
      const tabs = await sessionFor(grant).tabs();
      return json({
        tabs: tabs.map((t) => ({
          tab_id: t.tab_id,
          // A tainted tab's page wrote its own title and URL, and nothing is
          // held yet when a capture found nothing to keep — so the egress
          // filter has no value to match them against. Withhold them.
          title: vault.isTainted(t.tab_id) ? TAINTED : t.title,
          url: vault.isTainted(t.tab_id) ? TAINTED : t.url,
          tainted: vault.isTainted(t.tab_id),
        })),
      });
    },
  });

  const clickAndCapture = defineTool({
    name: "click_and_capture",
    description: `Click the button that reveals a credential and capture it in ONE step, so it is never on a page you can read. The value stays on this machine behind a handle; you get the handle and its shape, never the value.

The tab is TAINTED from the start of this call: until you release_tab it (or end control here), the browser server will not read any tab, and the shell and computer-use servers on this machine refuse every call.

How the value is found:
- capture_selector given: that element's value (an input's value, a copy button's data-clipboard-text, else its text), once it is non-empty and has changed.
- omitted: the ONE credential-shaped string (16+ characters, letters and digits, no spaces) that was not on the page before the click. If several appear, nothing is kept and their selectors are returned: call again with no click_selector and one of them as capture_selector.

**Returns:** {"handle":"h_3kd9…","shape":{"length":40,"kind":"token","prefix":"lin_api_"},"expires_at":"…","tab_tainted":true}
shape.kind is "token", "json", "pem" or "text". Check length and prefix against what the provider issues before you deposit.

**Use cases:**
- "Generate new token" on a provider's settings page, with the token shown once
- Capturing a token that is already displayed (no click_selector)`,
    schema: z.object({
      tab_id: z.string().min(1),
      click_selector: z.string().min(1).optional(),
      capture_selector: z.string().min(1).optional(),
      wait_seconds: z.number().int().min(1).max(60).default(10),
      label: z.string().max(120).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: P.tab_id },
        click_selector: { type: "string", description: P.click_selector },
        capture_selector: { type: "string", description: P.capture_selector },
        wait_seconds: {
          type: "integer",
          description: P.wait_seconds,
          default: 10,
        },
        label: { type: "string", description: P.label },
      },
      required: ["tab_id"],
    },
    annotations: {
      title: "Click and capture a credential",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    summarize: (a) =>
      `click_and_capture: click ${a.click_selector?.slice(0, 100) ?? "(none)"}, capture ${a.capture_selector?.slice(0, 100) ?? "(diff)"}`,
    handler: async (a, { grant }) => {
      if (!a.click_selector && !a.capture_selector)
        return text(
          "Give click_selector, capture_selector, or both. Nothing ran.",
          true,
        );
      const blocked = busy();
      if (blocked)
        return text(`Not now: ${blocked}. Nothing was clicked.`, true);
      const s = sessionFor(grant);
      const wasTainted = vault.isTainted(a.tab_id);
      const done = vault.beginCapture();
      // Tainted BEFORE the click: there is never a moment where the secret is
      // on a page the other servers would read.
      vault.taint(a.tab_id, grant.id);
      try {
        const before = a.capture_selector
          ? await s.evaluate<string | null>(
              a.tab_id,
              elementValue(a.capture_selector),
            )
          : null;
        const beforeTokens = a.capture_selector
          ? new Set<string>()
          : new Set(
              (
                await s.evaluate<Candidate[]>(a.tab_id, SNAPSHOT_CANDIDATES)
              ).map((c) => c.token),
            );
        if (a.click_selector) {
          const clicked = await clickSelector(s, a.tab_id, a.click_selector);
          if (!clicked.clicked) {
            // Nothing was clicked, so the page is as readable as it was.
            if (!wasTainted) vault.untaint(a.tab_id);
            return text(notClicked(clicked.reason, a.click_selector), true);
          }
        }

        const deadline = Date.now() + a.wait_seconds * 1000;
        let value: string | undefined;
        let several: Candidate[] = [];
        while (Date.now() < deadline) {
          await sleep(POLL_MS);
          if (a.capture_selector) {
            const now = await s
              .evaluate<string | null>(
                a.tab_id,
                elementValue(a.capture_selector),
              )
              .catch(() => null);
            if (now && (!a.click_selector || now !== before)) {
              value = now.trim();
              break;
            }
          } else {
            const fresh = (
              await s
                .evaluate<Candidate[]>(a.tab_id, SNAPSHOT_CANDIDATES)
                .catch(() => [] as Candidate[])
            ).filter((c) => !beforeTokens.has(c.token));
            if (fresh.length === 1) {
              value = fresh[0]!.token;
              break;
            }
            if (fresh.length > 1) {
              several = fresh;
              break;
            }
          }
        }

        if (several.length > 0) {
          return text(
            JSON.stringify(
              {
                captured: false,
                reason: `${several.length} new credential-shaped values appeared; nothing was kept. Call click_and_capture again with NO click_selector and the right capture_selector.`,
                candidates: several.slice(0, 20).map((c) => ({
                  // None of these values is held, so the filter cannot catch
                  // one: a selector the page built out of a candidate (an id
                  // that IS the token) is withheld here instead.
                  capture_selector: several.some((o) =>
                    c.selector.includes(o.token),
                  )
                    ? null
                    : c.selector,
                  shape: shapeOf(c.token),
                })),
                tab_tainted: true,
              },
              null,
              2,
            ),
            true,
          );
        }
        if (!value) {
          return text(
            `No credential appeared within ${a.wait_seconds}s${a.capture_selector ? ` in ${JSON.stringify(a.capture_selector)}` : ""}. Nothing was kept. The tab stays tainted: release_tab it before reading it again.`,
            true,
          );
        }
        const source = `page ${await origin(s, a.tab_id)}`;
        // The grant ended while this ran: its handles were already dropped,
        // and one held now would outlive it with nothing able to deposit it.
        // Checked with no await between it and the hold.
        if (grant.signal.aborted)
          return text(
            "The grant ended during the capture. Nothing was kept.",
            true,
          );
        const held = vault.hold(grant.id, value, { label: a.label, source });
        return json({
          handle: held.handle,
          shape: held.shape,
          expires_at: new Date(held.expiresAt).toISOString(),
          tab_tainted: true,
        });
      } finally {
        done();
      }
    },
  });

  const captureDownload = defineTool({
    name: "capture_download",
    description: `Click a link or button that DOWNLOADS a credential file (a service-account JSON key, a .pem) and take the file into custody: it is read into a handle and deleted from the Downloads folder. You never see its contents.

While this runs the shell server is refused, so nothing can read the file in the moment between Chrome saving it and custody taking it. The tab is tainted as with click_and_capture.

**Returns:** {"handle":"h_3kd9…","file":"my-project-1a2b3c.json","shape":{"length":2380,"kind":"json","json_keys":["type","project_id","private_key_id","private_key","client_email"],"lines":13},"expires_at":"…","tab_tainted":true}

**Use cases:**
- "Create key → JSON" on a cloud console's service-account page
- Any provider that only offers the credential as a file`,
    schema: z.object({
      tab_id: z.string().min(1),
      click_selector: z.string().min(1),
      wait_seconds: z.number().int().min(1).max(120).default(30),
      label: z.string().max(120).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: P.tab_id },
        click_selector: {
          type: "string",
          description:
            'A CSS selector for the control that starts the download, e.g. "button#create-key".',
        },
        wait_seconds: {
          type: "integer",
          description: "How long to wait for the file. Default 30.",
          default: 30,
        },
        label: { type: "string", description: P.label },
      },
      required: ["tab_id", "click_selector"],
    },
    annotations: {
      title: "Capture a downloaded credential",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    summarize: (a) =>
      `capture_download: click ${a.click_selector.slice(0, 120)}`,
    handler: async (a, { grant }) => {
      const blocked = busy();
      if (blocked)
        return text(`Not now: ${blocked}. Nothing was clicked.`, true);
      const s = sessionFor(grant);
      const dir = downloadsDir(config);
      const wasTainted = vault.isTainted(a.tab_id);
      const done = vault.beginCapture();
      vault.taint(a.tab_id, grant.id);
      try {
        const before = settledFiles(dir);
        const started = Date.now();
        const clicked = await clickSelector(s, a.tab_id, a.click_selector);
        if (!clicked.clicked) {
          if (!wasTainted) vault.untaint(a.tab_id);
          return text(notClicked(clicked.reason, a.click_selector), true);
        }
        const deadline = started + a.wait_seconds * 1000;
        let found: string | undefined;
        let lastSize = -1;
        while (Date.now() < deadline) {
          await sleep(POLL_MS);
          if (!found) {
            for (const [name, mtime] of settledFiles(dir)) {
              const prior = before.get(name);
              if (prior === undefined || mtime > prior) {
                found = name;
                break;
              }
            }
            continue;
          }
          // Settled: the same size on two looks in a row.
          const size = statSync(join(dir, found)).size;
          if (size === lastSize) break;
          lastSize = size;
        }
        if (!found)
          return text(
            `No new file appeared in ${dir} within ${a.wait_seconds}s. Nothing was kept. The tab stays tainted: release_tab it before reading it again.`,
            true,
          );
        const path = join(dir, found);
        const bytes = readFileSync(path);
        // A file this call downloaded and cannot keep is still deleted: it may
        // be a credential (a .p12, an oversized bundle), and the moment the
        // hold lifts the shell server could read it where it lies.
        const reject = (why: string) => {
          bytes.fill(0);
          unlinkSync(path);
          return text(
            `${found} ${why}. It was NOT captured, and it was deleted from ${dir}. Revoke it at its provider if it was a credential.`,
            true,
          );
        };
        if (bytes.length > MAX_DEPOSIT_VALUE_LENGTH)
          return reject(
            `is ${bytes.length} bytes, more than a credential strad stores (${MAX_DEPOSIT_VALUE_LENGTH})`,
          );
        const value = bytes.toString("utf8");
        if (value.includes("\u0000") || value.includes("\uFFFD"))
          return reject(
            "is not text, so it is not a credential strad can store",
          );
        // The grant ended while this ran: its handles were already dropped,
        // and one held now would outlive it with nothing able to deposit it.
        if (grant.signal.aborted)
          return text(
            "The grant ended during the capture. Nothing was kept.",
            true,
          );
        const held = vault.hold(grant.id, value, {
          label: a.label,
          source: `download ${found}`,
        });
        bytes.fill(0);
        unlinkSync(path);
        return json({
          handle: held.handle,
          file: found,
          shape: held.shape,
          expires_at: new Date(held.expiresAt).toISOString(),
          tab_tainted: true,
        });
      } finally {
        done();
      }
    },
  });

  const releaseTab = defineTool({
    name: "release_tab",
    description: `Blank a tainted tab (navigate it to about:blank) and lift its taint, so the other servers may read tabs again once no handle is held. Do this as soon as the credential is captured.

**Returns:** {"released":"8F2C…"}

**Use cases:**
- After click_and_capture or capture_download, once the handle is safe
- Clearing a tab tainted by a capture that found nothing`,
    schema: z.object({ tab_id: z.string().min(1) }),
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: P.tab_id } },
      required: ["tab_id"],
    },
    annotations: {
      title: "Release a tainted tab",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    summarize: (a) => `release_tab: ${a.tab_id}`,
    handler: async (a, { grant }) => {
      await sessionFor(grant).send(a.tab_id, "Page.navigate", {
        url: "about:blank",
      });
      vault.untaint(a.tab_id);
      return json({ released: a.tab_id });
    },
  });

  const generateKeypair = defineTool({
    name: "generate_keypair",
    description: `Generate an SSH keypair INSIDE custody. The private key goes straight into a handle, exactly like a captured credential; you get the handle and the PUBLIC key, never the private one.

Use it when strad needs a key it will log in WITH and the matching public half has to be installed somewhere else (an authorized_keys file, a CI variable). Deposit the handle with deposit, put the public key where it belongs, and nothing ever had to show the private key on a page.

The handle is held like any other: while it is held the shell and computer-use servers on this machine refuse every call, it expires, it ends with this grant, discard_handle drops it, and a private key that shows up in any result or argument burns it. Not while a shell command is running, for the same reason as a capture. No tab is involved.

**Returns:** {"handle":"h_3kd9…","shape":{"length":411,"kind":"pem","lines":7},"expires_at":"…","key_type":"ed25519","public_key":"ssh-ed25519 AAAAC3Nza… strad ssh-example","fingerprint":"SHA256:mdqX4Rnp…"}
public_key is one authorized_keys line. The private key is OpenSSH format, unencrypted, the form ssh-keygen -t ed25519 -N '' writes.

**Use cases:**
- An SSH login key for a strad ssh slug: generate, deposit as SSH_PRIVATE_KEY, install public_key on the host
- Any deploy key whose private half only strad should hold`,
    schema: z.object({
      key_type: z.enum(KEY_TYPES).default("ed25519"),
      comment: z.string().regex(KEY_COMMENT),
      label: z.string().max(120).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        key_type: {
          type: "string",
          enum: [...KEY_TYPES],
          default: "ed25519",
          description: 'The key algorithm. Only "ed25519".',
        },
        comment: {
          type: "string",
          description:
            'The comment on the public key line, e.g. "strad ssh-example-staging". Printable ASCII, up to 120 characters, no leading or trailing space. It is public.',
        },
        label: { type: "string", description: P.label },
      },
      required: ["comment"],
    },
    annotations: {
      title: "Generate an SSH keypair into custody",
      readOnlyHint: false,
      destructiveHint: false,
    },
    summarize: (a) =>
      `generate_keypair: ${a.key_type} ${JSON.stringify(a.comment.slice(0, 120))}`,
    handler: async (a, { grant }) => {
      const blocked = busy();
      if (blocked)
        return text(`Not now: ${blocked}. No key was generated.`, true);
      // Binds this grant's end to the vault (its handles drop with it). A
      // BrowserSession connects lazily, so no tab or Chrome is touched.
      sessionFor(grant);
      if (grant.signal.aborted)
        return text("The grant has ended. No key was generated.", true);
      const minted = mintKeypair(a.key_type, a.comment);
      const held = vault.hold(grant.id, minted.privateKey, {
        label: a.label,
        source: `generated ${a.key_type} keypair ${minted.fingerprint}`,
      });
      return json({
        handle: held.handle,
        shape: held.shape,
        expires_at: new Date(held.expiresAt).toISOString(),
        key_type: a.key_type,
        public_key: minted.publicKey,
        fingerprint: minted.fingerprint,
      });
    },
  });

  const listHandles = defineTool({
    name: "list_handles",
    description: `List this grant's handles: held, and recently ended (deposited, discarded, burned, expired). Shapes and destinations only, never values.

**Returns:** {"handles":[{"handle":"h_3kd9…","state":"held","label":"Linear API key","source":"page https://linear.app","shape":{"length":48,"kind":"token","prefix":"lin_api_"},"created_at":"…","expires_at":"…"},{"handle":"h_9xx…","state":"deposited","destination":"default","path":"/strad/prod/mcp/linear/static/LINEAR_API_KEY","version":"v1"}]}

**Use cases:**
- Check what is still held before ending control
- Confirm where a deposit went`,
    schema: z.object({}),
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List handles", readOnlyHint: true },
    handler: async (_a, { grant }) => json({ handles: vault.list(grant.id) }),
  });

  const discardHandle = defineTool({
    name: "discard_handle",
    description: `Drop a held secret without depositing it. Its bytes are zeroed.

**Returns:** {"discarded":true}

**Use cases:**
- The shape shows the wrong thing was captured
- The deposit is not wanted after all (revoke the credential at its provider too)`,
    schema: z.object({ handle: z.string().min(1) }),
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: P.handle } },
      required: ["handle"],
    },
    annotations: {
      title: "Discard a handle",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    summarize: (a) => `discard_handle: ${a.handle}`,
    handler: async (a, { grant }) => {
      const mine = vault.owns(a.handle, grant.id);
      return json({
        discarded: mine ? vault.end(a.handle, "discarded") : false,
      });
    },
  });

  const names = destinationNames(config);
  const named = names
    .slice(1)
    .map((name) => [name, config.custody.destinations[name]!] as const);
  const destinationList = [
    `- "${config.custody.stradName}" (the default, used when destination is omitted)${config.custody.stradUrl ? `: ${new URL(config.custody.stradUrl).host}` : ": not set up on this machine"}`,
    ...named.map(
      ([name, d]) =>
        `- "${name}": ${d.title ? `${d.title}, ` : ""}${new URL(d.url).host}`,
    ),
  ].join("\n");

  const deposit = defineTool({
    name: "deposit",
    description: `Send a held secret to a strad deployment, which stores it as a NEW secret parameter at /strad/<env>/mcp/<slug>/static/<VARIABLE>. The value goes from this machine to that strad directly; you get back where it went.

Where it can go is fixed by this machine's own config, by NAME — there is no URL argument:
${destinationList}
Name the strad the approved list names. Omit destination for the default.

Create-only: if that name already exists for the slug — in its static/ or oauth/ namespace, or resolved from the gateway — strad refuses with "exists" and the handle stays held; a human rotates existing credentials in strad's console. strad also refuses (not_permitted) a name in the slug's url, a process-control name such as NODE_OPTIONS or HTTPS_PROXY, a local-tunnel machine's slug, and a params: true slug this machine is not configured for. It only ever writes that one namespace and never reads anything back.

**Returns:** {"deposited":true,"destination":"${config.custody.stradName}","path":"/strad/prod/mcp/linear/static/LINEAR_API_KEY","version":"v1"}
The handle ends on success. Confirm through that strad's secrets server (list_parameters shows the parameter and its timestamp), never by reading the value.

**On refusal** the error names strad's reason: exists, not_permitted (this machine may not deposit into that slug), unauthorized (that strad does not accept this machine's deposit key for it), bad_target, store_unavailable, write_failed. An unknown destination is refused here and nothing is sent.

**Use cases:**
- The last step for each secret the owner approved: capture, check the shape, deposit
- The same, into another organisation's strad the approved list names`,
    schema: z.object({
      handle: z.string().min(1),
      slug: z.string().min(1),
      variable: z.string().min(1),
      destination: z.string().min(1).optional(),
    }),
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: P.handle },
        slug: { type: "string", description: P.slug },
        variable: { type: "string", description: P.variable },
        destination: {
          type: "string",
          enum: names,
          description: `Which strad to deposit into, by name. Omit it for the default, "${config.custody.stradName}".`,
        },
      },
      required: ["handle", "slug", "variable"],
    },
    annotations: {
      title: "Deposit a secret into strad",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    summarize: (a) =>
      `deposit: ${a.handle} → ${a.destination ?? config.custody.stradName}:${a.slug}/${a.variable}`,
    handler: async (a, { grant }) => {
      if (!isDepositSlug(a.slug) || !isDepositVariable(a.variable))
        return text(
          "slug must be a strad slug (lowercase, single dashes) and variable an environment-variable name. Nothing was sent.",
          true,
        );
      const found = resolveDestination(config, a.destination);
      if (!found.ok)
        return text(
          `${found.message} Nothing was sent; the handle is still held.`,
          true,
        );
      const dest = found.destination;
      const value = vault.reveal(a.handle, grant.id);
      if (value === undefined)
        return text(
          `No held handle ${JSON.stringify(a.handle)} on this grant. It expired, ended, or was captured under another grant; list_handles shows which.`,
          true,
        );
      let res: Response;
      try {
        res = await fetch(
          new URL(depositRoutePath(a.slug, a.variable), dest.url),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${depositToken(dest.key)}`,
            },
            body: JSON.stringify({ value }),
            signal: AbortSignal.any([
              grant.signal,
              AbortSignal.timeout(20_000),
            ]),
            redirect: "error",
          },
        );
      } catch (err) {
        return text(
          `Could not reach strad "${dest.name}" at ${new URL(dest.url).origin}: ${(err as Error).message}. The handle is still held; try again.`,
          true,
        );
      }
      const body = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const receipt = res.status === 201 ? parseDepositReceipt(body) : null;
      if (!receipt) {
        const reason = typeof body?.error === "string" ? body.error : "unknown";
        const message =
          typeof body?.message === "string" ? ` — ${body.message}` : "";
        return text(
          `strad "${dest.name}" refused the deposit (${res.status} ${reason})${message}. The handle is still held.`,
          true,
        );
      }
      vault.end(a.handle, "deposited", {
        destination: dest.name,
        path: receipt.path,
        version: receipt.version,
      });
      return json({
        deposited: true,
        destination: dest.name,
        path: receipt.path,
        version: receipt.version,
      });
    },
  });

  return {
    tools: [
      listTabs,
      clickAndCapture,
      captureDownload,
      releaseTab,
      generateKeypair,
      listHandles,
      discardHandle,
      deposit,
    ],
    status: async () => ({ custody: vault.status() }),
    close: () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
      vault.clear();
    },
  };
}
