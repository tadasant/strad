// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { remarkMermaid } from "./src/plugins/remark-mermaid.mjs";

// The canonical public URL. Override with SITE_URL at build time (Cloudflare
// Pages preview deployments get a per-branch hostname). Hosting this at
// docs.strad.tadasant.com is a follow-up — see the DNS & domains page.
const site = process.env.SITE_URL || "https://docs.strad.tadasant.com";

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
          label: "Servers",
          items: [
            { label: "The server-config interface", slug: "servers/interface" },
            { label: "Adding a server", slug: "servers/adding" },
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
            { label: "Operations & CI", slug: "operate/operations" },
            { label: "Telemetry", slug: "operate/telemetry" },
            { label: "DNS & domains", slug: "operate/dns" },
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
