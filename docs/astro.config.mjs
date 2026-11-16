// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { remarkMermaid } from "./src/plugins/remark-mermaid.mjs";

const DEFAULT_SITE = "https://docs.strad.tadasant.com";

// The canonical public URL — what Astro builds canonical links and the sitemap
// from. Cloudflare Pages sets SITE_URL to the same value in both the production
// and preview environments; the fallback keeps a local build correct. See the
// DNS & domains page for the Pages settings.
//
// Validate the protocol, not merely that it parses. `new URL()` happily accepts
// any scheme, so a typo like "ttps://host" parses — but a non-special scheme has
// no origin (`url.origin` is the string "null"), and Astro builds page URLs from
// the origin. So the build dies much later with a bare `Invalid URL` thrown from
// deep inside page generation, naming neither the variable nor the value. Fail
// here instead, and say what to fix.
const site = process.env.SITE_URL || DEFAULT_SITE;
let protocol;
try {
  protocol = new URL(site).protocol;
} catch {
  protocol = null;
}
if (protocol !== "http:" && protocol !== "https:") {
  throw new Error(
    `SITE_URL is not a usable site URL: ${JSON.stringify(site)}\n` +
      `It must be absolute and http(s), e.g. ${DEFAULT_SITE}\n` +
      `On Cloudflare Pages this lives in Settings → Variables and Secrets, and it ` +
      `must be fixed in BOTH the production and preview environments.`,
  );
}

export default defineConfig({
  site,
  markdown: {
    // Runs before Expressive Code, so ```mermaid fences are swapped for a raw
    // HTML node and never reach the syntax highlighter.
    remarkPlugins: [remarkMermaid],
  },
  integrations: [
    starlight({
      title: "strad",
      description:
        "A self-hosted MCP platform: one endpoint, many MCP servers, selected per request — proxied, namespaced, and access-controlled server-side.",
      tagline: "One endpoint. Many MCP servers. Selected per request.",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: false,
      },
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/tadasant/strad",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/tadasant/strad/edit/main/docs/",
      },
      lastUpdated: true,
      customCss: [
        // Self-hosted variable fonts (bundled + hashed by Astro — no external
        // requests, works offline, CI-safe). Order matters: fonts before theme.
        "@fontsource-variable/ibm-plex-sans/wght.css",
        "@fontsource-variable/ibm-plex-sans/wght-italic.css",
        "@fontsource-variable/jetbrains-mono/wght.css",
        "./src/styles/custom.css",
      ],
      components: {
        // Injects the client-side Mermaid renderer on every page.
        Head: "./src/components/Head.astro",
      },
      sidebar: [
        {
          label: "Introduction",
          items: [
            { label: "What strad is", slug: "intro/what-strad-is" },
            { label: "Architecture", slug: "intro/architecture" },
            { label: "Core concepts", slug: "intro/concepts" },
          ],
        },
        {
          label: "Get started",
          items: [{ label: "Local development", slug: "start/local" }],
        },
        {
          label: "Servers",
          items: [
            { label: "The server-config interface", slug: "servers/interface" },
            { label: "Adding a server", slug: "servers/adding" },
            { label: "Flow-through", slug: "servers/flow-through" },
            { label: "Apps in the console", slug: "servers/apps" },
            {
              label: "Running a server without strad",
              slug: "servers/standalone",
            },
            {
              label: "Confirming a tool before it acts",
              slug: "servers/confirmations",
            },
            {
              label: "Running a local-tunnel host",
              slug: "servers/local-tunnel-host",
            },
            { label: "Running strad-hostd", slug: "servers/hostd" },
            { label: "strad-hostd: the design", slug: "servers/hostd-design" },
            {
              label: "strad-hostd: custody and deposit",
              slug: "servers/hostd-custody",
            },
            { label: "The artifact store", slug: "servers/artifact-store" },
            { label: "Slack attachments", slug: "servers/slack-attachments" },
            { label: "Telegram", slug: "servers/telegram" },
            { label: "WhatsApp", slug: "servers/whatsapp" },
            { label: "MCP Events (draft)", slug: "servers/events" },
            { label: "BILL Spend & Expense", slug: "servers/bill-spend" },
            { label: "LiveOak Bank", slug: "servers/liveoak" },
            { label: "SSH", slug: "servers/ssh" },
            { label: "Airtable", slug: "servers/airtable" },
            { label: "FlightAware AeroAPI", slug: "servers/flightaware" },
            { label: "DigitalOcean", slug: "servers/digitalocean" },
            { label: "Hetzner Cloud", slug: "servers/hetzner" },
            { label: "AWS Device Farm", slug: "servers/aws-device-farm" },
            {
              label: "AWS Device Farm: first-time setup",
              slug: "servers/aws-device-farm-setup",
            },
            { label: "Google Sheets", slug: "servers/google-sheets" },
            { label: "strad fetch", slug: "servers/strad-fetch" },
            { label: "Image diff and SVG tracer", slug: "servers/image-tools" },
            { label: "Nutrition facts", slug: "servers/nutrition-facts" },
            { label: "Grafana", slug: "servers/grafana" },
          ],
        },
        {
          label: "Auth",
          items: [{ label: "Auth architecture", slug: "auth/overview" }],
        },
        {
          label: "Operating strad",
          items: [
            { label: "Deploy model", slug: "operate/deploy-model" },
            { label: "Secrets", slug: "operate/secrets" },
            { label: "Connectors", slug: "operate/connectors" },
            { label: "Runtime config", slug: "operate/runtime-config" },
            {
              label: "Runtime config: the plan",
              slug: "operate/runtime-config-plan",
            },
            { label: "Secrets IAM", slug: "operate/secrets-iam" },
            { label: "State store", slug: "operate/state-store" },
            { label: "Tailnet egress", slug: "operate/tailnet" },
            { label: "Operations & CI", slug: "operate/operations" },
            { label: "Telemetry", slug: "operate/telemetry" },
            { label: "DNS & domains", slug: "operate/dns" },
            {
              label: "The console as an installed app",
              slug: "operate/console-pwa",
            },
          ],
        },
        {
          label: "Reality check",
          items: [{ label: "Known limitations", slug: "limitations" }],
        },
      ],
    }),
  ],
});
